# Runtime Skill Probing Spec

Runtime Skill probing is Lorume's read-only view of Skill metadata already discoverable on a target Runtime. It is an observation surface, not a centralized Skill registry.

## Boundaries

- Lorume may store device-reported Runtime Skill probe snapshots and display the latest read-only status through Runtime Fleet and the read-only Skill 仓库 page.
- Skill probing runs on the device side through the Runtime adapter during collection. The backend stores reported metadata; it does not ask a connected device to execute a probe.
- Device is not a Skill scope. Device-level probing capability belongs in adapter diagnostics and is not exposed as a user-facing Device Skill list.
- Runtime remains the source of truth for local Skill metadata and Agent-specific visibility.
- Lorume does not import, edit, publish, assign, sync, migrate, install, execute, or analyze Skill content. It may display already-collected `SKILL.md` text as read-only detail content.
- Runtime adapters must translate platform-specific Skill facts into Lorume-owned `runtime` / `agent` scope before backend storage.
- Backend snapshots may expose a user-facing target-local `localPath` and read-only `SKILL.md` body when the adapter can collect them. They must not expose raw source-path evidence, command names, tokens, full logs, auxiliary file contents, or external private payloads.

## Product Scope

Lorume exposes only two Skill scopes:

| Scope | Meaning |
|---|---|
| `runtime` | Runtime or adapter-level capability. It is not owned by a specific Agent. |
| `agent` | Capability visible to, enabled for, or owned by one or more Agents in the Runtime. |

Runtime adapters may keep platform-specific raw fields in diagnostics or raw storage, but product APIs must not expose OpenClaw `personal / workspace / bundled / modelVisible / commandVisible / active` as top-level product fields.

## Skill 仓库

`/skills` is a read-only inventory page over already-collected Runtime Skill snapshots. It is not centralized Skill management and must not introduce create/edit/import/install/publish/sync/assignment/migration controls.

The page aggregates:

- `GET /api/runtime-fleet` for current Device / Runtime / Agent ownership.
- `GET /api/runtimes/:runtimeId/skill-probe` for each visible Runtime's latest stored Skill snapshot.

Display rules:

- The directory table splits `Scope` (`Runtime` / `Agent`) from source (`系统自带` / `自定义`).
- `scope="runtime"` rows keep `agentIds: []` in stored metadata. For UI display, the page derives `availableAgentIds` from active, non-`invisible` Agents under the same Runtime when the Skill is `available=true`.
- `scope="agent"` rows use stored `agentIds` as ownership/visibility. Agent deep links show both runtime-scope Skills available to that Agent and agent-scope Skills whose `agentIds` include that Agent.
- Runtime Fleet deep links into `/skills?runtimeId=...` or `/skills?runtimeId=...&agentId=...`; the Skill 仓库 filter menu starts with those filters selected.
- The right-side detail inspector keeps raw source-path evidence, command names, and hidden adapter fields out of the UI. It shows compact metadata and derived available Agents for fast browsing.
- A row-level `查看` action opens the read-only Skill detail card. The full detail card is optimized for reading and copying collected content: its header shows only the Skill title, its body shows `localPath` as `本地路径`, and the collected `SKILL.md` body fills the remaining space as `Skill 正文`. `本地路径` and `Skill 正文` expose icon-only copy actions that appear on content hover/focus instead of persistent text buttons.
- Empty or failed Runtime snapshots produce empty/error UI states; the frontend must not invent Skill rows.

## Runtime Snapshot

A Runtime Skill probe snapshot is scoped to one Runtime and includes:

- source Device id
- Runtime id and kind
- probe status
- last observed time
- derived summary counts
- normalized Skill rows
- short unsupported/error summary when available

Product-facing row fields are:

| Field | Rule |
|---|---|
| `name` | Stable display name. |
| `description` | Short description. Missing descriptions are empty strings. |
| `body` | Optional read-only `SKILL.md` body collected from the target Runtime. Missing or oversized bodies are omitted as empty. |
| `localPath` | Optional user-facing target-local path to the collected `SKILL.md`. This is not a raw adapter `sourcePath` field. |
| `scope` | Only `runtime` or `agent`. |
| `available` | Whether the Skill is currently usable from the Runtime view. |
| `builtIn` | Whether the Skill is system-provided. |
| `agentIds` | Only meaningful for `scope="agent"`; records current Agent ownership/visibility. Runtime-scope rows must use `[]`. |

Derived summary fields are:

- `total`
- `runtimeScopeCount`
- `agentScopeCount`
- `availableCount`
- `unavailableCount`
- `builtInCount`

## Status

Probe status values are:

- `unknown`: no Runtime Skill snapshot is available yet.
- `succeeded`: the adapter returned one or more normalized Skill rows.
- `unsupported`: the Runtime or adapter cannot report Skill metadata.
- `failed`: the adapter attempted to report Skill metadata but failed.

## OpenClaw Mapping

OpenClaw-specific fields are adapter internals. The product mapping is:

| OpenClaw source | Lorume scope |
|---|---|
| `openclaw-bundled` or `bundled=true` | `runtime` |
| `openclaw-extra` | `runtime` |
| `openclaw-workspace` | `agent` |
| `agents-skills-personal` | `agent` |
| `agents-skills-project` | `agent` |

Known OpenClaw examples:

- `clawhub`, `healthcheck`, and `weather` are runtime-scope Skills.
- `argus-cost-provider-auth-refresh` and `share-files` are agent-scope Skills.

Availability is derived from usable facts, not from OpenClaw UI visibility:

```ts
available =
  raw.eligible === true &&
  raw.disabled !== true &&
  raw.blockedByAllowlist !== true &&
  missingCount(raw.missing) === 0
```

Rules:

- `active=false` does not make a Skill unavailable by itself.
- `blockedByAgentFilter` affects `agentIds`, not `available`.
- `modelVisible` and `commandVisible` do not decide Lorume `scope` or `available`.
- `builtIn = raw.bundled === true || raw.source === "openclaw-bundled"`.

## Codex And Slock Mapping

Codex is an execution Runtime. Slock is a channel / orchestration / Agent profile source, not a Lorume Runtime by itself. When a Slock profile reports `runtime=codex`, its Agent belongs under the Codex Runtime and its Agent-owned Skills are reported in that Codex Runtime's Skill snapshot.

Codex global Skill sources map to runtime-scope rows:

| Codex source | Lorume scope | `builtIn` |
|---|---|---:|
| `~/.codex/skills/.system/<name>/SKILL.md` | `runtime` | true |
| `~/.codex/skills/<name>/SKILL.md` | `runtime` | false |
| `~/.codex/plugins/cache/<provider>/<plugin>/<version>/skills/<name>/SKILL.md` | `runtime` | true |

Codex probing must not treat `.codex/.tmp`, `.codex/sessions`, `.codex/log`, `.codex/vendor_imports`, marketplace clones, or other temporary candidate directories as current runtime Skills.

Slock Agent Skill sources map to agent-scope rows when the owning Agent is either an active local Slock profile with an implemented `runtime`, or a local Slock workspace that contains Skill files but is not the currently active daemon profile. Skill-only local workspaces are attached to the Codex Runtime with an offline Slock Agent row so `agentIds` remains filterable; this fallback is for Skill inventory only and must not expand Slock Task collection.

| Slock source | Lorume scope | `builtIn` |
|---|---|---:|
| `~/.slock/agents/<agentId>/.agents/skills/<name>/SKILL.md` | `agent` | false |
| `~/.slock/agents/<agentId>/repos/**/.agents/skills/<name>/SKILL.md` | `agent` | false |
| `~/.slock/agents/<agentId>/repos/**/.cursor/skills/<name>/SKILL.md` | `agent` | false |

For Slock Agent Skills, `agentIds` must contain the Lorume Agent ids derived from the owning Slock profiles. Runtime-scope Codex rows must use `agentIds: []`.

If multiple adapters contribute Skill rows for the same Runtime, the collector/backend normalization must merge rows by `runtimeId` and recompute summary counts. One adapter's Runtime Skill contribution must not overwrite another adapter's rows for the same Runtime.

## APIs

- `POST /api/runtime-skill-probe-snapshots` accepts collector/device reported Runtime Skill snapshots and stores normalized metadata only.
- `GET /api/runtimes/:runtimeId/skill-probe` returns the latest read-only Runtime Skill snapshot. If no snapshot exists, it returns an `unknown` snapshot rather than inventing Skill data.
- Existing Agent-level endpoints remain compatibility surfaces during frontend migration:
  - `POST /api/agent-skill-probe-snapshots`
  - `GET /api/agents/:agentId/skill-probe`

Agent-level compatibility APIs must not trigger a new Agent-specific probe. After the Runtime-level frontend migration, Agent views should filter from the Runtime snapshot using `agentIds`.

## Runtime Fleet Display

Runtime Fleet exposes compact Runtime and Agent row actions that deep-link into the read-only Skill 仓库 with the appropriate filters. These actions do not trigger a new probe and must not show import, edit, assignment, migration, or backend-triggered probe controls.

Runtime-level Skill display is the filtered Skill 仓库 inventory for that Runtime. Agent-level display is the same inventory additionally filtered by Agent, so it includes runtime-scope common Skills the Agent can use and agent-scope rows whose `agentIds` contain that Agent id.
