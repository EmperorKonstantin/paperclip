import { createHash, createHmac } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { adapterAuthSessions, agents, connectionGrants, heartbeatRuns, issues, toolConnections, type Db } from "@paperclipai/db";
import { agentHarnessType, aiConnectionMetadataSchema, createAiConnectionSchema } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { validateAiApiKey } from "../services/ai-api-key-test.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { heartbeatService } from "../services/heartbeat.js";
import { documentService } from "../services/documents.js";
import type { StorageService } from "../storage/types.js";
import { issueService } from "../services/issues.js";
import { localAiLoginService } from "../services/local-ai-login.js";
import { supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
import { assertUntzrExecution, authenticateUntzr, resolveUntzrScope, untzrExecutionSchema,
  untzrProviderSchema, untzrPublicationSchema, untzrSubjectSchema } from "../services/untzr-execution.js";

const uuid = z.string().uuid();
const context = z.object({ subject: untzrSubjectSchema, companyId: uuid, projectId: uuid }).strict();
const connection = context.extend({ provider: untzrProviderSchema, connectionId: uuid.optional() });
const apiKey = connection.extend({
  apiKey: z.string().trim().min(1).max(32768), provisioningId: uuid.optional(),
}).refine(body => !body.connectionId || !body.provisioningId, {
  message: "New provisioning cannot update an existing connection",
});
const provisioningMarker = z.object({ projectId: uuid, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
const login = context.extend({ connectionId: uuid.optional(), attempt: uuid.optional() });
const launch = context.extend({
  provider: untzrProviderSchema, connectionId: uuid, grantId: uuid,
  agentId: uuid, requestId: z.string().min(1).max(160),
  title: z.string().trim().min(1).max(240), description: z.string().max(100_000).optional(),
  taskBranch: untzrPublicationSchema.shape.taskBranch.optional(),
  startingCommit: untzrPublicationSchema.shape.startingCommit.optional(),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/).optional(),
  workspaceId: uuid.optional(),
  predecessorIssueId: uuid.optional(),
  followUp: z.literal("true").optional(),
}).refine(body => (body.taskBranch === undefined) === (body.startingCommit === undefined) &&
    (!body.taskBranch || Boolean(body.repositoryId && body.workspaceId)) &&
    (!body.predecessorIssueId || Boolean(body.taskBranch)) && (!body.followUp || Boolean(body.predecessorIssueId)), {
  message: "Publisher launches require the approved repository, workspace, branch and starting commit. Follow-ups also require a predecessor.",
});

const releaseRequest = context.extend({
  issueId: uuid,
  taskBranch: untzrPublicationSchema.shape.taskBranch,
  nextTaskBranch: untzrPublicationSchema.shape.taskBranch,
  releasedCommit: untzrPublicationSchema.shape.startingCommit,
}).refine(body => body.taskBranch !== body.nextTaskBranch, {
  message: "An Untzr follow-up requires a distinct approved task branch",
});

const sourceRequest = context.extend({
  issueId: uuid, runId: uuid, revisionId: uuid,
  startingCommit: untzrPublicationSchema.shape.startingCommit,
});
const sourceReport = z.object({
  attachmentId: uuid,
  startingCommit: sourceRequest.shape.startingCommit,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const maxSourceBytes = 1024 * 1024;

export function untzrIntegrationRoutes(db: Db, storage: StorageService, options: Parameters<typeof supportsLocalAiLogin>[0]) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const service = aiConnectionService(db);
  const local = localAiLoginService(db);
  const key = (req: { get(name: string): string | undefined }) => req.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]{32,1024})$/)?.[1];
  router.use((req, res, next) => {
    if (!process.env.PAPERCLIP_UNTZR_INTEGRATION_KEY_SHA256) return next(notFound());
    if (!authenticateUntzr(key(req))) return next(unauthorized());
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/status", validate(context), async (req, res) => {
    const { companyId, userId } = await resolveScope(context.parse(req.body));
    const accounts = await service.list(companyId, userId);
    res.json({ codexSignInAvailable: codexEnabled(), connections: accounts
      .filter(row => row.ownership === "personal" && row.ownerUserId === userId && !row.routing &&
        (row.provider === "openai" || (row.provider === "anthropic" && row.method === "api_key")))
      .map(row => ({ connectionId: row.id, grantId: row.grantId, provider: row.provider,
        method: row.method, status: row.status })) });
  });

  router.post("/api-key", validate(apiKey), async (req, res) => {
    const body = apiKey.parse(req.body);
    const { companyId, userId } = await resolveScope(body);
    const input = createAiConnectionSchema.parse({ ownership: "personal", name: `Untzr ${body.provider}`,
      method: "api_key", provider: body.provider, apiKey: body.apiKey, connectionId: body.connectionId });
    const startedAt = new Date();
    if (!body.provisioningId) {
      await validateAiApiKey(body.provider, body.apiKey);
      res.status(201).json(await service.save(companyId, userId, input, body.apiKey, undefined, startedAt));
      return;
    }
    const id = body.provisioningId;
    const integrationKey = key(req);
    if (!integrationKey) throw unauthorized();
    const fingerprint = createHmac("sha256", integrationKey)
      .update(JSON.stringify([body.subject, companyId, body.projectId, body.provider, id, body.apiKey]))
      .digest("hex");
    async function replay() {
      const [saved] = await db.select({
        config: toolConnections.config, enabled: toolConnections.enabled, connectionStatus: toolConnections.status,
        companyId: toolConnections.companyId, purpose: toolConnections.connectionPurpose,
        grantId: connectionGrants.id, grantStatus: connectionGrants.status, revokedAt: connectionGrants.revokedAt,
        providerTenant: connectionGrants.providerTenant,
      }).from(toolConnections).leftJoin(connectionGrants, and(eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.connectionId, toolConnections.id), eq(connectionGrants.kind, "user"),
        eq(connectionGrants.subjectUserId, userId))).where(eq(toolConnections.id, id));
      if (!saved) return null;
      if (saved.companyId !== companyId || saved.purpose !== "ai" || !saved.grantId)
        throw conflict("This Untzr provisioning request cannot be replayed");
      const marker = provisioningMarker.safeParse(saved.config.untzrApiKeyProvisioning);
      const metadata = aiConnectionMetadataSchema.safeParse(saved.config.ai);
      if (!marker.success || marker.data.projectId !== body.projectId || marker.data.fingerprint !== fingerprint ||
          !metadata.success || metadata.data.provider !== body.provider || metadata.data.method !== "api_key" ||
          !saved.enabled || saved.connectionStatus !== "active" || saved.grantStatus !== "active" || saved.revokedAt) {
        throw conflict("This Untzr provisioning request cannot be replayed");
      }
      return { connectionId: id, grantId: saved.grantId,
        authorizationGeneration: saved.providerTenant?.authorizationGeneration ?? saved.grantId };
    }
    let binding = await replay();
    if (!binding) {
      await validateAiApiKey(body.provider, body.apiKey);
      try {
        const saved = await service.save(companyId, userId, input, body.apiKey, undefined, startedAt,
          undefined, undefined, { id, projectId: body.projectId, fingerprint });
        binding = { ...saved, authorizationGeneration: saved.grantId };
      } catch (error) {
        // A concurrently accepted request may win the globally unique connection ID.
        binding = await replay();
        if (!binding) throw error;
      }
    }
    res.status(201).json(binding);
  });

  router.post("/disconnect", validate(connection.required({ connectionId: true })), async (req, res) => {
    const body = connection.required({ connectionId: true }).parse(req.body);
    const { companyId, userId } = await resolveScope(body);
    await db.transaction(async tx => {
      const [account] = await tx.select({ connection: toolConnections, grant: connectionGrants }).from(toolConnections)
        .innerJoin(connectionGrants, and(eq(connectionGrants.companyId, companyId),
          eq(connectionGrants.connectionId, toolConnections.id), eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, userId)))
        .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, body.connectionId),
          eq(toolConnections.connectionPurpose, "ai"))).for("update");
      const metadata = aiConnectionMetadataSchema.safeParse(account?.connection.config.ai);
      if (!account || !metadata.success || metadata.data.provider !== body.provider || metadata.data.routing)
        throw notFound("Personal connection not found");
      if (account.grant.status === "revoked") return;
      const revokedAt = new Date();
      await tx.update(connectionGrants).set({ status: "revoked", revokedAt, updatedAt: revokedAt })
        .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, account.grant.id)));
      await logActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: userId,
        action: "untzr.ai_connection_disconnected", entityType: "connection_grant", entityId: account.grant.id });
    });
    res.json({ disconnected: true });
  });

  function codexEnabled() {
    return process.env.PAPERCLIP_UNTZR_CODEX_LOGIN === "enabled" && supportsLocalAiLogin(options);
  }
  function requireCodex() {
    if (!codexEnabled()) throw unprocessable("Codex sign-in is unavailable for this deployment. Use an OpenAI API key.");
  }
  function resolveScope(body: z.infer<typeof context>) {
    return resolveUntzrScope(db, body.subject, body.companyId, body.projectId);
  }
  function loginScope(body: z.infer<typeof login>, userId: string) {
    return createHash("sha256").update(JSON.stringify([
      body.subject, body.companyId, body.projectId, userId, body.connectionId ?? null,
    ])).digest("hex");
  }
  const loginIntent = (connectionId?: string) => ({
    provider: "openai" as const, method: "subscription" as const, name: "Untzr Codex",
    ownership: "personal" as const, agentIds: [], allAgents: false, connectionId,
  });
  router.post("/codex/start", validate(login.omit({ attempt: true })), async (req, res) => {
    requireCodex();
    const body = login.omit({ attempt: true }).parse(req.body);
    const { companyId, userId } = await resolveScope(body);
    const attempt = await local.start(companyId, userId, loginIntent(body.connectionId),
      false, undefined, loginScope(body, userId));
    res.status(201).json({ attempt: attempt.sessionId, expiresAt: attempt.expiresAt });
  });
  const codexAttempt = login.required({ attempt: true });
  const codexCommand = (command: "status" | "complete" | "cancel") => async (req: Request, res: Response) => {
    requireCodex();
    const body = codexAttempt.parse(req.body);
    const { companyId, userId } = await resolveScope(body);
    const id = body.attempt;
    const [session] = await db.select({ id: adapterAuthSessions.id }).from(adapterAuthSessions)
      .where(and(eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId), eq(adapterAuthSessions.integrationScope, loginScope(body, userId))));
    if (!session) throw forbidden("The Codex sign-in attempt is outside this request's scope");
    const intent = loginIntent(body.connectionId);
    const scope = loginScope(body, userId);
    if (command === "complete") {
      res.status(201).json(await local.complete(companyId, userId, id, intent, undefined, scope));
    } else if (command === "cancel") {
      await local.cancel(companyId, userId, id, undefined, scope);
      res.json({ cancelled: true });
    } else {
      const result = await local.check(companyId, userId, intent, id, scope);
      if (result.status !== "sign_in_required") {
        res.json({ status: result.status });
        return;
      }
      const authorizationUrl = result.authorizationUrl && new URL(result.authorizationUrl);
      if (authorizationUrl && (authorizationUrl.origin !== "https://auth.openai.com" ||
          authorizationUrl.username || authorizationUrl.password)) throw unprocessable("Invalid Codex sign-in destination");
      res.json({ status: result.status, authorizationUrl: authorizationUrl || undefined, code: result.code });
    }
  };
  router.post("/codex/status", validate(codexAttempt), codexCommand("status"));
  router.post("/codex/complete", validate(codexAttempt), codexCommand("complete"));
  router.post("/codex/cancel", validate(codexAttempt), codexCommand("cancel"));

  router.post("/release", validate(releaseRequest), async (req, res) => {
    const body = releaseRequest.parse(req.body);
    const scope = await resolveScope(body);
    // The trusted Untzr publisher attests the independently verified GitHub release.
    // A completed stage and its checkout SHA alone grant no cross-cycle authority.
    const nextCycle = { taskBranch: body.nextTaskBranch, startingCommit: body.releasedCommit };
    await db.transaction(async tx => {
      const [issue] = await tx.select({ status: issues.status, untzrExecution: issues.untzrExecution })
        .from(issues).where(and(eq(issues.companyId, scope.companyId), eq(issues.projectId, scope.projectId),
          eq(issues.projectWorkspaceId, scope.workspaceId), eq(issues.id, body.issueId))).for("update");
      const parsed = untzrExecutionSchema.safeParse(issue?.untzrExecution);
      const publication = parsed.success ? parsed.data.publication : undefined;
      if (issue?.status !== "done" || !parsed.success || !publication?.predecessorIssueId ||
          parsed.data.subject !== scope.subject || parsed.data.userId !== scope.userId ||
          parsed.data.repositoryId !== scope.repositoryId || parsed.data.repository !== scope.repository ||
          parsed.data.ref !== scope.ref || publication.taskBranch !== body.taskBranch) {
        throw forbidden("The released stage is outside the approved Untzr scope");
      }
      if (publication.nextCycle) {
        if (publication.nextCycle.taskBranch !== nextCycle.taskBranch ||
            publication.nextCycle.startingCommit !== nextCycle.startingCommit)
          throw conflict("This Untzr release already authorizes another follow-up");
        return;
      }
      await tx.update(issues).set({
        untzrExecution: { ...parsed.data, publication: { ...publication, nextCycle } },
      }).where(and(eq(issues.companyId, scope.companyId), eq(issues.id, body.issueId)));
    });
    res.json({ issueId: body.issueId, ...nextCycle });
  });

  router.post("/launch", validate(launch), async (req, res) => {
    const body = launch.parse(req.body);
    const { agentIds, ...scope } = await resolveScope(body);
    const companyId = scope.companyId;
    if ((body.repositoryId && body.repositoryId !== scope.repositoryId) ||
        (body.workspaceId && body.workspaceId !== scope.workspaceId))
      throw forbidden("The approved Untzr launch repository or workspace changed");
    if (!agentIds.includes(body.agentId)) throw forbidden("The selected agent is outside the approved Untzr scope");
    const approvedAgents = await db.select().from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
    const harness = body.provider === "openai" ? "codex_local" : "claude_local";
    const stageAgents = approvedAgents.filter(agent => agent.adapterType === "paperclip_runner" &&
      agentHarnessType(agent.adapterType, agent.adapterConfig) === harness);
    if (!stageAgents.some(agent => agent.id === body.agentId))
      throw forbidden("The selected agent cannot run this Untzr provider");
    const predecessor = body.predecessorIssueId ? await db.select({
      status: issues.status, untzrExecution: issues.untzrExecution,
    }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.projectId, scope.projectId),
      eq(issues.projectWorkspaceId, scope.workspaceId), eq(issues.id, body.predecessorIssueId)))
      .then(rows => rows[0]) : null;
    const prior = predecessor?.untzrExecution ? untzrExecutionSchema.parse(predecessor.untzrExecution) : null;
    const priorPublication = prior?.publication;
    const branchMatches = body.followUp
      ? priorPublication?.nextCycle?.taskBranch === body.taskBranch &&
        priorPublication?.nextCycle?.startingCommit === body.startingCommit &&
        priorPublication?.implementerAgentId === body.agentId
      : priorPublication?.taskBranch === body.taskBranch;
    if (body.predecessorIssueId && (predecessor?.status !== "done" || !prior?.publication ||
        prior.subject !== scope.subject || prior.userId !== scope.userId ||
        prior.repositoryId !== scope.repositoryId || prior.repository !== scope.repository ||
        prior.provider !== body.provider || prior.connectionId !== body.connectionId || prior.grantId !== body.grantId ||
        !branchMatches || !prior.stageAgents[body.agentId])) {
      throw forbidden("The stage does not match the approved Untzr predecessor and grant");
    }
    const [grant] = await db.select({ config: toolConnections.config, providerTenant: connectionGrants.providerTenant }).from(toolConnections)
      .innerJoin(connectionGrants, and(eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.connectionId, toolConnections.id), eq(connectionGrants.id, body.grantId),
        eq(connectionGrants.subjectUserId, scope.userId), eq(connectionGrants.kind, "user")))
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, body.connectionId),
        eq(toolConnections.connectionPurpose, "ai")));
    const metadata = aiConnectionMetadataSchema.safeParse(grant?.config.ai);
    if (!metadata.success || metadata.data.provider !== body.provider ||
        (prior && (prior.authorizationGeneration !== grant?.providerTenant?.authorizationGeneration ||
          prior.method !== metadata.data.method))) {
      throw forbidden("Choose an approved personal AI connection");
    }
    const parsed = untzrExecutionSchema.safeParse({ ...scope, provider: body.provider, method: metadata.data.method,
      connectionId: body.connectionId, grantId: body.grantId, authorizationGeneration: grant?.providerTenant?.authorizationGeneration,
      publication: body.taskBranch ? {
        taskBranch: body.taskBranch, startingCommit: body.startingCommit, predecessorIssueId: body.predecessorIssueId,
        implementerAgentId: prior ? priorPublication?.implementerAgentId : body.agentId,
      } : undefined,
      stageAgents: Object.fromEntries(stageAgents.filter(agent => !prior || prior.stageAgents[agent.id]).map(agent => [
        agent.id, { adapter: agent.adapterType, harness: agentHarnessType(agent.adapterType, agent.adapterConfig) },
      ])), });
    if (!parsed.success) throw forbidden("The approved Untzr agents or connection method are incompatible");
    const execution = parsed.data;
    for (const agent of stageAgents.filter(agent => execution.stageAgents[agent.id])) {
      await assertUntzrExecution(db, execution, { ...scope, agentId: agent.id, adapter: agent.adapterType, config: agent.adapterConfig });
    }
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const handoffId = `untzr:${digest([scope.subject, scope.projectId, body.requestId])}`;
    const fingerprint = digest(body);
    const issue = await db.transaction(async tx => {
      let reused = false;
      const row = await issueService(db).create(companyId, {
        projectId: scope.projectId, projectWorkspaceId: scope.workspaceId, assigneeAgentId: body.agentId,
        responsibleUserId: scope.userId, trustExplicitResponsibleUserId: true, createdByUserId: scope.userId,
        title: body.title, description: body.description, status: "todo", untzrExecution: execution,
        workspaceSelection: { kind: "configured_source", projectWorkspaceId: scope.workspaceId, mode: "managed_isolated" },
        workspaceSelectionActor: { type: "board", source: "session", userId: scope.userId, isInstanceAdmin: false },
        idempotencyKey: handoffId, originFingerprint: fingerprint, onDeduplicated: () => { reused = true; },
        assertCanReuseIssue: async item => {
          if (item.originFingerprint !== fingerprint || !item.untzrExecution ||
              item.untzrExecution.grantId !== body.grantId ||
              item.untzrExecution.authorizationGeneration !== execution.authorizationGeneration) throw conflict("This Untzr request ID already identifies another handoff");
        },
      }, tx);
      if (!reused) await logActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: scope.userId,
        action: "untzr.handoff_created", entityType: "issue", entityId: row.id,
        details: { projectId: scope.projectId, repository: scope.repository, connectionId: body.connectionId } });
      return row;
    });
    await heartbeat.wakeup(body.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id }, idempotencyKey: handoffId,
      requestedByActorType: "user", requestedByActorId: scope.userId });
    const pinned = untzrExecutionSchema.parse(issue.untzrExecution);
    res.status(202).json({ issueId: issue.id, identifier: issue.identifier,
      authorizationGeneration: pinned.authorizationGeneration ?? pinned.grantId });
  });
  router.post("/source", validate(sourceRequest), async (req, res) => {
    const body = sourceRequest.parse(req.body);
    const scope = await resolveScope(body);
    const [issue] = await db.select({
      id: issues.id, projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId,
      status: issues.status, untzrExecution: issues.untzrExecution,
    }).from(issues).where(and(eq(issues.companyId, scope.companyId), eq(issues.projectId, scope.projectId),
      eq(issues.id, body.issueId)));
    if (!issue ||
        issue.status === "cancelled" || !issue.untzrExecution) throw notFound("Untzr source issue not found");
    const execution = untzrExecutionSchema.parse(issue.untzrExecution);
    if (execution.subject !== scope.subject || execution.userId !== scope.userId)
      throw forbidden("Untzr source belongs to another user");
    if (execution.publication && execution.publication.startingCommit !== body.startingCommit)
      throw conflict("Untzr source is outside the approved starting commit");

    const [source] = await db.select({
      runId: heartbeatRuns.id, issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
      agentId: agents.id, adapter: agents.adapterType, config: agents.adapterConfig,
    }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.companyId, scope.companyId), eq(agents.id, heartbeatRuns.agentId)))
      .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, body.runId),
        eq(heartbeatRuns.status, "succeeded"), eq(heartbeatRuns.responsibleUserId, scope.userId)));
    if (!source || (source.issueId ?? source.nativeIssueId) !== issue.id ||
        (source.issueId && source.nativeIssueId && source.nativeIssueId !== issue.id))
      throw forbidden("Untzr source requires the successful task run");
    await assertUntzrExecution(db, execution, {
      companyId: scope.companyId, projectId: issue.projectId, workspaceId: issue.projectWorkspaceId,
      agentId: source.agentId, adapter: source.adapter, config: source.config,
    });

    const revision = await documentService(db).getIssueDocumentRevision(issue.id, "untzr-source", body.revisionId, { requireSignedUntzrSource: true });
    if (!revision || revision.companyId !== scope.companyId || revision.createdByRunId !== source.runId ||
        revision.createdByAgentId !== source.agentId || revision.createdByUserId)
      throw forbidden("Untzr source requires a report from the authenticated task run");
    let report: z.infer<typeof sourceReport>;
    try {
      report = sourceReport.parse(JSON.parse(revision.body));
    } catch {
      throw unprocessable("Invalid Untzr source report");
    }
    if (report.startingCommit !== body.startingCommit) throw conflict("Untzr source starting commit changed");

    const attachment = await issueService(db).getAttachmentById(report.attachmentId, { requireSignedUntzrSource: true });
    if (!attachment || attachment.companyId !== scope.companyId || attachment.issueId !== issue.id ||
        attachment.originatingRunId !== source.runId ||
        attachment.createdByAgentId !== source.agentId || attachment.createdByUserId !== null ||
        attachment.sha256 !== report.sha256 || attachment.byteSize < 1 || attachment.byteSize > maxSourceBytes)
      throw forbidden("Untzr source attachment does not match the bounded report");

    const signal = AbortSignal.timeout(10_000);
    const { stream } = await storage.getObject(scope.companyId, attachment.objectKey, { signal });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > attachment.byteSize) throw conflict("Untzr source attachment size changed");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, size);
    if (size !== attachment.byteSize || createHash("sha256").update(bytes).digest("hex") !== report.sha256)
      throw conflict("Untzr source attachment integrity check failed");
    res.json({ issueId: issue.id, runId: source.runId, revisionId: revision.id,
      repositoryId: execution.repositoryId, repository: execution.repository,
      authorizationGeneration: execution.authorizationGeneration ?? execution.grantId,
      ...report, sourceBase64: bytes.toString("base64") });
  });
  return router;
}
