import { agents, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { requestGitHubInstallationCredential, type GitHubInstallationScope } from "./github-checkout-broker.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";
import { isLowTrustQuarantined } from "./source-trust.js";
import { assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

const projectBinding = z.object({
  companyId: z.string().uuid(),
  projectId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  agentIds: z.array(z.string().uuid()).min(1),
}).strict();
type Binding = z.infer<typeof projectBinding>;

export function githubAppProjectBinding(companyId: string, projectId: string, env = process.env): Binding | undefined {
  const raw = env.PAPERCLIP_GITHUB_APP_PROJECTS;
  if (!raw) return undefined;
  try {
    const matches = z.array(projectBinding).parse(JSON.parse(raw))
      .filter(candidate => candidate.companyId === companyId && candidate.projectId === projectId);
    if (matches.length > 1) throw new Error("Duplicate project");
    return matches[0];
  } catch {
    throw new Error("GitHub App project configuration is invalid");
  }
}

export async function scopedGitHubAppCredential(db: Db, input: GitHubInstallationScope, env = process.env) {
  if (input.operation === "write") {
    const { assertUntzrGitHubWriteAllowed } = await import("./untzr-execution.js");
    await assertUntzrGitHubWriteAllowed(db, input.companyId, input);
  }
  const binding = githubAppProjectBinding(input.companyId, input.projectId, env);
  if (!binding) return undefined;
  if (input.workspaceId !== binding.workspaceId || input.repositoryId !== binding.repositoryId
    || (input.agentId && !binding.agentIds.includes(input.agentId))) {
    throw forbidden("GitHub App credentials require the approved project workspace and agent");
  }
  const [workspace] = await db.select({ repoUrl: projectWorkspaces.repoUrl, metadata: projectWorkspaces.metadata })
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, binding.companyId), eq(projectWorkspaces.projectId, binding.projectId),
      eq(projectWorkspaces.id, binding.workspaceId)));
  if (!workspace?.repoUrl || (workspace.metadata?.githubRepositoryId ?? workspace.metadata?.untzrRepository) !== binding.repositoryId
    || normalizeProjectRepositoryUrl(workspace.repoUrl).fullName.toLowerCase() !== input.repository.toLowerCase()) {
    throw forbidden("GitHub App credentials require the approved repository");
  }
  return requestGitHubInstallationCredential({
    endpoint: env.PAPERCLIP_GITHUB_APP_CREDENTIAL_URL ?? "",
    serviceToken: env.PAPERCLIP_GITHUB_APP_SERVICE_TOKEN ?? "",
  }, input);
}

export async function githubAppTaskCheckout(db: Db, companyId: string, issueId: string,
  agentId: string | null | undefined, remoteUrl: string, env = process.env) {
  const [issue] = await db.select({
    companyId: issues.companyId, projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId, assigneeAgentId: issues.assigneeAgentId,
    untzrExecution: issues.untzrExecution, executionPolicy: issues.executionPolicy, sourceTrust: issues.sourceTrust, executionWorkspaceId: issues.executionWorkspaceId,
  }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (issue?.untzrExecution && !issue.projectId) {
    throw forbidden("Checkout is outside the approved Untzr repository scope");
  }
  if (!issue?.projectId) return undefined;
  const binding = githubAppProjectBinding(companyId, issue.projectId, env);
  if (!binding && issue.untzrExecution) throw forbidden("The Untzr GitHub binding is unavailable");
  if (!binding) return undefined;
  if (!agentId || agentId !== issue.assigneeAgentId || !binding.agentIds.includes(agentId)
    || isLowTrustQuarantined(issue.sourceTrust)) throw forbidden("GitHub App credentials require the assigned agent");
  const [agent] = await db.select({ companyId: agents.companyId, permissions: agents.permissions,
    adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  const [project] = await db.select({ companyId: projects.companyId, visibility: projects.visibility,
    archivedAt: projects.archivedAt, executionWorkspacePolicy: projects.executionWorkspacePolicy }).from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, issue.projectId)));
  if (!agent || !project || project.archivedAt || project.visibility !== "private"
    || resolveCoreTrustPreset({ companyId, agent, project, issue }).kind !== "standard") {
    throw forbidden("GitHub App credentials require an authorized private project task");
  }
  if (issue.untzrExecution) {
    const { assertUntzrExecution, untzrExecutionSchema } = await import("./untzr-execution.js");
    const execution = untzrExecutionSchema.parse(issue.untzrExecution);
    if (normalizeProjectRepositoryUrl(remoteUrl).fullName.toLowerCase() !== execution.repository) {
      throw forbidden("Checkout is outside the approved Untzr repository scope");
    }
    await assertUntzrExecution(db, execution, {
      companyId, projectId: issue.projectId, workspaceId: issue.projectWorkspaceId,
      agentId, adapter: agent.adapterType, config: agent.adapterConfig,
    }, env);
  }
  await assertTaskWorkspaceExecutionAccess(db, {
    type: "agent", source: "agent_key", companyId, agentId,
  }, companyId, { issueId, workspaceId: issue.executionWorkspaceId, projectWorkspaceId: binding.workspaceId });
  return scopedGitHubAppCredential(db, {
    operation: "checkout", companyId, projectId: binding.projectId, workspaceId: binding.workspaceId,
    repositoryId: binding.repositoryId, repository: normalizeProjectRepositoryUrl(remoteUrl).fullName,
    agentId, issueId,
  }, env);
}
