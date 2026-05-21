# OpenClaw First Runtime Model Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge Lorume runtime collection onto a simple `Device / Runtime / Agent / Task` model and ship it first for OpenClaw only.

**Architecture:** Treat OpenClaw as the first fully migrated adapter and disable all other runtime adapters by default during this phase. Collector output should become one coherent device-state snapshot containing four product objects, while adapter-specific commands, raw evidence, capability details, and debug paths stay inside adapter code, diagnostics, or DB raw fields instead of leaking into the main API/UI model.

**Tech Stack:** Node.js collector and CLI scripts, TypeScript runtime models and query adapters, Postgres migrations/repositories, Vitest unit/API/script tests, backend API-only E2E, Playwright UI E2E, and real-device observer validation against `ssh gezilinll-claw`.

---

## Review Status

This document is for product/engineering review before implementation. It intentionally does not change runtime behavior by itself.

## Non-Negotiable Principles

- Model the product around exactly four top-level objects: `Device`, `Runtime`, `Agent`, and `Task`.
- Do not add first-class `Conversation`, `Execution`, `Capability`, `SourceRef`, or `Channel` entities unless a later product requirement proves they are necessary.
- Keep object relationships linear: `Device -> Runtime -> Agent -> Task`.
- `Task` must only reference `Agent` through `agentId`. Runtime and Device context must be resolved through joins or BFF composition.
- Use two status families only:
  - `collectionStatus` for `Device`, `Runtime`, and `Agent`.
  - `status` for `Task`.
- Do not expose adapter mechanics as product fields. Runtime `capabilities`, Runtime `endpoint`, Runtime/Agent `sourceRefs`, Agent `origin`, and Agent `load` leave the main model.
- Disable non-OpenClaw adapters for this migration phase. Do not run Slock, Multica, Codex, or Claude probing while validating the new OpenClaw model.
- Remove Claude Code from the supported runtime kind list in this phase. Codex can stay as a future supported `RuntimeKind`, but it is not collected in the OpenClaw-first phase.
- Tests must never write to the real deployed backend. Local E2E uses isolated Postgres and local backend only.
- Do not create tests for deleted backend-triggered refresh behavior. That boundary is a code review and grep/spec guard, not a behavioral test target.

## Target Data Structures

These are the review target shapes. Implementation can split transport, DB row, and UI view types, but the normal API/UI model should preserve these semantics.

```ts
export type CollectionStatus = "syncing" | "online" | "offline" | "error";

export type RuntimeKind = "openclaw" | "slock" | "multica" | "codex";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "review"
  | "done"
  | "blocked"
  | "failed"
  | "cancelled"
  | "unknown";

export interface Device {
  id: string;
  hostname: string;
  os: string;
  architecture?: string;
  collectionStatus: CollectionStatus;
  lastSeenAt?: string;
  user?: {
    username?: string;
  };
  network?: {
    publicIp?: string;
    localIps?: string[];
  };
  collector?: {
    version: string;
    installPath?: string;
    lastError?: string;
  };
}

export interface Runtime {
  id: string;
  deviceId: string;
  kind: RuntimeKind;
  name: string;
  version?: string;
  collectionStatus: CollectionStatus;
  lastSeenAt?: string;
  diagnostics?: {
    paths?: Array<{ label: string; path: string }>;
    lastError?: string;
  };
}

export interface Agent {
  id: string;
  runtimeId: string;
  name: string;
  collectionStatus: CollectionStatus;
  lastSeenAt?: string;
  diagnostics?: {
    paths?: Array<{ label: string; path: string }>;
    lastError?: string;
  };
}

export interface Task {
  id: string;
  agentId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  source?: {
    externalId?: string;
  };
  channel?: {
    kind: "dingtalk" | "telegram" | "slack" | "slock" | "multica" | "openclaw" | "other";
    name?: string;
    externalId?: string;
  };
  conversation?: {
    title?: string;
    externalId?: string;
    lastActivityAt?: string;
  };
  assignee?: {
    name?: string;
  };
  creator?: {
    name?: string;
  };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
}
```

### Transport Envelope

The collector should eventually send one coherent device-state snapshot. This envelope is not a product entity; it is a transport shape.

```ts
export interface DeviceStateSnapshot {
  observedAt: string;
  device: Device;
  runtimes: Runtime[];
  agents: Agent[];
  tasks: Task[];
  diagnostics?: {
    warnings?: string[];
  };
}
```

## Status Rules

### Collection Status

`collectionStatus` describes whether Lorume can currently collect and trust data for an asset. It does not describe whether the asset is busy with a task.

| Status | Meaning |
|---|---|
| `syncing` | Device is registered or connected, but no accepted snapshot has produced stable data yet. Mostly a Device-level state. |
| `online` | The object appeared in the latest successful, fresh collection result. |
| `offline` | The object or its parent device has gone stale beyond the accepted freshness threshold. |
| `error` | Latest collection or ingestion for the relevant object/source failed. |

Runtime and Agent activity such as "working" or "idle" must be derived from Task counts in BFF/UI, not stored as Runtime/Agent status.

### Task Status

`Task.status` is the only task status source. There is no `TaskRunStatus` and no `lastRun` in this phase.

| External/OpenClaw evidence | Lorume `TaskStatus` |
|---|---|
| queued, pending, todo | `todo` |
| running, active, in_progress | `in_progress` |
| review, in_review | `review` |
| succeeded, completed, done | `done` |
| blocked, waiting_on_dependency | `blocked` |
| failed, error | `failed` |
| cancelled, canceled | `cancelled` |
| cannot map confidently | `unknown` |

## OpenClaw-First Adapter Strategy

### Adapter Allowlist

Add a single adapter gate used by current `device_state` collection.

| Setting | Behavior |
|---|---|
| Default during this plan | `["openclaw"]` |
| Disabled adapter | Must not execute commands, read local directories, or emit objects. |
| Future expansion | Re-enable one adapter at a time only after it maps into the four-object model and has tests. |

Suggested config surface:

```sh
LORUME_ENABLED_RUNTIME_ADAPTERS=openclaw
```

Implementation should also accept the same setting from collector config so real-device runs can be explicit.

### OpenClaw Object Mapping

| Lorume object | OpenClaw source | Rule |
|---|---|---|
| `Device` | collector host facts | Same device facts as current collector, with `collectionStatus` derived server-side or by query layer. |
| `Runtime` | OpenClaw config, `openclaw health`, `openclaw status` | One runtime named `OpenClaw Gateway`, kind `openclaw`. |
| `Agent` | OpenClaw health/status agent list plus config agent list | One Agent per real OpenClaw agent id. No fake agent unless OpenClaw exposes a real default agent identity. |
| `Task` | OpenClaw messages/tasks/runs | One Task per task/message/run that can be mapped to an Agent. If Agent mapping is ambiguous, do not ingest the Task; record a diagnostic warning. |

### Stable ID Rules

Use deterministic IDs so upserts are stable across snapshots.

| Object | Rule |
|---|---|
| Device | Existing configured device id, otherwise sanitized hostname. |
| Runtime | `${deviceId}:runtime:openclaw` |
| Agent | `${runtimeId}:agent:${openClawAgentId}` |
| Task | `${agentId}:task:${openClawTaskExternalId}` |

If OpenClaw has multiple raw evidence ids for the same task, adapter code must select one canonical external id before creating the Lorume Task. Do not expose a `sourceRefs[]` array to the product model.

## File Map

| File | Expected responsibility |
|---|---|
| `docs/product/runtime-device-registration-spec.md` | Define the four-object device-state model, OpenClaw-first adapter scope, and no backend-triggered collection. |
| `docs/product/runtime-fleet-page-spec.md` | Define Runtime Fleet display around collection status and derived task counts. |
| `docs/product/runtime-task-probe.md` | Define current OpenClaw-first Task probing and make `Task` the only product work object. |
| `docs/product/cli-device-capability-spec.md` | Define `lorume collect device-state --json` and OpenClaw-only default adapter behavior. |
| `AGENTS.md` | Update agent rules so future work preserves the four-object model and OpenClaw-first migration boundary. |
| `src/runtime/runtime-model.ts` | Replace broad runtime/agent state types with four-object model types or re-export from focused model files. |
| `src/runtime/runtime-fleet-query.ts` | Build Runtime Fleet view from `Device`, `Runtime`, `Agent`, and derived Task counts. |
| `src/runtime/runtime-work-query-api.ts` | Parse backend Task query responses into the current Runs view model. |
| `src/runtime/runtime-work-query-api.ts` | Parse backend Task query responses into `Task` view data. |
| `src/runtime/RuntimeFleetPage.tsx` | Remove status labels based on working/idle assets; use collection status and task counts. |
| `src/runtime/RuntimeWorkBoardPage.tsx` | Render Task arrays grouped by `Task.status` in BFF/UI, not collector-provided lanes. |
| `scripts/lorume-runtime-adapters.mjs` | Add adapter allowlist, remove Claude collection, and output OpenClaw `Runtime`, `Agent`, and `Task` in the new shape. |
| `scripts/lorume-device-collector.mjs` | Call the new unified CLI collection path and POST the unified snapshot. |
| `scripts/lorume.mjs` | Support `lorume collect device-state --json`; old `collect inventory` and `collect work-state` return `unsupported_command`. |
| `src/server/runtime-http-api.ts` | Accept unified snapshots through an authenticated device write endpoint and serve four-object read models. |
| `src/server/postgres-store.ts` | Persist devices, runtimes, agents, and tasks without first-class conversation/execution tables in the new write path. |
| `db/migrations/` | Add schema changes for collection status and tasks; stop relying on runtime capabilities/sourceRefs/origin/load fields in query paths. |
| `fixtures/runtime/` | Replace broad fixture snapshots with OpenClaw-first four-object fixtures. |
| `src/runtime/*.test.ts`, `src/server/*.test.ts`, `src/cli/*.test.ts` | Cover model normalization, adapter gating, API ingestion, and query behavior. |
| `e2e/runtime-backend-api.spec.ts` | Local backend E2E with fake OpenClaw collector, isolated Postgres only. |
| `e2e/runtime-fleet.spec.ts`, `e2e/runtime-work-board.spec.ts` | Browser proof for Runtime Fleet and Task board behavior after the model convergence. |

## Phased Plan

### Phase 0: Review And Scope Lock

- [ ] Review this plan with product/engineering.
- [ ] Confirm that `Task.status` remains the only task state.
- [ ] Confirm that Runtime/Agent `collectionStatus` never means working/idle.
- [ ] Confirm that non-OpenClaw adapters are disabled, not deleted, except Claude Code which is removed from supported runtime kinds.
- [ ] Confirm the recommended endpoint strategy: introduce `/api/device-state-snapshots` immediately and keep the old write endpoints as compatibility wrappers for one migration pass.

### Phase 1: Spec And Guard Rails

- [ ] Update product specs with the four-object model and OpenClaw-first scope.
- [ ] Update `AGENTS.md` with durable rules:
  - four top-level objects only;
  - `Task` only references `Agent`;
  - no Runtime `capabilities/endpoint/sourceRefs`;
  - no Agent `origin/sourceRefs/load`;
  - no first-class conversation/execution/capability entities.
- [ ] Add a lightweight repo guard in `scripts/check-repo.sh` for the most dangerous regressions:
  - `claude_code` is not listed as a supported runtime kind;
  - runtime product model does not expose `capabilities`;
  - agent product model does not expose `origin`;
  - task product model does not expose `runtimeId`.
- [ ] Run `npm run check:repo`.

### Phase 2: Model Tests Before Implementation

- [ ] Add focused tests for accepted target objects.
- [ ] Add tests that reject or strip removed fields from API/UI model creation:
  - Runtime `endpoint`;
  - Runtime `capabilities`;
  - Runtime `sourceRefs`;
  - Agent `origin`;
  - Agent `sourceRefs`;
  - Agent `load`;
  - Task `runtimeId`;
  - Task `lastRun`;
  - first-class `conversations` and `executions` arrays in the product response.
- [ ] Add tests for `TaskStatus` mapping from OpenClaw raw statuses.
- [ ] Add tests for collection status labels and Runtime Fleet view labels.
- [ ] Run the focused tests and confirm they fail for the current model before changing implementation.

Focused commands:

```sh
npx vitest run src/runtime/runtime-model.ts
npx vitest run src/runtime/runtime-fleet-query.test.ts
npx vitest run src/runtime/runtime-work-query-api.test.ts
```

### Phase 3: OpenClaw-Only Adapter Gate

- [ ] Add an adapter allowlist helper in `scripts/lorume-runtime-adapters.mjs`.
- [ ] Default enabled adapters to OpenClaw only for this migration phase.
- [ ] Stop calling Multica, Slock, Codex, and Claude in default collection.
- [ ] Remove Claude Code from `RuntimeKind`, labels, docs, and CLI fixture expectations.
- [ ] Keep Codex in `RuntimeKind` as future-supported, but do not collect it while OpenClaw-only mode is active.
- [ ] Add script tests with fake Slock/Multica/Codex/Claude binaries that fail the test if invoked.
- [ ] Add script tests proving OpenClaw binaries are invoked and non-OpenClaw binaries are skipped.

Focused commands:

```sh
npx vitest run src/runtime/device-collector-script.test.ts
npx vitest run src/cli/lorume-cli.test.ts
```

### Phase 4: OpenClaw Adapter Output

- [ ] Map OpenClaw runtime into the target `Runtime` structure.
- [ ] Map OpenClaw agents into the target `Agent` structure.
- [ ] Map OpenClaw task/message/run evidence into `Task[]`.
- [ ] Enforce `Task.agentId`:
  - if raw evidence has a clear agent id, use it;
  - if raw evidence can be mapped through exactly one configured agent, use that agent;
  - if mapping is ambiguous, skip the Task and record a diagnostic warning.
- [ ] Normalize OpenClaw task statuses into the single `TaskStatus` set.
- [ ] Keep raw OpenClaw evidence out of product fields; preserve it only in adapter-local debug output or DB raw fields.
- [ ] Update OpenClaw fixtures to include representative:
  - no task;
  - todo task;
  - in-progress task;
  - failed task with `error`;
  - DingTalk group task;
  - ambiguous task that is skipped with warning.

Focused commands:

```sh
npx vitest run src/runtime/device-collector-script.test.ts
npx vitest run src/runtime/runtime-work-query-api.test.ts
```

Old work-state adapter tests are retired in this phase; focused coverage lives in CLI, collector, backend API, and Task query tests.

### Phase 5: Backend Ingestion And Persistence

- [ ] Introduce the unified snapshot ingestion path.
- [ ] Persist the four object tables/query shapes:
  - `devices`;
  - `runtimes`;
  - `agents`;
  - `tasks`.
- [ ] Persist Task rows in the current `tasks` table.
- [ ] Remove old work-state tables and columns through migration; do not keep compatibility storage.
- [ ] Make `collectionStatus` server-derived or repository-derived, not blindly trusted from a collector payload when request/ingestion evidence disagrees.
- [ ] Ensure task upsert uses stable `Task.id` and replaces missing tasks for a device/agent according to full snapshot semantics.
- [ ] Update failed ingestion recording to distinguish:
  - device snapshot parse failure;
  - OpenClaw adapter warning;
  - DB write failure.

Focused commands:

```sh
npm run check:db
npm run check:backend
npx vitest run src/server/runtime-http-api.test.ts
npx vitest run src/server/postgres-store.test.ts
```

### Phase 6: Query APIs And UI View Models

- [ ] Runtime Fleet query returns `Device`, `Runtime`, `Agent`, and derived task counts.
- [ ] Runtime Fleet status badges use collection status:
  - `syncing` -> `同步中`;
  - `online` -> `在线`;
  - `offline` -> `离线`;
  - `error` -> `异常` or `错误`, with final label confirmed before implementation.
- [ ] Runtime Fleet no longer shows working/idle as Runtime/Agent status.
- [ ] Runs/Work Board consumes `Task[]`.
- [ ] Runs/Work Board groups tasks by `Task.status` at BFF or frontend level.
- [ ] Runs/Work Board does not display first-class conversations/executions.
- [ ] UI can show Task `channel` and `conversation` as nested task context.
- [ ] Agent task counts are derived by joining `Task.agentId`.
- [ ] Runtime task counts are derived through `Task.agentId -> Agent.runtimeId`.

Focused commands:

```sh
npm run check:quick
npm run check:e2e
```

### Phase 7: Local API-Only E2E

- [ ] Extend local backend E2E with isolated Postgres and fake OpenClaw CLI.
- [ ] Start local backend only; do not call deployed Lorume.
- [ ] Run real collector process or the closest production script path against the local backend.
- [ ] Assert:
  - installer files are locally consistent;
  - collector posts unified snapshot;
  - only OpenClaw adapter is invoked;
  - DB contains one Device, one OpenClaw Runtime, expected Agents, and expected Tasks;
  - Task only has `agentId`, not `runtimeId`;
  - Runtime/Agent removed fields do not appear in read APIs.

Focused command:

```sh
npm run check:backend:e2e
```

### Phase 8: Real Device Observer Validation

- [ ] Deploy reviewed and tested code before touching `gezilinll-claw`.
- [ ] Use product uninstall/install commands only.
- [ ] Do not manually remove leftover files, launchd services, systemd units, logs, or DB rows to make validation pass.
- [ ] If uninstall or install leaves residue, stop the real-device procedure, diagnose the product gap, fix code/tests, redeploy, and rerun.
- [ ] Run OpenClaw-only collector on `gezilinll-claw`.
- [ ] Verify backend read APIs show:
  - Device facts;
  - OpenClaw Runtime only;
  - OpenClaw Agents only;
  - OpenClaw Tasks only;
  - no Slock/Multica/Codex/Claude Runtime rows from the new run.
- [ ] If real-device validation exposes a gap missing from the test pyramid, add the smallest local automated test that would have caught it before rerunning validation.

## Testing Pyramid

| Layer | Purpose | Examples |
|---|---|---|
| Unit/type tests | Prove target model shape, status mapping, ID rules, and field removals. | `runtime-model.ts`, OpenClaw task status mapper tests. |
| Script/adapter tests | Prove collector and CLI call the correct adapter and produce correct four-object snapshots. | `device-collector-script.test.ts`, `lorume-cli.test.ts`. |
| Backend API tests | Prove device-token auth, ingestion validation, and read APIs. | `runtime-http-api.test.ts`, `runtime-http-api-postgres.test.ts`. |
| DB integration tests | Prove migrations, upserts, full snapshot replacement, and joins. | `postgres-store.test.ts`, `db-migrate.test.ts`, `npm run check:db`. |
| Local API-only E2E | Prove real collector process talks to local backend with isolated Postgres. | `e2e/runtime-backend-api.spec.ts`, `npm run check:backend:e2e`. |
| Browser E2E | Prove Runtime Fleet and Runs surfaces render the simplified model. | `e2e/runtime-fleet.spec.ts`, `e2e/runtime-work-board.spec.ts`. |
| Production smoke | Public deploy smoke only by default; authenticated reads only with explicit smoke auth. | `npm run smoke:production`. |
| Real-device observer validation | Manual observation of real install/uninstall/collect path after local automation passes. | `ssh gezilinll-claw`, product commands only. |

## Rollout And Commit Strategy

Use focused commits so review can isolate risk.

| Commit | Scope |
|---|---|
| `docs(runtime): define openclaw first model convergence` | Specs and AGENTS guardrails. |
| `test(runtime): lock four object model contracts` | Failing/then passing model and status tests. |
| `feat(runtime): gate collection adapters to openclaw` | Adapter allowlist and Claude removal. |
| `feat(runtime): emit openclaw tasks in unified model` | OpenClaw adapter conversion. |
| `feat(backend): ingest device state snapshots` | API, DB, repository changes. |
| `refactor(runtime): query fleet and tasks from unified model` | BFF/query model updates. |
| `test(e2e): cover openclaw first collector path` | Local API-only and browser E2E updates. |

## Review Checklist

- [ ] The plan keeps exactly four top-level product objects.
- [ ] `Task` only references `Agent`.
- [ ] Runtime/Agent status does not mean working/idle.
- [ ] There is no Runtime `unknown` kind.
- [ ] Claude Code is removed from current support.
- [ ] Non-OpenClaw adapters are disabled by default and not called.
- [ ] `Task.status` is the only task status.
- [ ] No first-class conversation/execution/capability/source-ref entities are introduced.
- [ ] Tests stay local and isolated from production data.
- [ ] Real-device validation remains observer-style and does not manually repair product failures.
