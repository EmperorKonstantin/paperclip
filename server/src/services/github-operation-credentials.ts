import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunCompletionIdentity, captureRunIdentity, type RunIdentityContext } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { githubAppProjectBinding, scopedGitHubAppCredential } from "./github-app-credentials.js";
import { GitHubCheckoutBrokerError, type GitHubBrokerFailure } from "./github-checkout-broker.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";
import { assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated";
  login?: string;
  reason?: string;
  brokerFailure?: GitHubBrokerFailure;
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};

type GitHubCredentialRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "nativeIssueId" | "responsibleUserId" | "contextSnapshot">;

/** A raw GitHub token cannot enforce the low-trust read-only tool boundary. */
async function allowsGitHubCredentialExport(
  db: Db,
  run: GitHubCredentialRun,
) {
  const issueId =
    run.contextSnapshot?.issueId ??
    run.contextSnapshot?.taskId ??
    run.nativeIssueId;
  if (
    issueId !== undefined &&
    issueId !== null &&
    (typeof issueId !== "string" || !isUuidLike(issueId))
  )
    return false;
  const [agent] = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)),
    );
  if (!agent) return false;
  const [issue] =
    typeof issueId === "string"
      ? await db
          .select({
            companyId: issues.companyId,
            projectId: issues.projectId,
            executionPolicy: issues.executionPolicy,
            sourceTrust: issues.sourceTrust,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
      : [];
  if (issueId !== undefined && issueId !== null && !issue) return false;
  if (isLowTrustQuarantined(issue?.sourceTrust)) return false;
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" || !isUuidLike(projectId))
  )
    return false;
  const [project] =
    typeof projectId === "string"
      ? await db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.companyId, run.companyId),
            ),
          )
      : [];
  if (projectId !== undefined && projectId !== null && !project) return false;
  return (
    resolveCoreTrustPreset({
      companyId: run.companyId,
      agent,
      project,
      issue,
      run: {
        companyId: run.companyId,
        executionPolicy: run.contextSnapshot?.executionPolicy,
      },
    }).kind === "standard"
  );
}

async function saveGitHubSummary(
  db: Db,
  context: RunIdentityContext,
  summary: GitHubCredentialSummary,
) {
  if (isDeepStrictEqual(context.github, JSON.parse(JSON.stringify(summary)))) return;
  await db
    .update(runIdentityContexts)
    .set({ github: summary })
    .where(eq(runIdentityContexts.id, context.id));
}

/** No company secrets or ambient credentials are consulted by this path. */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
  },
) {
  const { run, context } = await captureRunIdentity(db, input, { readScope: "github_credentials" });
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  return resolveCapturedGitHubCredentials(db, run, context);
}

export async function resolveGitHubCompletionCredentials(
  db: Db,
  input: { companyId: string; issueId: string; runId: string },
) {
  const [source] = await db.select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.nativeIssueId, input.issueId))).limit(1);
  if (!source) throw forbidden("GitHub completion requires the bound task run");
  const { run, context } = await captureRunCompletionIdentity(db, { ...input, agentId: source.agentId });
  if (!run.activeIdentityContextId && !context) return { status: "absent" as const, env: {} as Record<string, string> };
  if (!context || context.companyId !== run.companyId || context.status !== "accepted") {
    throw forbidden("GitHub completion requires the run's accepted identity");
  }
  return resolveCapturedGitHubCredentials(db, run, context);
}

async function resolveCapturedGitHubCredentials(db: Db, run: GitHubCredentialRun, context: RunIdentityContext) {
  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  if (!(await allowsGitHubCredentialExport(db, run))) {
    summary = {
      status: "unavailable",
      reason:
        "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
    };
    await saveGitHubSummary(db, context, summary);
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      env,
    };
  }
  try {
    const appToken = process.env.PAPERCLIP_GITHUB_APP_PROJECTS
      ? await resolveGitHubAppRunToken(db, run, context)
      : undefined;
    if (appToken) {
      summary = { status: "available", source: "dedicated", authenticationMode: "managed" };
      await saveGitHubSummary(db, context, summary);
      return {
        identityContextId: context.id, revision: context.revision, ...summary,
        env: buildGitAuthInvocation({ token: appToken, source: "managed_connection", secretName: null }).env,
      };
    }
    const resolved = await resolveManagedGitHubCredential(
      db,
      secretService(db),
      run.companyId,
      {
        agentId: run.agentId,
        heartbeatRunId: run.id,
        allowStandingDelegation: false,
        responsibleUserId:
          context?.cause === "company_default"
            ? null
            : (context?.responsibleUserId ?? null),
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
    if (resolved.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
    }
  } catch (error) {
    if (error instanceof GitHubCheckoutBrokerError) {
      summary = {
        status: "unavailable",
        reason: error.message,
        brokerFailure: { code: error.code, httpStatus: error.httpStatus },
      };
    } else {
      // Provider and secret errors may contain sensitive response bodies.
      summary = { status: "unavailable", reason: "GitHub credentials are temporarily unavailable" };
    }
  }
  if (context) await saveGitHubSummary(db, context, summary);
  return {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
  };
}

async function resolveGitHubAppRunToken(db: Db, run: GitHubCredentialRun, context: RunIdentityContext) {
  const { companyId, agentId, id: runId } = run;
  const input = { companyId, agentId, runId };
  const issueId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
  if (typeof issueId !== "string" || !isUuidLike(issueId)) return undefined;
  const [issue] = await db.select({ projectId: issues.projectId, assigneeAgentId: issues.assigneeAgentId,
    executionWorkspaceId: issues.executionWorkspaceId }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId)));
  if (!issue?.projectId) return undefined;
  const binding = githubAppProjectBinding(input.companyId, issue.projectId);
  if (!binding) return undefined;
  const [project] = await db.select({ visibility: projects.visibility, archivedAt: projects.archivedAt }).from(projects)
    .where(and(eq(projects.companyId, input.companyId), eq(projects.id, binding.projectId)));
  if (issue.assigneeAgentId !== input.agentId || !project || project.archivedAt || project.visibility !== "private") {
    throw forbidden("GitHub App credentials require the assigned agent on an active private project");
  }
  const [workspace] = await db.select({ repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, issue.projectId),
      eq(projectWorkspaces.id, binding.workspaceId)));
  if (!workspace?.repoUrl) throw forbidden("GitHub App credentials require the approved workspace");
  await assertTaskWorkspaceExecutionAccess(db, {
    type: "agent", source: "agent_jwt", companyId: input.companyId, agentId: input.agentId, runId: input.runId,
    onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId,
  }, input.companyId, { issueId, workspaceId: issue.executionWorkspaceId, projectWorkspaceId: binding.workspaceId });
  const token = await scopedGitHubAppCredential(db, {
    operation: "write", ...input, issueId, projectId: issue.projectId, workspaceId: binding.workspaceId,
    repositoryId: binding.repositoryId, repository: normalizeProjectRepositoryUrl(workspace.repoUrl).fullName,
  });
  const latest = await captureRunIdentity(db, input, { readScope: "github_credentials" });
  if (latest.context?.id !== context.id || latest.context.revision !== context.revision
    || !(await allowsGitHubCredentialExport(db, latest.run))) {
    throw forbidden("GitHub App authorization changed during credential acquisition");
  }
  return token;
}
