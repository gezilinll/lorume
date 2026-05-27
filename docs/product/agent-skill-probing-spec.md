# Runtime Skill Probing Spec

Runtime Skill probing is Lorume's read-only view of Skill metadata already discoverable on a target Runtime. It is an observation surface, not a centralized Skill registry.

## Boundaries

- Lorume may store device-reported Runtime Skill probe snapshots and display the latest read-only status through Runtime Fleet.
- Skill probing runs on the device side through the Runtime adapter during collection. The backend stores reported metadata; it does not ask a connected device to execute a probe.
- Device is not a Skill scope. Device-level probing capability belongs in adapter diagnostics and is not exposed as a user-facing Device Skill list.
- Runtime remains the source of truth for local Skill metadata and Agent-specific visibility.
- Lorume does not import, edit, publish, assign, sync, migrate, install, execute, or analyze Skill content.
- Runtime adapters must translate platform-specific Skill facts into Lorume-owned `runtime` / `agent` scope before backend storage.
- Backend snapshots must not require or expose full Skill file contents, private paths, tokens, full logs, or external private payloads.

## Product Scope

Lorume exposes only two Skill scopes:

| Scope | Meaning |
|---|---|
| `runtime` | Runtime or adapter-level capability. It is not owned by a specific Agent. |
| `agent` | Capability visible to, enabled for, or owned by one or more Agents in the Runtime. |

Runtime adapters may keep platform-specific raw fields in diagnostics or raw storage, but product APIs must not expose OpenClaw `personal / workspace / bundled / modelVisible / commandVisible / active` as top-level product fields.

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

## APIs

- `POST /api/runtime-skill-probe-snapshots` accepts collector/device reported Runtime Skill snapshots and stores normalized metadata only.
- `GET /api/runtimes/:runtimeId/skill-probe` returns the latest read-only Runtime Skill snapshot. If no snapshot exists, it returns an `unknown` snapshot rather than inventing Skill data.
- Existing Agent-level endpoints remain compatibility surfaces during frontend migration:
  - `POST /api/agent-skill-probe-snapshots`
  - `GET /api/agents/:agentId/skill-probe`

Agent-level compatibility APIs must not trigger a new Agent-specific probe. After the Runtime-level frontend migration, Agent views should filter from the Runtime snapshot using `agentIds`.

## Runtime Fleet Display

Runtime Fleet may expose the latest stored Skill probe status near Runtime or Agent rows/inspectors. It must not add a primary navigation item, `/skills` route, organization Skill store, import button, editor, assignment control, migration action, or backend-triggered probe button.

Runtime-level display can show the summary and full normalized row list. Agent-level display should show only `scope="agent"` rows whose `agentIds` contain that Agent id, plus relevant runtime-scope context if the product explicitly chooses to show it later.
