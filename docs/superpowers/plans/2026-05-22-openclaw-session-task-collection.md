# OpenClaw Session Task Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenClaw Runtime / Agent / Task collection use session and trajectory evidence as the product source of truth, including `taskType` and tool call evidence, while keeping `Device -> Runtime -> Agent -> Task` as the only product entity chain.

**Architecture:** The `lorume` CLI adapter reads OpenClaw health/status/config for Runtime and Agent, then reads OpenClaw session index, session JSONL, trajectory JSONL, and DingTalk state to build `conversation` and `scheduled` Tasks. `openclaw tasks list` is not used to create product Tasks; it can only contribute diagnostics. Task status is normalized by the adapter while OpenClaw raw status remains in `Task.raw.openclaw`.

**Tech Stack:** Node.js ESM scripts, TypeScript runtime model, Vitest, Postgres migrations/repository tests, backend API-only E2E.

---

## Source Documents

- Product spec: `docs/product/runtime-task-probe.md`
- Acceptance spec: `docs/product/runtime-task-acceptance-spec.md`
- CLI contract: `docs/product/cli-device-capability-spec.md`
- Current model: `src/runtime/runtime-model.ts`
- Current adapter: `scripts/lorume-runtime-adapters.mjs`
- Current backend persistence: `src/server/postgres-store.ts`, `db/migrations/0011_device_state_tasks.sql`
- Real-device profiling output, not committed: `/tmp/lorume-openclaw-profile-20260521-231020`

## Files To Modify

- Modify `docs/product/runtime-task-probe.md`: already updated with OpenClaw session/trajectory source rules, `taskType`, `toolCalls`, raw status preservation, and agent mapping constraints.
- Modify `docs/product/runtime-task-acceptance-spec.md`: add acceptance criteria for `conversation` / `scheduled`, tool call persistence, and `openclaw tasks list` not generating product Tasks.
- Modify `src/runtime/runtime-model.ts`: add `Task.taskType`, `Task.source.kind`, `channel.kind="webchat"`, `creator.externalId`, `Task.toolCalls`, and `Task.raw.openclaw`.
- Modify `src/runtime/runtime-model.test.ts`: prove new fields are preserved and unsupported fields still do not return.
- Modify `scripts/lorume-runtime-adapters.mjs`: replace product Task creation from `openclaw tasks list` with session/trajectory based mapping; keep `tasks list` only as diagnostics if retained.
- Modify `src/cli/lorume-cli.test.ts`: add deterministic OpenClaw fixture files for conversation, scheduled, tool call, status mapping, and agent mismatch cases.
- Modify `db/migrations/`: add a migration for indexed `tasks.task_type`; do not create `tool_calls` or `evidence` tables.
- Modify `src/server/postgres-store.ts`: persist `task_type`, keep full Task JSON in `raw`, and support optional task type filter only if the API already has a clean place to pass it.
- Modify `src/server/postgres-store.test.ts` and `src/server/runtime-http-api-postgres.test.ts`: verify storage/query behavior.
- Modify `src/runtime/runtime-work-query-api.ts` and tests only if type parsing rejects the new Task fields.
- Modify fixtures under `fixtures/runtime/` only with synthetic data; do not copy real names, tokens, commands, or business logs into committed fixtures.

## Data Contract

Target Task shape for this plan:

```ts
export interface Task {
  id: string;
  agentId: string;
  taskType: "conversation" | "scheduled";
  title: string;
  description?: string;
  status: TaskStatus;
  source?: { kind?: "openclaw"; externalId?: string };
  channel?: {
    kind: "dingtalk" | "webchat" | "telegram" | "slack" | "other";
    name?: string;
    externalId?: string;
  };
  conversation?: {
    title?: string;
    externalId?: string;
    lastActivityAt?: string;
  };
  assignee?: { name?: string };
  creator?: { name?: string; externalId?: string };
  toolCalls?: Array<{
    id: string;
    name: string;
    status: "done" | "failed" | "unknown";
    arguments?: unknown;
    resultPreview?: string;
    error?: string;
  }>;
  raw?: {
    openclaw?: {
      status?: string;
      statusSource?: "session" | "trajectory" | "tool" | "tasks_list";
      sessionId?: string;
      sessionKey?: string;
      messageId?: string;
      trajectoryRunId?: string;
    };
  };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
}
```

Rules:

- `agentId` must map to a collected Agent id. If not, skip the Task and write a diagnostic warning.
- `toolCalls.arguments` is stored unredacted in DB `tasks.raw` for backend troubleshooting. Logs, docs, committed fixtures, and future frontend APIs must handle sensitive content separately.
- `matchedTrajectoryRunIds` and `trajectoryMatchStrategy` are implementation diagnostics. Do not expose them as product Task fields.
- `openclaw tasks list` is not a product Task source in P0.
- P0 creates no `ToolCall`, `Evidence`, `Conversation`, `Execution`, or `Run` entity/table.

## Task 1: Lock Product Acceptance

**Files:**
- Modify: `docs/product/runtime-task-acceptance-spec.md`
- Verify: `npm run check:repo`

- [ ] **Step 1: Update acceptance spec**

Add explicit acceptance bullets:

```md
OpenClaw Product Task sources:

- `conversation` Tasks come from OpenClaw session JSONL, trajectory JSONL, sessions index, and DingTalk state.
- `scheduled` Tasks come from cron session JSONL and trajectory JSONL.
- `openclaw tasks list` must not create product Tasks in P0.
- Task `agentId` must reference a collected Agent id.
- Tool calls are stored as Task embedded evidence, not as a first-class product entity.
- Adapter maps raw OpenClaw statuses to Lorume `Task.status` and preserves raw status under `raw.openclaw.status`.
```

- [ ] **Step 2: Run repo docs check**

Run:

```sh
npm run check:repo
```

Expected: PASS. If Markdown link checks fail, fix only the broken links introduced by this task.

- [ ] **Step 3: Commit docs**

Run:

```sh
git add docs/product/runtime-task-probe.md docs/product/runtime-task-acceptance-spec.md
git commit -m "docs(runtime): define OpenClaw task collection rules"
```

## Task 2: Extend Runtime Task Model

**Files:**
- Modify: `src/runtime/runtime-model.ts`
- Modify: `src/runtime/runtime-model.test.ts`
- Verify: `npm run check:runtime`

- [ ] **Step 1: Write failing model tests**

Add tests covering preservation of new fields:

```ts
it("preserves OpenClaw task type, tool calls, creator external id, and raw status", () => {
  const snapshot = createDeviceStateSnapshot({
    observedAt: "2026-05-22T00:00:00.000Z",
    device: { id: "fixture-device", hostname: "fixture.local", os: "darwin", collectionStatus: "online" },
    runtimes: [],
    agents: [],
    tasks: [{
      id: "fixture-device:runtime:openclaw:agent:main:task:msg-1",
      agentId: "fixture-device:runtime:openclaw:agent:main",
      taskType: "conversation",
      title: "查 Seedance 指标",
      status: "success",
      source: { kind: "openclaw", externalId: "msg-1" },
      channel: { kind: "dingtalk", name: "日常工作提醒助手", externalId: "cid-example" },
      conversation: { title: "日常工作提醒助手", externalId: "cid-example" },
      creator: { name: "张良", externalId: "100854680226406967" },
      toolCalls: [{
        id: "exec-1",
        name: "bash",
        status: "failed",
        arguments: { command: "python3 scripts/query_logs.py --query test" },
        resultPreview: "partial failures",
        error: "Column cannot be resolved",
      }],
      raw: {
        openclaw: {
          status: "done",
          statusSource: "session",
          sessionId: "session-1",
          sessionKey: "agent:main:dingtalk:group:cid-example",
          messageId: "msg-1",
          trajectoryRunId: "run-1",
        },
      },
    }],
  });

  expect(snapshot.tasks[0]).toMatchObject({
    taskType: "conversation",
    status: "done",
    source: { kind: "openclaw", externalId: "msg-1" },
    creator: { name: "张良", externalId: "100854680226406967" },
    toolCalls: [expect.objectContaining({ id: "exec-1", status: "failed" })],
    raw: { openclaw: expect.objectContaining({ status: "done", messageId: "msg-1" }) },
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run:

```sh
npm run check:runtime
```

Expected: FAIL because `taskType`, `source.kind`, `creator.externalId`, `toolCalls`, and `raw` are currently dropped.

- [ ] **Step 3: Implement minimal model changes**

Update `Task`, `cleanTask`, `cleanTaskChannel`, `normalizeTaskStatus`, and helper cleaners:

```ts
export const TASK_TYPES = ["conversation", "scheduled"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export function normalizeTaskType(value: string | undefined): TaskType {
  return value === "scheduled" ? "scheduled" : "conversation";
}
```

Keep `normalizeTaskStatus` mapping:

```ts
if (normalized === "succeeded" || normalized === "completed" || normalized === "done" || normalized === "success") return "done";
if (normalized === "failed" || normalized === "error" || normalized === "timed_out" || normalized === "timeout" || normalized === "lost") return "failed";
if (normalized === "cancelled" || normalized === "canceled" || normalized === "interrupted") return "cancelled";
```

- [ ] **Step 4: Run runtime tests**

Run:

```sh
npm run check:runtime
```

Expected: PASS.

- [ ] **Step 5: Commit model changes**

Run:

```sh
git add src/runtime/runtime-model.ts src/runtime/runtime-model.test.ts
git commit -m "feat(runtime): extend task model for OpenClaw evidence"
```

## Task 3: Add Task Type Persistence Without New Entities

**Files:**
- Create: `db/migrations/0013_task_type.sql`
- Modify: `src/server/postgres-store.ts`
- Modify: `src/server/postgres-store.test.ts`
- Modify: `src/server/runtime-http-api-postgres.test.ts`
- Verify: `npm run check:db && npm run check:backend`

- [ ] **Step 1: Write failing repository test**

In `src/server/postgres-store.test.ts`, add an assertion that a persisted Task retains `taskType`, `toolCalls`, and `raw.openclaw` after `listRuntimeTasks()`:

```ts
expect(tasks.items[0]).toMatchObject({
  taskType: "conversation",
  toolCalls: [expect.objectContaining({ id: "exec-1", name: "bash" })],
  raw: { openclaw: expect.objectContaining({ status: "done" }) },
});
```

- [ ] **Step 2: Run backend DB tests to confirm failure**

Run:

```sh
npm run check:db
```

Expected: FAIL until model persistence keeps the new fields.

- [ ] **Step 3: Add migration**

Create `db/migrations/0013_task_type.sql`:

```sql
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'conversation';

CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type);
```

Do not create `tool_calls`, `evidence`, `conversations`, `executions`, or `runs` tables.

- [ ] **Step 4: Persist task_type**

Update `upsertTask()` in `src/server/postgres-store.ts`:

```ts
task.taskType,
```

and add `task_type` to the insert/update SQL. Keep full Task JSON in `raw`:

```ts
toJson(task)
```

- [ ] **Step 5: Run DB and backend tests**

Run:

```sh
npm run check:db
npm run check:backend
```

Expected: PASS.

- [ ] **Step 6: Commit persistence changes**

Run:

```sh
git add db/migrations/0013_task_type.sql src/server/postgres-store.ts src/server/postgres-store.test.ts src/server/runtime-http-api-postgres.test.ts
git commit -m "feat(backend): persist runtime task type"
```

## Task 4: Replace OpenClaw Product Task Source

**Files:**
- Modify: `scripts/lorume-runtime-adapters.mjs`
- Modify: `src/cli/lorume-cli.test.ts`
- Verify: `npm run check:cli`

- [ ] **Step 1: Write failing CLI test for conversation Task**

Use a synthetic OpenClaw home in `src/cli/lorume-cli.test.ts`:

```ts
writeFileSync(path.join(sessionDir, "sessions.json"), JSON.stringify({
  "agent:main:dingtalk:group:cid-example": {
    sessionId: "session-1",
    sessionKey: "agent:main:dingtalk:group:cid-example",
    sessionFile: path.join(sessionDir, "session-1.jsonl"),
    origin: { label: "日常工作提醒助手 - 张良" },
    deliveryContext: { channel: "dingtalk", to: "cid-example" },
    status: "done",
  },
}, null, 2));

writeFileSync(path.join(sessionDir, "session-1.jsonl"), [
  JSON.stringify({
    type: "message",
    id: "msg-1",
    timestamp: "2026-05-21T09:10:33.514Z",
    message: { role: "user", content: "查 Seedance 指标" },
  }),
  JSON.stringify({
    type: "message",
    id: "call-1",
    parentId: "msg-1",
    timestamp: "2026-05-21T09:10:33.516Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "exec-1", name: "bash", arguments: { command: "query" } }] },
  }),
  JSON.stringify({
    type: "message",
    id: "result-1",
    parentId: "call-1",
    timestamp: "2026-05-21T09:10:33.518Z",
    message: { role: "toolResult", toolCallId: "exec-1", toolName: "bash", isError: true, content: [{ type: "toolResult", content: "Column cannot be resolved" }] },
  }),
].join("\n"));
```

Assert:

```ts
expect(output.tasks).toContainEqual(expect.objectContaining({
  taskType: "conversation",
  agentId: "test-device:runtime:openclaw:agent:main",
  title: "查 Seedance 指标",
  creator: { name: "张良" },
  conversation: expect.objectContaining({ title: "日常工作提醒助手", externalId: "cid-example" }),
  toolCalls: [expect.objectContaining({ id: "exec-1", status: "failed" })],
  raw: { openclaw: expect.objectContaining({ messageId: "msg-1", sessionId: "session-1" }) },
}));
```

- [ ] **Step 2: Write failing CLI test proving `tasks list` does not create product Tasks**

Mock `openclaw tasks list --json` to return one task while no session/trajectory files exist:

```ts
expect(output.tasks).toEqual([]);
expect(output.diagnostics.warnings).toContainEqual(expect.stringContaining("OpenClaw tasks list is diagnostics-only"));
```

- [ ] **Step 3: Implement session and trajectory readers**

In `scripts/lorume-runtime-adapters.mjs`, introduce focused helpers:

```js
function readOpenClawSessionIndex() {}
function readOpenClawSessionEvents(sessionFile) {}
function readOpenClawConversationTaskCandidates({ sessionIndex, dingtalkState }) {}
function readOpenClawScheduledTaskCandidates({ trajectoryRuns }) {}
function extractOpenClawToolCalls(events) {}
function normalizeOpenClawRawStatus(value) {}
function createOpenClawTaskFromCandidate(candidate) {}
```

Keep each helper single-purpose. Reuse existing `readOpenClawDingTalkState()`, `readOpenClawTrajectoryRuns()`, `openClawAgentIdFromSessionKey()`, `messageTitle()`, and `makeProductTaskId()` where they still fit.

- [ ] **Step 4: Enforce Agent mapping**

Before pushing a Task, resolve the OpenClaw agent external id and verify it is in the collected `agentIds` set:

```js
if (!knownAgentIds.includes(agentExternalId)) {
  warnings.push(`Skipped OpenClaw task ${externalId}: agent ${agentExternalId} was not collected.`);
  continue;
}
```

- [ ] **Step 5: Run CLI tests**

Run:

```sh
npm run check:cli
```

Expected: PASS.

- [ ] **Step 6: Commit adapter changes**

Run:

```sh
git add scripts/lorume-runtime-adapters.mjs src/cli/lorume-cli.test.ts
git commit -m "feat(runtime): collect OpenClaw tasks from sessions"
```

## Task 5: Backend API Contract

**Files:**
- Modify: `src/runtime/runtime-work-query-api.ts`
- Modify: `src/runtime/runtime-work-query-api.test.ts`
- Modify: `src/server/runtime-http-api-postgres.test.ts`
- Verify: `npm run check:runtime && npm run check:backend`

- [ ] **Step 1: Write query parsing test**

Ensure backend task query responses preserve `taskType` and do not require frontend to interpret raw OpenClaw payload:

```ts
expect(page.tasks[0]).toMatchObject({
  taskType: "conversation",
  toolCalls: [expect.objectContaining({ name: "bash" })],
});
expect(page.tasks[0]).not.toHaveProperty("runtimeId");
expect(page.tasks[0]).not.toHaveProperty("lastRun");
```

- [ ] **Step 2: Run tests to confirm current failure if fields are dropped**

Run:

```sh
npm run check:runtime
```

Expected: FAIL if query normalization drops new fields.

- [ ] **Step 3: Update parser only as needed**

If `createDeviceStateSnapshot()` already preserves fields after Task 2, no extra parser code is needed. If tests fail, update only the narrow normalization path that drops `taskType`, `toolCalls`, or `raw`.

- [ ] **Step 4: Run backend/runtime checks**

Run:

```sh
npm run check:runtime
npm run check:backend
```

Expected: PASS.

- [ ] **Step 5: Commit API contract changes**

Run:

```sh
git add src/runtime/runtime-work-query-api.ts src/runtime/runtime-work-query-api.test.ts src/server/runtime-http-api-postgres.test.ts
git commit -m "test(runtime): preserve OpenClaw task evidence in queries"
```

## Task 6: E2E Collector Ingestion

**Files:**
- Modify: `e2e/runtime-backend-api.spec.ts`
- Modify: `scripts/dev-backend-e2e.ts` only if fixture setup needs the new synthetic OpenClaw files.
- Verify: `npm run check:backend:e2e`

- [ ] **Step 1: Add synthetic collector-process fixture**

The E2E must run against local isolated backend/Postgres only. Add synthetic OpenClaw session files to the temporary home used by the real collector process. Do not connect to `gezilinll-claw`, production, or deployed domains.

- [ ] **Step 2: Assert ingestion and query**

Add assertions:

```ts
expect(tasksBody.items).toContainEqual(expect.objectContaining({
  taskType: "conversation",
  title: expect.stringContaining("Seedance"),
  toolCalls: [expect.objectContaining({ id: "exec-1", status: "failed" })],
  raw: { openclaw: expect.objectContaining({ status: "done" }) },
}));
```

- [ ] **Step 3: Run backend E2E**

Run:

```sh
npm run check:backend:e2e
```

Expected: PASS. The test must create and clean local test data only.

- [ ] **Step 4: Commit E2E changes**

Run:

```sh
git add e2e/runtime-backend-api.spec.ts scripts/dev-backend-e2e.ts
git commit -m "test(runtime): cover OpenClaw session task ingestion"
```

## Task 7: Real Device Observer Validation

**Files:**
- No committed raw output.
- Optional spec update only if validation reveals a durable rule gap.

- [ ] **Step 1: Deploy local code to the test path**

Use the established deployment path for Lorume backend/collector only after automated checks pass. Do not mutate production test data with automated tests.

- [ ] **Step 2: Run collector once on `gezilinll-claw` as observer**

Run the installed Lorume collector path or the repo-local CLI against the real device. Do not manually edit OpenClaw files or Lorume DB rows to make validation pass.

- [ ] **Step 3: Query backend results**

Verify:

- OpenClaw Runtime exists.
- OpenClaw Agent `main` exists.
- Zhang Liang's `日常工作提醒助手` style conversation Tasks appear when present in the collection window.
- `agentId` maps to an existing Agent.
- `taskType` is populated.
- tool call evidence exists for tasks with tool calls.
- raw status is preserved separately from normalized status.

- [ ] **Step 4: Classify any gap**

If validation fails, classify the gap before fixing:

| Gap | Next action |
|---|---|
| Adapter parsing missed real raw shape | Add synthetic fixture reproducing shape, then fix adapter. |
| Backend persistence dropped field | Add repository/API test, then fix backend. |
| UI cannot display yet | Do not patch UI in this plan; record as future frontend work. |
| Real data has ambiguous Agent | Skip task and write diagnostic; do not guess. |

- [ ] **Step 5: Do not commit raw real-device data**

Only commit spec/test/code changes. Raw profiling CSV/JSON stays under `/tmp` on the real device or local scratch paths.

## Task 8: Final Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run focused checks**

Run:

```sh
npm run check:repo
npm run check:cli
npm run check:runtime
npm run check:backend
npm run check:db
npm run check:backend:e2e
```

Expected: all PASS.

- [ ] **Step 2: Run full harness**

Run:

```sh
./scripts/verify.sh
```

Expected: PASS.

- [ ] **Step 3: Final commit**

Run:

```sh
git status --short
git add docs/product/runtime-task-acceptance-spec.md src/runtime/runtime-model.ts src/runtime/runtime-model.test.ts db/migrations/0013_task_type.sql src/server/postgres-store.ts src/server/postgres-store.test.ts src/server/runtime-http-api-postgres.test.ts scripts/lorume-runtime-adapters.mjs src/cli/lorume-cli.test.ts src/runtime/runtime-work-query-api.ts src/runtime/runtime-work-query-api.test.ts e2e/runtime-backend-api.spec.ts scripts/dev-backend-e2e.ts
git commit -m "feat(runtime): collect OpenClaw session tasks"
```

If some files were not changed because tests showed no code was needed, omit them from `git add`.

## Principles And Guardrails

- **Observer role:** Real-device validation observes actual behavior. If uninstall, collector, adapter, or ingestion leaves a gap, fix the project and rerun the official path; do not manually patch remote files or database rows to fake success.
- **Test pyramid:** Unit/script tests prove parser and adapter mapping. DB tests prove persistence. Backend API tests prove query contract. Backend E2E proves collector-process ingestion with isolated local backend/Postgres. Real-device validation is observational acceptance, not a replacement for automated tests.
- **No production mutation:** Automated tests never create device tokens, ingest snapshots, clear tables, or run installer flows against production/deployed backends.
- **No unnecessary entities:** Do not add first-class ToolCall, Evidence, Conversation, Execution, SourceRef, Capability, Channel, or Run entities for P0.
- **OpenClaw-only:** Non-OpenClaw adapters remain disabled by default and must not execute commands, read directories, or emit objects.
- **Raw preservation:** Adapter maps `Task.status` but preserves OpenClaw raw status under `raw.openclaw.status`.
- **Agent integrity:** A Task whose `agentId` cannot map to a collected Agent is skipped and diagnosed.
- **Tool arguments:** Store tool call arguments unredacted in DB raw/evidence for backend troubleshooting. Redact in logs, docs, committed fixtures, screenshots, and any future frontend exposure.
- **Frontend scope:** This plan prepares backend data. Runtime Work Board UI separation for conversation/scheduled Tasks is a follow-up plan.

## Self-Review

- Spec coverage: OpenClaw Runtime, Agent, Task source rules are covered in `docs/product/runtime-task-probe.md`; acceptance updates are Task 1.
- Data structure coverage: `taskType`, agent mapping, tool calls, raw OpenClaw status, and no-new-entity rule are covered in Tasks 2 and 3.
- Implementation coverage: adapter source replacement, tests, persistence, E2E, and real-device observation are covered in Tasks 4-7.
- Test coverage: unit/script, DB, backend API, backend E2E, and real-device observer validation are all represented.
- Scope check: frontend task separation is explicitly out of scope for this backend-first plan.
