import { heartbeatRunEvents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { unprocessable } from "../errors.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

export const UNATTENDED_INPUT_REQUIRED = "This unattended task requires human input.";
const EVENT_TYPE = "unattended.input_required";

export async function isUnattendedIssue(db: Db, companyId: string, issueId: string) {
  const [issue] = await db.select({ policy: issues.executionPolicy }).from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  return issue?.policy?.unattended === true;
}

export async function rejectUnattendedInteraction(
  db: Db,
  issue: { id: string; companyId: string },
  actor: { agentId?: string | null; runId?: string | null },
) {
  if (!(await isUnattendedIssue(db, issue.companyId, issue.id))) return;
  if (actor.runId) {
    const [run] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, issue.companyId),
      actor.agentId ? eq(heartbeatRuns.agentId, actor.agentId) : undefined,
      eq(heartbeatRuns.issueId, issue.id),
      eq(heartbeatRuns.status, "running"),
    ));
    if (run) await appendHeartbeatRunEvent(db, {
      companyId: issue.companyId, runId: actor.runId, agentId: run.agentId,
      eventType: EVENT_TYPE, level: "error", message: UNATTENDED_INPUT_REQUIRED,
    });
  }
  throw unprocessable(UNATTENDED_INPUT_REQUIRED, { code: "unattended_input_required" });
}

export async function assertNoUnattendedInputRequest(db: Db, companyId: string, runId: string) {
  const [event] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.companyId, companyId),
    eq(heartbeatRunEvents.eventType, EVENT_TYPE),
  )).limit(1);
  if (event) throw new Error(UNATTENDED_INPUT_REQUIRED);
}
