import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issueTreeHolds, issues, projects } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { buildInitialIssueMonitorFields, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("guarded promotion route/service contract", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-status-version-route-");
    db = createDb(temporary.connectionString, { maxConnections: 4 });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Guarded promotion", issuePrefix: `V${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Paused executor", role: "engineer", adapterType: "process", status: "paused" }).returning();
    const policy = normalizeIssueExecutionPolicy({
      maxReviewRounds: 4,
      stages: [{ type: "review", participants: [{ type: "user", userId: "reviewer" }] }],
      monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" },
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "Promote backlog with retained monitor", status: "backlog", assigneeAgentId: agent!.id,
      executionPolicy: policy as Record<string, unknown> | null,
      ...buildInitialIssueMonitorFields({ policy, status: "in_progress", assigneeAgentId: agent!.id }),
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", companyIds: [companyId], isInstanceAdmin: true, source: "local_implicit" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return { app, issue: issue! };
  }

  it("promotes through the real service and clears a retained monitor without accepting public execution fields", async () => {
    const { app, issue } = await fixture();
    const response = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: issue.statusVersion });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await issueService(db).getById(issue.id);
    const { monitor: _monitor, ...retainedPolicy } = issue.executionPolicy!;
    expect(saved).toMatchObject({
      status: "todo", statusVersion: issue.statusVersion + 1,
      executionPolicy: retainedPolicy,
      executionState: { monitor: { status: "cleared", clearReason: "invalid_status" } },
      monitorNextCheckAt: null, monitorWakeRequestedAt: null,
    });
    expect(saved?.executionPolicy).not.toHaveProperty("monitor");
  });

  it("derives cleanup from the locked policy after a concurrent policy-only edit", async () => {
    const { app, issue } = await fixture();
    const replacementPolicy = normalizeIssueExecutionPolicy({
      maxReviewRounds: 9,
      stages: [{ type: "approval", participants: [{ type: "user", userId: "new-reviewer" }] }],
      monitor: { nextCheckAt: "2099-02-01T00:00:00.000Z" },
    });
    let release!: () => void;
    let ready!: () => void;
    const lockReady = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const editDb = createDb(temporary.connectionString, { maxConnections: 1 });
    const probeDb = createDb(temporary.connectionString, { maxConnections: 1 });
    let holderPid = 0;
    const edit = editDb.transaction(async (tx) => {
      await tx.update(issues).set({ executionPolicy: replacementPolicy as Record<string, unknown> | null }).where(eq(issues.id, issue.id));
      holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
      ready();
      await gate;
    });
    await lockReady;
    const promotion = request(app).patch(`/api/issues/${issue.id}`)
      .send({ status: "todo", expectedStatusVersion: issue.statusVersion }).then((response) => response);
    let waiting = false;
    try {
      const deadline = Date.now() + 5_000;
      while (!waiting && Date.now() < deadline) {
        const [result] = await probeDb.execute<{ waiting: boolean }>(sql`
          select exists (select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and ${holderPid} = any(pg_blocking_pids(pid))) as waiting
        `);
        waiting = result!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await edit;
    }
    const response = await promotion;
    expect(waiting, "promotion must wait at the service row lock").toBe(true);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await issueService(db).getById(issue.id);
    const { monitor: _monitor, ...retainedPolicy } = replacementPolicy!;
    expect(saved?.executionPolicy).toEqual(retainedPolicy);
    expect(saved?.status).toBe("todo");
    expect(saved?.executionState).toMatchObject({ monitor: { status: "cleared" } });
  });

  it.each([{ executionState: null }, { executionPolicy: null }, { title: "Mixed mutation" }])("rejects a public mixed mutation %j", async (extra) => {
    const { app, issue } = await fixture();
    const response = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: issue.statusVersion, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved).toEqual(issue);
  });

  it("rejects derived review reassignment instead of broadening a guarded promotion", async () => {
    const { app, issue } = await fixture();
    const policy = normalizeIssueExecutionPolicy(issue.executionPolicy)!;
    const stage = policy.stages[0]!;
    const [before] = await db.update(issues).set({
      executionState: {
        status: "pending", currentStageId: stage.id, currentStageIndex: 0, currentStageType: stage.type,
        currentParticipant: { type: "user", userId: "removed-reviewer", agentId: null },
        returnAssignee: { type: "agent", agentId: issue.assigneeAgentId, userId: null },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, issue.id)).returning();
    const response = await request(app).patch(`/api/issues/${issue.id}`)
      .send({ status: "todo", expectedStatusVersion: before!.statusVersion });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved).toEqual(before);
  });

  it("clears the current assignee from a completed issue", async () => {
    const { app, issue } = await fixture();
    const [completed] = await db.update(issues).set({
      status: "done", executionPolicy: null, executionState: null,
      monitorNextCheckAt: null, monitorWakeRequestedAt: null,
    }).where(eq(issues.id, issue.id)).returning();
    const response = await request(app).patch(`/api/issues/${issue.id}`).send({
      assigneeAgentId: null,
      expectedStatusVersion: completed!.statusVersion,
      expectedCompletedAssignee: completed!.assigneeAgentId,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await issueService(db).getById(issue.id)).toMatchObject({
      status: "done", assigneeAgentId: null, statusVersion: completed!.statusVersion + 1,
    });
  });

  it("preserves an assignee when reopening wins the transactional lock", async () => {
    const { app, issue } = await fixture();
    const [completed] = await db.update(issues).set({
      status: "done", executionPolicy: null, executionState: null,
      monitorNextCheckAt: null, monitorWakeRequestedAt: null,
    }).where(eq(issues.id, issue.id)).returning();
    const editDb = createDb(temporary.connectionString, { maxConnections: 1 });
    const probeDb = createDb(temporary.connectionString, { maxConnections: 1 });
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lockReady = new Promise<number>((resolve) => { ready = resolve; });
    const reopen = editDb.transaction(async (tx) => {
      await tx.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issue.id));
      ready((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid);
      await gate;
    });
    const holderPid = await lockReady;
    const handoff = request(app).patch(`/api/issues/${issue.id}`).send({
      assigneeAgentId: null,
      expectedStatusVersion: completed!.statusVersion,
      expectedCompletedAssignee: completed!.assigneeAgentId,
    }).then((response) => response);
    let waiting = false;
    try {
      const deadline = Date.now() + 5_000;
      while (!waiting && Date.now() < deadline) {
        const [row] = await probeDb.execute<{ waiting: boolean }>(sql`
          select exists (select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and ${holderPid} = any(pg_blocking_pids(pid))) as waiting
        `);
        waiting = row!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await reopen;
    }
    const response = await handoff;
    expect(waiting).toBe(true);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(await issueService(db).getById(issue.id)).toMatchObject({
      status: "in_progress", assigneeAgentId: completed!.assigneeAgentId,
    });
  });

  async function stalledImplementation(status: "queued" | "running" = "running") {
    const { app, issue } = await fixture();
    const [completed] = await db.update(issues).set({
      status: "done", executionPolicy: null, executionState: null,
      monitorNextCheckAt: null, monitorWakeRequestedAt: null,
    }).where(eq(issues.id, issue.id)).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: issue.companyId, agentId: issue.assigneeAgentId!, scopeKind: "issue", issueId: issue.id, status,
    }).returning();
    return { app, issue: completed!, run: run!, body: { cancellationRequestId: randomUUID(), completedImplementation: {
      issueId: issue.id, statusVersion: completed!.statusVersion, assigneeAgentId: issue.assigneeAgentId,
      runAgentId: issue.assigneeAgentId,
    } } };
  }

  it("stops only the bound run and preserves completion and assignment", async () => {
    const { app, issue, run, body } = await stalledImplementation("queued");
    const response = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel-completed-implementation`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.status).toBe("cancelled");
    expect(await issueService(db).getById(issue.id)).toMatchObject({
      status: "done", statusVersion: issue.statusVersion, assigneeAgentId: issue.assigneeAgentId,
    });
  });

  it("does not stop a run when owner hold insertion wins the cancellation claim", async () => {
    const { app, issue, run, body } = await stalledImplementation();
    const holdDb = createDb(temporary.connectionString, { maxConnections: 1 });
    const probeDb = createDb(temporary.connectionString, { maxConnections: 1 });
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<number>(resolve => { ready = resolve; });
    const hold = holdDb.transaction(async tx => {
      await tx.insert(issueTreeHolds).values({
        companyId: issue.companyId, rootIssueId: issue.id, mode: "pause", createdByActorType: "user",
      });
      ready((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid);
      await gate;
    });
    const ownerPid = await held;
    const stopping = request(app).post(`/api/heartbeat-runs/${run.id}/cancel-completed-implementation`)
      .send(body).then(response => response);
    let waiting = false;
    try {
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        const [row] = await probeDb.execute<{ waiting: boolean }>(sql`
          select exists (select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and ${ownerPid} = any(pg_blocking_pids(pid))) as waiting
        `);
        waiting = row!.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await hold;
    }
    const response = await stopping;
    expect(waiting).toBe(true);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({ code: "implementation_stop_conflict" });
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved).toEqual(run);
  });

  it("does not claim Stop after the implementation reopens", async () => {
    const { app, issue, run, body } = await stalledImplementation();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issue.id));
    const response = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel-completed-implementation`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved).toEqual(run);
  });

  async function workflowStage() {
    const { app, issue } = await fixture();
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: issue.companyId, mode: "isolated_workspace", strategyType: "git_worktree", name: "Untzr checkout",
    }).returning();
    const [source] = await db.update(issues).set({
      status: "done", assigneeAgentId: null, executionWorkspaceId: workspace!.id,
      executionPolicy: null, executionState: null, monitorNextCheckAt: null, monitorWakeRequestedAt: null,
    }).where(eq(issues.id, issue.id)).returning();
    const [stage] = await db.insert(issues).values({
      companyId: issue.companyId, title: "Review", status: "backlog", executionWorkspaceId: workspace!.id,
    }).returning();
    const body = { assigneeAgentId: issue.assigneeAgentId, status: "todo", expectedImplementation: {
      issueId: source!.id, statusVersion: source!.statusVersion, workspaceId: workspace!.id,
    } };
    return { app, source: source!, stage: stage!, body };
  }

  it("activates an unassigned workflow stage only after the implementation releases the same checkout", async () => {
    const { app, stage, body } = await workflowStage();
    const response = await request(app).patch(`/api/issues/${stage.id}/activate-workflow-stage`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await issueService(db).getById(stage.id)).toMatchObject({
      status: "todo", assigneeAgentId: body.assigneeAgentId, executionWorkspaceId: stage.executionWorkspaceId,
    });
  });

  it("preserves the backlog stage when the implementation acquires a hold at the activation boundary", async () => {
    const { app, source, stage, body } = await workflowStage();
    await db.insert(issueTreeHolds).values({
      companyId: source.companyId, rootIssueId: source.id, mode: "pause", createdByActorType: "user",
    });
    const response = await request(app).patch(`/api/issues/${stage.id}/activate-workflow-stage`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({ code: "workflow_stage_handoff_changed" });
    expect(await issueService(db).getById(stage.id)).toMatchObject({status: "backlog", assigneeAgentId: null});
  });

  it.each(["approve", "merge"] as const)("orders %s reservations against owner holds and issue reopen", async (action) => {
    const { app, source } = await workflowStage();
    const [project] = await db.insert(projects).values({ companyId: source.companyId, name: "Handoff project" }).returning();
    const [parent] = await db.insert(issues).values({ companyId: source.companyId, title: "Ancestor" }).returning();
    await db.update(issues).set({ projectId: project!.id, parentId: parent!.id }).where(eq(issues.id, source.id));
    const path = `/api/issues/${source.id}/github-handoff`;
    const body = { operationId: randomUUID(), action, sha: "a".repeat(40), statusVersion: source.statusVersion,
      projectId: project!.id, workspaceId: source.executionWorkspaceId, assigneeAgentId: null };
    const hold = { companyId: source.companyId, rootIssueId: parent!.id, mode: "pause", createdByActorType: "user" };
    const prepared = await request(app).post(path).send({ ...body, begin: false });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const [firstHold] = await db.insert(issueTreeHolds).values(hold).returning();
    expect((await request(app).post(path).send({ ...body, begin: true })).status).toBe(409);
    await db.delete(issueTreeHolds).where(eq(issueTreeHolds.id, firstHold!.id));
    const started = await request(app).post(path).send({ ...body, begin: true });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.startedAt).toBeTruthy();
    await expect(db.insert(issueTreeHolds).values(hold)).rejects.toMatchObject({ cause: { code: "P0214" } });
    await expect(db.update(issues).set({ status: "todo" }).where(eq(issues.id, source.id)))
      .rejects.toMatchObject({ cause: { code: "P0214" } });
    expect((await request(app).delete(`${path}/${body.operationId}`)).status).toBe(204);
    await db.insert(issueTreeHolds).values(hold);
  });

  it("rejects stale promotion before clearing its monitor", async () => {
    const { app, issue } = await fixture();
    const response = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: issue.statusVersion + 1 });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({ code: "issue_status_version_changed" });
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved).toEqual(issue);
  });
});
