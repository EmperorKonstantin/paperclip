import { and, eq, inArray, or, sql } from "drizzle-orm";
import { approvals, heartbeatRuns, issueApprovals, issueGithubHandoffs, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { issueTreeControlService } from "./issue-tree-control.js";

type Operation = { operationId: string; action: "approve" | "merge"; sha: string };
type ExpectedIssue = { statusVersion: number; projectId: string; workspaceId: string | null; assigneeAgentId: string | null };

const unavailable = () => conflict("Implementation changed or already has a GitHub operation reserved.", {
  code: "github_handoff_changed",
});

export const readIssueGithubHandoff = (db: Db, issueId: string) =>
  db.select().from(issueGithubHandoffs).where(eq(issueGithubHandoffs.issueId, issueId))
    .then(([reservation]) => reservation ?? null);

export async function reserveIssueGithubHandoff(
  db: Db, issueId: string, operation: Operation, expected: ExpectedIssue, begin: boolean,
) {
  return db.transaction(async (tx) => {
    // The database triggers guard all relevant writes once begin commits.
    // This table lock orders begin against writers that have already entered.
    await tx.execute(sql`set local lock_timeout = '3s'`);
    await tx.execute(sql`lock table issues, issue_tree_holds, issue_approvals, approvals, heartbeat_runs
      in share row exclusive mode`);
    const [existing] = await tx.select().from(issueGithubHandoffs).where(eq(issueGithubHandoffs.issueId, issueId));
    const now = new Date();
    if (existing?.startedAt || (begin && (!existing || existing.operationId !== operation.operationId ||
        existing.action !== operation.action || existing.sha !== operation.sha || existing.expiresAt <= now)) ||
        (!begin && existing && existing.expiresAt > now)) throw unavailable();

    const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId));
    if (!issue || issue.status !== "done" || issue.statusVersion !== expected.statusVersion ||
        issue.projectId !== expected.projectId || issue.executionWorkspaceId !== expected.workspaceId ||
        issue.assigneeAgentId !== expected.assigneeAgentId || issue.assigneeUserId ||
        issue.checkoutRunId || issue.executionRunId) throw unavailable();

    const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      or(eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.nativeIssueId, issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
      inArray(heartbeatRuns.status, ["queued", "running"]),
    )).limit(1);
    const [approval] = await tx.select({ id: approvals.id }).from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(eq(issueApprovals.issueId, issueId), inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
    if (active || approval || await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(issue.companyId, issueId)) {
      throw unavailable();
    }

    const ancestors = await tx.execute<{ id: string }>(sql`
      with recursive ancestors(id, parent_id) as (
        select id, parent_id from issues where id = ${issueId}
        union
        select parent.id, parent.parent_id from issues parent join ancestors on parent.id = ancestors.parent_id
        where parent.company_id = ${issue.companyId}
      ) select id from ancestors`);
    const values = {
      ...operation, ancestorIds: ancestors.map(({ id }) => id),
      expiresAt: begin ? existing!.expiresAt : new Date(now.getTime() + 90_000),
      startedAt: begin ? now : null,
    };
    const [reservation] = await tx.insert(issueGithubHandoffs).values({ issueId, ...values })
      .onConflictDoUpdate({ target: issueGithubHandoffs.issueId, set: values }).returning();
    return reservation;
  });
}

export async function releaseIssueGithubHandoff(db: Db, issueId: string, operationId: string) {
  await db.delete(issueGithubHandoffs).where(and(
    eq(issueGithubHandoffs.issueId, issueId), eq(issueGithubHandoffs.operationId, operationId),
  ));
}
