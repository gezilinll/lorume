# OpenClaw Agent Dashboard Backend TinySpec

## Scope

This spec covers the first backend-only Agent Dashboard loop for OpenClaw. It supports only `Runtime.kind=openclaw` and OpenClaw external Agent id `main`.

Lorume creates an `agent_analysis` Operation manually through API or through the explicitly enabled backend scheduler. The Job Runner dispatches one restricted prompt over the authenticated collector WebSocket. The collector executes only the fixed OpenClaw Agent analysis command, returns structured JSON, and the backend validates the result before writing an internal report row.

Out of scope for this phase:

- Frontend Dashboard pages or charts.
- Slock, Codex, or non-OpenClaw Runtime analysis.
- OpenClaw Agents other than `main`.
- Global satisfaction, NPS, ratings, or emotion scoring. The Agent may only return task-type-level user feedback tendency from conversation evidence.
- Arbitrary command execution, message delivery, external task mutation, or schedule mutation.

## Operation and Job

Agent analysis uses existing Operation / Job infrastructure:

- `Operation.type = agent_analysis`
- `OperationJob.type = agent_analysis_openclaw`
- `resourceType = agent`
- `resourceId = <agentId>`
- `targetType = device`
- `targetId = <deviceId>`

The Job payload stores:

- `deviceId`
- `runtimeId`
- `agentId`
- `openclawAgentId = main`
- `runtimeKind = openclaw`
- `periodStart`
- `periodEnd`
- `promptKind = daily_operation_review`
- `promptVersion = openclaw-agent-operation-analysis-v2`
- `nonce`
- `deadlineAt`
- `timeoutSeconds`
- `stage`

The Job remains externally running after WS dispatch. Collector progress updates patch Job payload stage/status. Collector result completion writes the report first, then completes the Job and refreshes Operation status. While an `agent_analysis_openclaw` Job is externally running in `dispatched`, `accepted`, `executing`, or `result_received`, the runner must not re-dispatch it before `deadlineAt`; this avoids duplicate prompt execution while still allowing deadline-based failure recovery.

## Report Persistence

`agent_analysis_reports` is an internal dashboard-derived table, not a new top-level product object.

Columns:

- `id`
- `organization_id`
- `operation_id`
- `device_id`
- `runtime_id`
- `agent_id`
- `runtime_kind`
- `period_start`
- `period_end`
- `prompt_kind`
- `prompt_version`
- `hard_metrics jsonb`
- `analysis jsonb`
- `model_metadata jsonb`
- `created_at`

Uniqueness:

- `organization_id + agent_id + period_start + period_end + prompt_version`

All read APIs must filter by organization membership.

## Hard Metrics

Hard metrics are computed by Lorume backend from already-ingested OpenClaw Tasks. The collector and Agent do not self-report hard metrics.

OpenClaw duration basis:

- `trajectoryElapsed = updated_source_at - created_source_at`
- Include only `done` and `failed` Tasks in normal duration statistics.
- Exclude `unknown` and `in_progress` from average/p50/p90 duration.
- Count `cancelled` separately through status distribution; do not mix it into normal duration.

The first hard metric set includes:

- total Task count
- status distribution
- Task type distribution
- latest active timestamp
- `done`/`failed` duration avg/p50/p90/sample count
- failed count
- unknown count

## Prompt Contract

The backend prompt is written in Chinese and contains:

- hard metrics JSON
- the requested `periodStart` / `periodEnd`
- the complete output JSON contract
- instructions to analyze only records where `periodStart <= eventTime < periodEnd`
- instructions to use session/conversation history as the primary analysis grain
- instructions that cross-period sessions may use outside-window context only for light understanding, never as current-period evidence
- instructions that the Agent must read its own history, trajectory, or equivalent records in its runtime environment
- analysis steps for locating period sessions, understanding context, grouping task types, judging per-task-type user feedback, selecting cases, and producing risks/actions
- bounded analysis instructions: do not exhaustively scan all history, spend at most 90 seconds locating/deep-reading evidence, deep-read at most 8 representative sessions, and use hard metrics to estimate workload when the period has more records
- bounded output instructions: at most 5 task types, 2 cases per task type, 4 risks, and 4 actions
- user-feedback instructions: only explicit feedback signals such as confirmation, thanks, adoption, follow-up, correction, complaint, redo request, or abandonment may drive `positive` / `mixed` / `negative`; task success, a final link, or lack of rework alone must remain `unknown`
- output language instructions: analysis text is manager-facing and must not expose internal implementation terms such as `hardMetrics`, Lorume, OpenClaw, system-computed, Agent self-evaluation, prompt, or schema
- explicit instruction to return raw JSON only
- explicit instruction not to add fields outside the JSON contract
- explicit instruction not to deliver messages, mutate files, mutate external tasks, schedule work, or execute unrelated actions

The backend does not send full sessions or sampled Task summaries to the Agent. Hard metrics are included only as compact context for workload, status, and duration. Default OpenClaw analysis timeout is 600 seconds, with collector-side request normalization clamped to the supported protocol range.

Agent JSON output:

```json
{
  "periodPerformance": {
    "workload": "string",
    "completion": "string",
    "latency": "string",
    "failurePattern": "string"
  },
  "taskTypes": [
    {
      "label": "string",
      "countEstimate": 0,
      "description": "string",
      "satisfaction": {
        "level": "positive|mixed|negative|unknown",
        "reason": "string",
        "evidenceIds": ["..."]
      },
      "cases": [
        {
          "id": "...",
          "title": "string",
          "signal": "positive|mixed|negative|unknown",
          "outcome": "string",
          "reason": "string"
        }
      ]
    }
  ],
  "risks": [
    {
      "title": "string",
      "description": "string",
      "evidenceIds": ["..."]
    }
  ],
  "actions": [
    {
      "title": "string",
      "reason": "string",
      "evidenceIds": ["..."]
    }
  ]
}
```

Validation rules:

- Markdown-wrapped output is invalid.
- Top-level keys must be exactly `periodPerformance`, `taskTypes`, `risks`, and `actions`.
- `taskTypes[].satisfaction.level` and `taskTypes[].cases[].signal` must be `positive`, `mixed`, `negative`, or `unknown`.
- Global satisfaction fields such as `satisfaction`, `userSatisfaction`, `satisfactionScore`, `nps`, or rating fields are invalid.
- `evidenceIds` arrays must contain at least one non-empty string because evidence comes from Agent-readable sessions, trajectories, Tasks, or stable history ids.
- Text and array fields have bounded lengths.
- Reports are written only after validation passes.
- The backend may derive a global feedback tendency from `taskTypes[].satisfaction.level` weighted by `countEstimate`; the Agent must not output one.

## Backend API

`POST /api/agent-analysis-runs`

Body:

```json
{ "agentId": "...", "periodStart": "...", "periodEnd": "..." }
```

`periodStart` and `periodEnd` are optional together. When omitted, the backend uses the previous Asia/Shanghai natural day.

Responses:

- `202` with created Operation and Job for supported OpenClaw `main`.
- `400` for invalid period or missing Agent id.
- `401` unauthenticated.
- `403` not an organization member.
- `422` unsupported target.

`GET /api/agent-analysis-reports?organizationId=&agentId=&limit=`

Returns member-visible report summaries.

`GET /api/agent-analysis-reports/:reportId?organizationId=`

Returns one member-visible report.

## Scheduler

The standalone backend process includes a lightweight scheduler, but it is disabled by default. When explicitly enabled, it creates previous-day Asia/Shanghai `agent_analysis` Operations for OpenClaw `main` Agents.

Controls:

- `LORUME_AGENT_ANALYSIS_SCHEDULER_ENABLED=true` enables the scheduler.
- Unset or `false` keeps the scheduler disabled.
- `LORUME_AGENT_ANALYSIS_SCHEDULER_INTERVAL_MS` controls poll interval.

Dedupe:

- Skip when a matching report already exists.
- Skip when a queued or running `agent_analysis` Operation already exists for the same Agent, period, and prompt version.

## WebSocket Protocol

Collector hello/heartbeat capability:

```json
{
  "analysis": {
    "supported": true,
    "protocolVersion": 1,
    "runtimes": ["openclaw"],
    "promptKinds": ["daily_operation_review"]
  }
}
```

Server to collector request type: `agent.analysis.request`.

Collector to server progress type: `agent.analysis.progress`.

Collector to server result type: `agent.analysis.result`.

The server routes progress/result only when protocol version, device id, operation id, job id, and nonce match the current Job payload.

## Collector Behavior

The collector handles only restricted `agent.analysis.request` messages.

Allowed request values:

- `protocolVersion = 1`
- `runtimeId` for OpenClaw
- `openclawAgentId = main`
- `promptKind = daily_operation_review`
- `promptVersion = openclaw-agent-operation-analysis-v2`

Fixed command:

```sh
openclaw agent --agent main \
  --session-id "lorume-analysis-<jobId>" \
  --message "<prompt>" \
  --json \
  --thinking off \
  --timeout <timeoutSeconds>
```

The collector must not pass `--deliver`.

The collector command discovery must work in non-login service environments such as launchd/systemd. It may not assume that the service `PATH` contains `openclaw`; it must search the current `PATH`, the running Node executable directory, common user-local Node binary directories, stable fnm install directories, recent bounded `~/.local/state/fnm_multishells/*/bin` directories, Homebrew paths, and system paths. The spawned OpenClaw process must receive a bounded `PATH` that includes the matched executable directory so `#!/usr/bin/env node` shims still work without exposing secrets.

The collector parses OpenClaw `--json` output `result.payloads[0].text` as raw Agent analysis JSON. It may keep backward-compatible support for top-level `payloads[0].text`, but current OpenClaw output is the `result` envelope. The collector returns only whitelisted metadata:

- `runtimeRunId`
- `durationMs`
- `modelMetadata.provider`
- `modelMetadata.model`
- `modelMetadata.usage.input`
- `modelMetadata.usage.output`
- `modelMetadata.usage.cacheRead`
- `modelMetadata.usage.total`

Duplicate requests for the same running `jobId` must not start another OpenClaw process; the collector only reports running progress.

If the OpenClaw subprocess exceeds `timeoutSeconds`, the collector must terminate the OpenClaw process group, force-kill it when it does not exit promptly, and send a failed `agent.analysis.result` instead of leaving the backend to infer failure only from `deadlineAt`. This covers wrapper processes that spawn an `openclaw-agent` child and keep stdout/stderr open after the top-level CLI exits.

## Harness

Required checks for this surface:

- `npm run check:backend`
- `npm run check:runtime`
- `npm run check:db`
- `npm run check:device-package-version`

Focused harnesses include:

- `src/agent-analysis/agent-analysis-model.test.ts`
- `src/agent-analysis/agent-analysis-http-api.test.ts`
- `src/agent-analysis/agent-analysis-store.test.ts`
- `src/operations/agent-analysis.test.ts`
- `src/server/runtime-control-channel.test.ts`
- `src/runtime/device-collector-script.test.ts`, including a launchd-like PATH case where `openclaw` is only discoverable from a recent fnm multishell directory, a timeout case where a stuck OpenClaw subprocess still yields a failed result, and a wrapper/child-process timeout case that proves the collector kills the process group.
