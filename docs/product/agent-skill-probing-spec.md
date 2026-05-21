# Agent Skill Probing Spec

Agent Skill probing is Lorume's current read-only view of Skill metadata that already exists on a target Agent's local runtime/device. It is an observation surface, not a centralized Skill registry.

## Boundaries

- Lorume may store device-reported target-local probe metadata snapshots and display the latest read-only status through Runtime Fleet. P0 does not request target devices to run a probe.
- The target device/agent remains the source of truth for local Skill directories.
- Lorume does not import, edit, publish, assign, sync, migrate, install, or analyze Skill content.
- The `lorume` CLI remains deterministic and does not decide how a Skill should be interpreted or installed.
- Target-local probing, when performed by the device side, is executed through `lorume agent skill-probe --json --agent-id <id>`. The collector may upload the returned snapshot, but it must not inspect Skill directories directly.

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
- `succeeded`: the target-local probe returned one or more normalized Skill metadata groups.
- `unsupported`: the target runtime or connector cannot probe local Skills.
- `failed`: the probe ran but failed.

## APIs

- `GET /api/agents/:agentId/skill-probe` returns the latest read-only probe snapshot for an Agent. If no snapshot exists, it returns an `unknown` snapshot rather than inventing Skill data.
- `POST /api/agent-skill-probe-snapshots` accepts collector/device reported probe snapshots and stores normalized metadata only.

Backend-triggered probe requests and device-disconnected request states are not part of P0. Notification copy for stored probe failures must avoid raw tokens, file contents, full logs, and external private payloads.

## Runtime Fleet Display

Runtime Fleet may expose the latest stored Skill probe status near the Agent row or inspector. It must not add a primary navigation item, `/skills` route, organization Skill store, import button, editor, assignment control, migration action, or backend-triggered probe button.

The probe UI shows loading, empty/unknown, success, unsupported, and failed states for stored metadata. It lists root and file metadata compactly and keeps non-Markdown files as plain text.
