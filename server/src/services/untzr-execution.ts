import { createHash, timingSafeEqual } from "node:crypto";
import { authUsers, companyMemberships, heartbeatRuns, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { agentHarnessType, isUuidLike, type AiConnectionBinding } from "@paperclipai/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";
import { githubAppProjectBinding } from "./github-app-credentials.js";
import { assertTaskWorkspaceSourceProjectAccess } from "./task-workspace-access.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";

const uuid = z.string().uuid();
export const untzrProviderSchema = z.enum(["openai", "anthropic"]);
export const untzrSubjectSchema = z.string().min(1).max(200);
const scopeSchema = z.object({
  subject: untzrSubjectSchema,
  userId: z.string().min(1),
  companyId: uuid,
  projectId: uuid,
  workspaceId: uuid,
  repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).transform(value => value.toLowerCase()),
  ref: z.string().min(1).max(255),
  agentIds: z.array(uuid).min(1),
}).strict();

export const untzrPublicationSchema = z.object({
  taskBranch: z.string().regex(/^untzr\/[a-f0-9]{16}$/),
  startingCommit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

export const untzrExecutionSchema = scopeSchema.omit({ agentIds: true }).extend({
  stageAgents: z.record(uuid, z.object({ adapter: z.literal("paperclip_runner"), harness: z.enum(["codex_local", "claude_local"]) }).strict()),
  provider: untzrProviderSchema,
  method: z.enum(["api_key", "subscription"]),
  connectionId: uuid,
  grantId: uuid,
  authorizationGeneration: uuid.optional(),
  publication: untzrPublicationSchema.extend({
    predecessorIssueId: uuid.optional(),
    implementerAgentId: uuid.optional(),
    nextCycle: untzrPublicationSchema.optional(),
  }).optional(),
}).strict();
export type UntzrExecution = z.infer<typeof untzrExecutionSchema>;

export function authenticateUntzr(token: string | undefined, env = process.env) {
  const expected = env.PAPERCLIP_UNTZR_INTEGRATION_KEY_SHA256;
  return Boolean(expected && /^[a-f0-9]{64}$/.test(expected) && token &&
    timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(expected, "hex")));
}

export async function resolveUntzrScope(db: Db, subject: string, companyId: string, projectId: string, env = process.env) {
  const raw = env.PAPERCLIP_UNTZR_SCOPES;
  const scopes = raw ? z.array(scopeSchema).parse(JSON.parse(raw)) : [];
  const matches = scopes.filter(scope => scope.subject === subject &&
    scope.companyId === companyId && scope.projectId === projectId);
  const [scope] = matches;
  if (!scope || matches.length !== 1 || scopes.some(other =>
    other.companyId === companyId && (other.subject === subject) !== (other.userId === scope.userId))) {
    throw forbidden("Untzr needs a verified personal mapping for this project");
  }

  const [membership] = await db.select({ id: companyMemberships.id }).from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, scope.userId), eq(companyMemberships.status, "active"),
      inArray(companyMemberships.membershipRole, ["owner", "admin", "member"])));
  if (!membership) throw forbidden("The mapped Untzr user must be an active company member");
  await assertTaskWorkspaceSourceProjectAccess(db,
    { type: "board", source: "session", userId: scope.userId, isInstanceAdmin: false }, companyId, projectId);
  const [workspace] = await db.select({ source: projectWorkspaces, project: projects }).from(projectWorkspaces)
    .innerJoin(projects, and(eq(projects.id, projectWorkspaces.projectId), eq(projects.companyId, companyId)))
    .where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, projectId),
      eq(projectWorkspaces.id, scope.workspaceId)));
  const binding = githubAppProjectBinding(companyId, projectId, env);
  const source = workspace?.source;
  if (!source?.repoUrl || workspace.project.archivedAt || workspace.project.visibility !== "private" ||
      binding?.workspaceId !== scope.workspaceId || binding.repositoryId !== scope.repositoryId ||
      !scope.agentIds.every(id => binding.agentIds.includes(id)) ||
      (source.metadata?.githubRepositoryId ?? source.metadata?.untzrRepository) !== scope.repositoryId ||
      normalizeProjectRepositoryUrl(source.repoUrl).fullName.toLowerCase() !== scope.repository ||
      (source.repoRef ?? source.defaultRef) !== scope.ref) {
    throw forbidden("The approved Untzr repository scope is unavailable");
  }
  return scope;
}

export function untzrAiBinding(execution: UntzrExecution): AiConnectionBinding {
  return { mode: "responsible_user", provider: execution.provider, method: execution.method };
}

export async function assertUntzrExecution(db: Db, execution: UntzrExecution, input: {
  companyId: string;
  projectId: string | null;
  workspaceId: string | null;
  agentId: string;
  adapter: string;
  config: Record<string, unknown>;
}, env = process.env) {
  if (execution.companyId !== input.companyId || execution.projectId !== input.projectId ||
      execution.workspaceId !== input.workspaceId) {
    throw forbidden("The task is outside its approved Untzr project and repository");
  }
  const scope = await resolveUntzrScope(db, execution.subject, execution.companyId, execution.projectId, env);
  const stage = execution.stageAgents[input.agentId];
  if (scope.userId !== execution.userId || scope.repository !== execution.repository ||
      scope.repositoryId !== execution.repositoryId || scope.ref !== execution.ref ||
      !scope.agentIds.includes(input.agentId) || !stage || stage.adapter !== input.adapter ||
      stage.harness !== agentHarnessType(input.adapter, input.config) ||
      stage.harness !== (execution.provider === "openai" ? "codex_local" : "claude_local") ||
      input.config.homeMode === "preconfigured" ||
      (execution.method === "subscription" &&
        (execution.provider !== "openai" || env.PAPERCLIP_UNTZR_CODEX_LOGIN !== "enabled"))) {
    throw forbidden("The task's approved Untzr user, agent, or authentication method is unavailable");
  }
  const selection = await aiConnectionService(db).select({
    companyId: execution.companyId, userId: execution.userId, agentId: input.agentId,
    adapterType: input.adapter, model: input.config.model, runnerProvider: input.config.provider,
    acpxAgent: input.config.acpxAgent, binding: untzrAiBinding(execution), pinnedPersonalGrant: execution,
    allowUninstalledPersonal: true,
  });
  return selection.attribution;
}

export async function readUntzrIssueExecution(db: Db, companyId: string, issueId: string) {
  const [issue] = await db.select({ execution: issues.untzrExecution, projectId: issues.projectId,
    workspaceId: issues.projectWorkspaceId }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (!issue?.execution) return null;
  return { ...issue, execution: untzrExecutionSchema.parse(issue.execution) };
}

export const untzrGitHubWriteDenied = "GitHub write credentials are reserved for the trusted Untzr publisher";

export async function assertUntzrGitHubWriteAllowed(db: Db, companyId: string, binding: {
  issueId?: string | null;
  runId?: string | null;
  agentId?: string | null;
}, options: { allowCheckoutForIssue?: boolean } = {}) {
  const candidates: unknown[] = [binding.issueId];
  let checkoutUserId: string | null = null;
  if (binding.runId) {
    const [run] = await db.select({
      issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
      contextIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
      contextTaskId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'taskId'`,
      agentId: heartbeatRuns.agentId, responsibleUserId: heartbeatRuns.responsibleUserId,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, binding.runId)));
    if (!run || (binding.agentId && run.agentId !== binding.agentId)) {
      throw forbidden("GitHub credentials require a matching run");
    }
    const runIssues = [run.issueId, run.nativeIssueId, run.contextIssueId, run.contextTaskId];
    const primaryIssueId = runIssues.find(id => id != null);
    if (options.allowCheckoutForIssue && binding.issueId && primaryIssueId === binding.issueId &&
        runIssues.every(id => id == null || id === binding.issueId)) checkoutUserId = run.responsibleUserId;
    candidates.push(...runIssues);
  }
  const issueIds = [...new Set(candidates.filter((id): id is string => typeof id === "string" && isUuidLike(id)))];
  if (!issueIds.length) return;
  const rows = await db.select({ execution: issues.untzrExecution }).from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
  for (const { execution } of rows) {
    if (execution && (!checkoutUserId || untzrExecutionSchema.parse(execution).userId !== checkoutUserId)) {
      throw forbidden(untzrGitHubWriteDenied);
    }
  }
}
