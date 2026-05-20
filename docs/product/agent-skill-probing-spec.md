# Agent Skill Probing Spec

Agent Skill probing is Lorume's current read-only view of Skill metadata that already exists on a target Agent's local runtime/device. It is an observation surface, not a centralized Skill registry.

## Boundaries

- Lorume may request a target-local probe, store the resulting metadata snapshot, and display status through Runtime Fleet, Operations, and Notifications.
- The target device/agent remains the source of truth for local Skill directories.
- Lorume does not import, edit, publish, assign, sync, migrate, install, or analyze Skill content.
- The `lorume` CLI remains deterministic and does not decide how a Skill should be interpreted or installed.
- Target-local probing is executed through `lorume agent skill-probe --json --agent-id <id>`. The collector only dispatches the CLI command and uploads the returned snapshot; it must not inspect Skill directories directly.

## Probe Metadata

A probe snapshot is scoped to one target Agent and includes:

- target Agent id and optional display name
- source device id and optional display name
- runtime id and optional display name
- probe status
- last observed/probed time
- Skill root path and `SKILL.md` entry path
- Markdown file names and paths inside each Skill root
- non-Markdown file names and paths inside each Skill root
- short unsupported/error summary when available

Markdown files may be listed by relative path for user orientation. Non-Markdown files are metadata-only: the UI must not render them as clickable files, previews, downloads, or editable text. Backend snapshots must not require or expose full Skill file contents.

## Status

Probe status values are:

- `unknown`: no probe snapshot is available yet.
- `requested`: Lorume requested a probe from an online device and is waiting for a later collector/device result.
- `succeeded`: the target-local probe returned one or more normalized Skill metadata groups.
- `unsupported`: the target runtime or connector cannot probe local Skills.
- `failed`: the probe ran but failed.
- `device_disconnected`: Lorume could not dispatch the request because the device control channel was disconnected.

## APIs

- `GET /api/agents/:agentId/skill-probe` returns the latest read-only probe snapshot for an Agent. If no snapshot exists, it returns an `unknown` snapshot rather than inventing Skill data.
- `POST /api/agents/:agentId/skill-probe` requests a new target-local probe through the device control channel when the owning device is connected.
- `POST /api/agent-skill-probe-snapshots` accepts collector/device reported probe snapshots and stores normalized metadata only.

Probe request APIs may create an `agent_skill_probe` Operation. Probe lifecycle notifications cover request accepted, success, failure, unsupported runtime, and device disconnected. Notification copy must avoid raw tokens, file contents, full logs, and external private payloads.

## Runtime Fleet Display

Runtime Fleet exposes Skill probing from the Agent list row as a compact secondary action, with the latest probe status visible near the Agent row or inspector. It must not add a primary navigation item, `/skills` route, organization Skill store, import button, editor, assignment control, or migration action.

The probe UI shows loading, empty/unknown, requested, success, unsupported, failed, and device-disconnected states. It lists root and file metadata compactly and keeps non-Markdown files as plain text. The detail inspector may summarize the latest probe result, but the primary action should stay on the Agent row so users do not need to open the detail panel before checking Skill metadata.
