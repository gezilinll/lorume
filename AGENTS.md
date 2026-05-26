# Lorume Agent Guide

Root guide for coding agents working in this repository. This file is operational: it tells agents how to understand Lorume, preserve product boundaries, update specs, run harnesses, and self-close implementation work. Keep public project background in `README.md`.

## Project State

Lorume is currently in product definition and early engineering setup. The repository is becoming the control plane for operating an Agent Network. It now has a Runtime Fleet page with read-only Agent Skill probing, a read-only Runs conversation task page, top-right Operations and Notifications utility drawers, organization settings for invitations, collector-backed runtime collection using the current `Device / Runtime / Agent / Task` model, organization-based auth/access, a shadcn/ui frontend design-system foundation, and a standalone backend with Postgres-backed query APIs, production-like Docker / Nginx deployment files, an SSH-operated production deployment at `lorume.com`, plus an outbound WebSocket device control channel for connection health. It does not yet have centralized Skill management, Agent migration, multi-device orchestration, or runtime execution control.

Current source of truth:

- `README.md`: public project overview and operating model.
- `docs/product/ui-design.md`: product object model, information architecture, pages, flows, and implementation priorities.
- `docs/product/design/README.md`: design system source of truth for visual language, tokens, typography, color, layout, components, icons, interaction, content, responsive behavior, page patterns, and UI review harness.
- `docs/product/runtime-device-registration-spec.md`: TinySpec for current device registration, collector, runtime adapters, metadata snapshots, and Task batch sync.
- `docs/product/runtime-fleet-page-spec.md`: TinySpec for the first Runtime Fleet management page.
- `docs/product/runtime-openclaw-adapter-spec.md`: TinySpec for current OpenClaw adapter source rules and adapter-to-Task mapping.
- `docs/product/runtime-slock-adapter-spec.md`: TinySpec for the default-enabled Slock adapter source rules, daemon credential discovery, ownership proof, pagination, and adapter-to-Task mapping.
- `docs/product/runtime-codex-adapter-spec.md`: TinySpec for the default-enabled Codex adapter source rules, ownership classification, status mapping, diagnostics, and adapter-to-Task mapping.
- `docs/product/runtime-task-acceptance-spec.md`: TinySpec for Runs conversation Task acceptance.
- `docs/product/backend-service-spec.md`: TinySpec for the local-first formal backend service, Postgres persistence, collector ingestion, and backend query APIs.
- `docs/product/cli-device-capability-spec.md`: current rules for the deterministic local `lorume` CLI device capability atoms.
- `docs/product/agent-skill-probing-spec.md`: current rules for read-only target-local Agent Skill probing metadata, statuses, APIs, and UI boundaries.
- `docs/product/auth-and-access-spec.md`: TinySpec for organization-based auth/access, email-code login, invitations, sessions, and device tokens.
- `docs/product/operation-job-runner-spec.md`: product and engineering spec for Postgres-backed asynchronous Operations, executable Jobs, retry/lease semantics, and user-visible status.
- `docs/product/notification-spec.md`: product spec for in-app and email notifications, recipient scope, dedupe, rate limits, and recovery notifications.
- `docs/operations/ssh-deployment.md`: current SSH-based production server deployment and real-device collector deployment/update runbook, including `gezilinll-claw` verification boundaries.
- `docs/operations/self-review.md`: repository-wide self-review protocol for code, docs, specs, harnesses, deployment notes, and product/data consistency.
- `src/console/ConsoleUtilityDrawer.tsx`: protected Console utility drawer for user-visible Operation / Job status and Notification threads.
- `src/settings/OrganizationSettingsPage.tsx`: protected Organization Settings page for current organization context, member invitations, device token creation, and one-line collector install commands.
- `src/operations/operation-store.ts`: Postgres repository for asynchronous Operations and executable Jobs.
- `src/operations/operation-http-api.ts`: authenticated Operation query API for user-visible asynchronous status and job details.
- `src/operations/job-runner.ts`: minimal backend job runner over OperationStore claim, lease, handler, retry, and completion semantics.
- `src/notifications/notification-store.ts`: Postgres repository for deduplicated notification events, threads, deliveries, and cooldown state.
- `src/notifications/notification-http-api.ts`: authenticated in-app Notification query API for user-visible threads and delivery details.
- `src/HomePage.tsx`: public homepage entry for the current Lorume value proposition and implemented capabilities.
- `src/catalog/catalog-object.ts`: initial TypeScript source of truth for Catalog Object shape.
- `src/catalog/catalog-seed.ts`: first reviewable Catalog Object seed data for future object directory work.
- `src/runtime/runtime-model.ts`: TypeScript source of truth for the current `Device / Runtime / Agent / Task` model and `device_state` normalization.
- `src/runtime/runtime-task-sync.ts`: TypeScript source of truth for Task hash, batch shape, and collector/backend Task batch normalization.
- `src/runtime/runtime-work-query-api.ts`: frontend API adapter for backend Runs query responses and cursor pagination.
- `src/runtime/runtime-data-source.ts`: source-of-truth helper for whether fixture fallback is allowed in a given build mode.
- `src/runtime/runtime-collection-health.ts`: TypeScript source of truth for product-level collection diagnostics derived from collector ingestion records and folded into Runtime Fleet object status.
- `src/errors/error-catalog.ts`: shared source of truth for normalized error codes and user-readable messages.
- `src/logging/structured-logger.ts`: shared backend structured logger with secret redaction rules.
- `src/runtime/agent-skill-probe.ts`: TypeScript source of truth for read-only Agent Skill probe metadata normalization and local file-entry parsing.
- `src/runtime/runtime-fleet-query.ts`: query and detail model for the Runtime Fleet page.
- `src/server/runtime-device-state-store.ts`: internal device_state fallback snapshot store plus device connection and Skill probe state for local tests/dev backend.
- `src/server/postgres-store.ts`: Postgres-backed repository for normalized metadata snapshot ingestion, Task batch ingestion, and Device / Runtime / Agent / Task queries.
- `src/server/runtime-control-channel.ts`: in-memory device control channel for connection and heartbeat lifecycle.
- `src/server/runtime-http-api.ts`: backend HTTP API for collector ingestion, Runtime Fleet / Runs query endpoints, Agent Skill probe snapshot endpoints, and ingestion diagnostics.
- `src/backend/backend-server.ts`: standalone local-first backend service that composes auth, Operation / Notification, Runtime / Runs HTTP APIs, in-process Operation runner, and the device WebSocket control channel outside Vite.
- `src/backend/device-installer-http-api.ts`: public secret-free installer and device package download API used by one-line device registration commands.
- `src/index.css`, `src/components/ui/`, `src/lib/utils.ts`, `components.json`, and `public/favicon.svg`: shadcn/ui frontend design-system foundation, theme variables, generated primitives, utility helpers, aliases, and browser tab metadata.
- `vite.backend.config.ts`: backend bundle entry for production-like Node execution.
- `db/schema.sql`: current Postgres schema baseline for the formal backend service.
- `scripts/db-setup.mjs`: local Postgres schema setup script.
- `scripts/check-deploy-config.mjs`: production-like deploy config smoke check.
- `scripts/smoke-production.mjs`: deployed environment smoke check for public health, readiness, installer assets, and optional authenticated Runtime / Runs read paths.
- `scripts/lorume.mjs`: deterministic local CLI for device identity, snapshot-backed runtime listing, authorized connector status, and safe explicit file copy.
- `scripts/lorume-runtime-adapters.mjs`: CLI-owned runtime adapter module used by `lorume collect device-state`.
- `Dockerfile.backend`, `Dockerfile.frontend`, `nginx.lorume.conf`, `docker-compose.prod-like.yml`: production-like local deployment shape before ECS.
- `scripts/lorume-device-collector.mjs`: device-side collector / Device Agent script.
- `scripts/install-device-collector.sh`: local-path collector installer used directly in development and indirectly by the remote installer wrapper.
- `scripts/dev-backend-e2e.ts`, `playwright.backend.config.ts`, `e2e/runtime-backend-api.spec.ts`: backend API-only E2E harness for auth, device token creation, installer assets, real collector-process ingestion, query APIs, and heartbeat-only device WebSocket.
- `e2e/runtime-fleet.spec.ts`: browser-level Runtime Fleet workflow and responsive layout harness.
- `e2e/runtime-work-board.spec.ts`: browser-level Runs conversation task workflow and responsive layout harness.
- `docs/product/agent-network-runtime-panorama.png`: runtime panorama.
- `docs/product/agent-network-build-objects.png`: build object map.
- `assets/product-ui/`: UI and flow design assets.

## Working Rules

- Preserve the boundary between product docs and team execution plans. Do not add internal rollout plans, owner assignments, or temporary team checklists to the repo unless the user explicitly asks.
- Durable rules belong in the narrowest useful source of truth: repo-wide agent workflow rules in this file, product/data/API rules in the matching product spec, visual rules in `docs/product/design/`, and executable expectations in harnesses. Temporary plans, real-device runbooks, profiling notes, and phase checklists must not be committed as durable docs unless the user explicitly asks and the content is converted into stable rules or acceptance criteria.
- When the user asks for `self review`, `自我 Review`, or asks to review whether recent work is complete and consistent, follow `docs/operations/self-review.md`: review code, docs, specs, harnesses, deployment notes, and source-of-truth consistency, not only UI.
- Treat Workflow, Domain Agent, Semantic Coordinator, Runtime / Execution Fabric, Registry / Catalog, Governance, and Lifecycle definitions in `docs/product/ui-design.md` as the product baseline.
- Keep changes proportional to the current phase. Do not create empty framework directories, speculative services, broad schemas, or placeholder platforms before they are needed.
- Keep `README.md` business-facing: project background, use cases, operating model, current status, and durable design links. Put coding-agent rules, local commands, harness details, and self-verification workflow in this file.
- Use semantic filenames for durable assets. Avoid leaving uploaded image names with spaces or copy suffixes when the asset becomes part of product documentation.
- When code directories appear, add scoped `AGENTS.md` files only where local commands, boundaries, or ownership differ from this root guide.
- Treat the device WebSocket as a control plane only. Do not use it for chat, arbitrary command execution, external platform protocol emulation, or task scheduling until a spec and harness explicitly introduce those behaviors.
- Keep runtime/device/auth secrets out of logs, fixtures, tests, docs, and UI screenshots. `deviceToken`, Slock keys, bearer tokens, platform API keys, login codes, session tokens, invitation tokens, and email provider keys may be passed through local config, but they must not be committed or displayed.
- Automated tests, harnesses, and smoke scripts must never mutate the real production backend or production database. Device token creation, collector ingestion, table cleanup, and installer execution tests must target local isolated backend/Postgres instances and temporary install directories only.
- Public domain reachability such as `claw.gezilinll.com` or `lorume.com` is deployment/operations validation. Do not make deployed domain availability, ICP/TLS state, or production installer reachability a required project harness condition.
- Installer contract tests must use repository-local relative paths as the source of truth. They may verify that the local backend handler serves those files, but installation integrity must compare local source files with local temporary install results instead of trusting deployed HTTP content.
- Auth/access rules belong in `docs/product/auth-and-access-spec.md` and backend auth modules. Do not implement permission decisions as ad hoc React conditionals.
- Lorume frontend UI uses shadcn/ui generated components in `src/components/ui/`, Tailwind CSS v4 utilities, CSS variables in `src/index.css`, and lucide-react icons. Do not introduce parallel UI primitive systems unless a product spec and harness require them.
- App-owned reusable UI wrappers belong outside `src/components/ui/` and must compose generated shadcn primitives instead of replacing them.
- Use the official shadcn CLI to add new primitives and keep `components.json` aligned with project aliases.
- Only expose implemented, user-verifiable capabilities in navigation, homepage CTAs, and page-level action buttons. Current Console navigation is `Runtime Fleet`, `Runs`, and `组织设置`; Operations and Notifications are top-right utility drawers reachable through `/operations` and `/notifications`, not primary nav pages. Future surfaces such as Agent Studio, Workflow Studio, Object Catalog, Skill management, People, Integrations, and Governance stay in docs/backlog until their page, data path, permissions, and harness exist.
- Keep URL routes durable and minimal: `/` is the public homepage, `/login` is the auth entry, `/invite/:token` is the invitation entry, and `/runtime`, `/runs`, `/settings` are the current protected Console pages. `/operations` and `/notifications` are protected utility drawer routes layered over the current Console context. Unknown or not-yet-built routes should fall back to the current default Console page instead of exposing fake data.
- Keep the browser tab icon and in-app logo aligned. If the app chrome mark changes, update `public/favicon.svg`, relevant tests, and product visual rules in the same change.
- Runtime adapters must translate platform-specific fields into Lorume-owned semantics before UI consumption. Do not make React components infer whether OpenClaw sessions, Multica tasks, or Slock workspaces mean `active`, `idle`, `lastSeenAt`, or runtime statistics.
- Task `adapter.kind` records which collector adapter normalized the Task. Keep adapter provenance separate from Runtime kind and Channel kind, and do not add unsupported adapter/channel enum values before implementation and harness exist.
- Codex adapter must classify thread ownership before Task mapping. Slock-owned and Multica-owned Codex sessions must not be emitted as Codex Tasks; Slock platform facts remain owned by the Slock adapter.
- The runtime model uses exactly four top-level product objects: `Device`, `Runtime`, `Agent`, and `Task`. Do not add first-class Conversation, Execution, Capability, SourceRef, Channel, or Run entities unless a product spec and harness explicitly reintroduce them.
- Keep runtime relationships linear: `Device -> Runtime -> Agent -> Task`. A `Task` references only `agentId`; Runtime and Device context must be resolved by joins or BFF composition. Do not add `task.runtimeId` to the product model.
- Runtime and Agent product models use `collectionStatus` only. Do not store working/idle as Runtime or Agent status; derive task counts and activity labels from `Task.status`.
- Task product models use `userMessage` and optional `agentReply`; do not reintroduce Task `title`, `description`, `toolCalls`, `lastSeenAt`, `lastRun`, or execution status without updating the product spec and harness first.
- Collector HTTP writes are split by concern: `/api/device-state-snapshots` accepts Device / Runtime / Agent metadata with `tasks: []`, and `/api/device-task-batches` accepts changed Task batches with hash ACKs. Do not restore full Task payloads inside metadata snapshots.
- Do not expose Runtime `endpoint`, Runtime `capabilities`, Runtime/Agent `sourceRefs`, Agent `origin`, or Agent `load` in the product API/UI model. Adapter commands, external ids, raw evidence, and path details belong in adapter internals, diagnostics, logs, or DB raw fields.
- Runtime adapters may execute only when enabled by the current documented adapter allowlist and covered by harness. Disabled adapters must not execute commands, read local directories, or emit objects.
- Runtime adapters must emit every Task that meets the product standard. Adapter-level count or byte caps must not silently drop recognized Task data; volume control belongs to collector task batching, local ACK cache, and hash-based resend rules.
- Keep Runtime kind, Task adapter kind, and Channel kind separate in UI and query models. Runtime kinds include only implemented execution runtimes, adapter kinds include only implemented collectors, and Runs Channel filters are only implemented user-facing touchpoints such as DingTalk, Web Chat, or future detected message channels.
- Runs conversation task pages must stay task-context first: do not render unlinked runtime executions, listening status, capability gaps, adapter evidence, raw limitations, command names, or debugging notes as user-facing task cards. Current `/runs` always queries `taskType=conversation`; scheduled Task pages are deferred until their page spec and harness exist. If a platform cannot provide creator, assignee, group/channel, message excerpt, or execution state for a real work item, show a concise unsupported/unknown/user-facing fallback and keep details in logs/spec/harness. Do not display raw DingTalk `cid...`, phone numbers, open conversation ids, or other opaque external ids as conversation names. For DingTalk direct chats without a readable person name, show `DingTalk 私聊`; for groups without a readable name, show `DingTalk 群聊`. A real work item with no linked execution should say `未关联执行`, not `不支持采集`.
- Use the repository commit convention for all new commits: `type(scope): subject` or `type: subject`, with `type` in `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, `ci`, `perf`, `style`, or `revert`. Keep subjects concise and scannable; Chinese subjects are allowed when clearer. Run `npm run setup:git-hooks` once per checkout so `.githooks/commit-msg` blocks future untyped commits.

## Spec And Harness Workflow

Every non-trivial change should leave the repo easier for the next agent to operate.

Use this loop:

1. Read the relevant product source of truth before editing.
2. Update or add the smallest useful spec when behavior, scope, acceptance criteria, or non-goals change.
3. Add or update the narrowest harness that can prove the important behavior.
4. Implement against the spec and harness.
5. Run the relevant focused checks while iterating.
6. Run the full harness before handoff.

Current spec and harness mapping:

| Surface | Spec / Intent | Harness |
|---|---|---|
| Catalog Object model | `src/catalog/catalog-object.ts` | `src/catalog/catalog-query.test.ts`, `npm run check:quick` |
| Runtime device registration and `device_state` collector | `docs/product/runtime-device-registration-spec.md`, `docs/product/runtime-openclaw-adapter-spec.md`, `docs/product/runtime-slock-adapter-spec.md`, `docs/product/runtime-codex-adapter-spec.md`, `src/runtime/runtime-model.ts`, `src/runtime/runtime-task-sync.ts`, `scripts/lorume.mjs`, `scripts/lorume-runtime-adapters.mjs`, `scripts/lorume-device-collector.mjs`, `scripts/install-device-collector.sh` | `src/runtime/runtime-task-sync.test.ts`, `src/runtime/device-collector-script.test.ts`, `src/cli/lorume-cli.test.ts`, `e2e/runtime-backend-api.spec.ts`, `npm run check:cli`, `npm run check:runtime`, `npm run check:backend`, `npm run check:backend:e2e` |
| CLI device capability atoms | `docs/product/cli-device-capability-spec.md`, `scripts/lorume.mjs`, `scripts/lorume-runtime-adapters.mjs` | `src/cli/lorume-cli.test.ts`, `npm run check:cli`, `npm run check:runtime`, `npm run check:backend`, `npm run check:quick` |
| Agent Skill probing | `docs/product/agent-skill-probing-spec.md`, `src/runtime/agent-skill-probe.ts`, `src/server/runtime-http-api.ts`, `src/runtime/RuntimeFleetPage.tsx` | `src/runtime/agent-skill-probe.test.ts`, `src/server/runtime-http-api-skill-probe.test.ts`, `src/runtime/RuntimeFleetPage.skill-probe.test.tsx`, `e2e/runtime-fleet.spec.ts`, `npm run check:runtime`, `npm run check:backend`, `npm run check:quick`, `npm run check:e2e` |
| Runtime Task acceptance | `docs/product/runtime-task-acceptance-spec.md`, `docs/product/runtime-openclaw-adapter-spec.md`, `docs/product/runtime-slock-adapter-spec.md`, `docs/product/runtime-codex-adapter-spec.md`, `src/runtime/runtime-work-query-api.ts` | `src/runtime/runtime-work-query-api.test.ts`, `e2e/runtime-work-board.spec.ts`, `npm run check:quick`, `npm run check:e2e` |
| Runs conversation task page | `src/runtime/RuntimeWorkBoardPage.tsx`, `src/runtime/runtime-work-query-api.ts`, `src/runtime/runtime-data-source.ts`, `docs/product/runtime-task-acceptance-spec.md` | `src/App.test.tsx`, `src/runtime/runtime-work-query-api.test.ts`, `src/runtime/runtime-data-source.test.ts`, `e2e/runtime-work-board.spec.ts`, `npm run check:quick`, `npm run check:e2e` |
| Runtime Fleet page | `docs/product/runtime-fleet-page-spec.md`, `src/runtime/runtime-fleet-query.ts`, `src/runtime/runtime-collection-health.ts`, `src/runtime/RuntimeFleetPage.tsx` | `src/runtime/runtime-fleet-query.test.ts`, `src/runtime/runtime-collection-health.test.ts`, `src/App.test.tsx`, `e2e/runtime-fleet.spec.ts`, `npm run check:quick`, `npm run check:e2e` |
| Normalized errors and structured logs | `src/errors/error-catalog.ts`, `src/logging/structured-logger.ts`, `docs/product/backend-service-spec.md`, `docs/product/runtime-device-registration-spec.md` | `src/errors/error-catalog.test.ts`, `src/logging/structured-logger.test.ts`, `src/server/runtime-http-api.test.ts`, `src/runtime/device-collector-script.test.ts`, `npm run check:backend`, `npm run check:runtime`, `npm run check:quick` |
| Runtime snapshot and control backend | `docs/product/runtime-device-registration-spec.md`, `src/runtime/runtime-collection-health.ts`, `src/server/runtime-device-state-store.ts`, `src/server/runtime-control-channel.ts`, `src/server/runtime-http-api.ts`, `src/backend/backend-server.ts` | `src/runtime/runtime-collection-health.test.ts`, `src/server/runtime-device-state-store.test.ts`, `src/server/runtime-control-channel.test.ts`, `src/server/runtime-http-api.test.ts`, `src/runtime/device-collector-script.test.ts`, `e2e/runtime-backend-api.spec.ts`, `npm run check:backend`, `npm run check:backend:e2e` |
| Backend service formalization | `docs/product/backend-service-spec.md`, `src/backend/backend-server.ts`, `src/server/postgres-store.ts`, `db/schema.sql`, `scripts/db-setup.mjs`, `scripts/dev-e2e.ts`, `scripts/dev-backend-e2e.ts`, `scripts/smoke-production.mjs`, `vite.backend.config.ts`, `Dockerfile.backend`, `Dockerfile.frontend`, `nginx.lorume.conf`, `docker-compose.prod-like.yml` | `src/backend/backend-server.test.ts`, `src/backend/dev-e2e-config.test.ts`, `src/server/db-schema.test.ts`, `src/server/postgres-store.test.ts`, `src/server/runtime-http-api-postgres.test.ts`, `e2e/runtime-backend-api.spec.ts`, `scripts/check-deploy-config.mjs`, `npm run check:backend:standalone`, `npm run check:db`, `npm run check:backend`, `npm run check:backend:e2e`, `npm run check:deploy`, `npm run smoke:production` |
| SSH deployment and real-device operations | `docs/operations/ssh-deployment.md`, `docs/product/backend-service-spec.md`, `docs/product/runtime-device-registration-spec.md`, `scripts/smoke-production.mjs`, `scripts/install-device-collector.sh` | `npm run check:repo`, `npm run check:deploy`, `npm run smoke:production` |
| Auth and access | `docs/product/auth-and-access-spec.md`, `src/auth/`, `db/schema.sql` | `src/auth/auth-crypto.test.ts`, `src/auth/auth-store.test.ts`, `src/auth/auth-http-api.test.ts`, `src/server/runtime-http-api.test.ts`, `npm run check:backend`, `npm run check:db`, `npm run check:quick` |
| Operation and Job Runner persistence/API | `docs/product/operation-job-runner-spec.md`, `db/schema.sql`, `src/operations/operation-store.ts`, `src/operations/operation-http-api.ts`, `src/operations/job-runner.ts` | `src/operations/operation-store.test.ts`, `src/operations/operation-http-api.test.ts`, `src/operations/job-runner.test.ts`, `src/backend/backend-server.test.ts`, `src/server/db-schema.test.ts`, `npm run check:backend`, `npm run check:db` |
| Notification persistence, dedupe, runtime ingestion alerts, Agent Skill probe lifecycle, and in-app API | `docs/product/notification-spec.md`, `db/schema.sql`, `src/notifications/notification-store.ts`, `src/notifications/notification-http-api.ts`, `src/operations/job-runner.ts`, `src/server/runtime-http-api.ts` | `src/notifications/notification-store.test.ts`, `src/notifications/notification-http-api.test.ts`, `src/server/runtime-http-api-postgres.test.ts`, `src/operations/job-runner.test.ts`, `src/backend/backend-server.test.ts`, `src/server/db-schema.test.ts`, `npm run check:backend`, `npm run check:db` |
| Operations utility drawer | `docs/product/operation-job-runner-spec.md`, `src/console/ConsoleUtilityDrawer.tsx`, `src/App.tsx` | `src/console/ConsoleUtilityDrawer.test.tsx`, `src/App.test.tsx`, `npm run check:quick` |
| Notifications utility drawer | `docs/product/notification-spec.md`, `src/console/ConsoleUtilityDrawer.tsx`, `src/App.tsx`, `src/notifications/notification-http-api.ts` | `src/console/ConsoleUtilityDrawer.test.tsx`, `src/App.test.tsx`, `src/notifications/notification-http-api.test.ts`, `src/notifications/notification-store.test.ts`, `npm run check:quick`, `npm run check:backend`, `npm run check:db` |
| Organization Settings page | `docs/product/auth-and-access-spec.md`, `src/settings/OrganizationSettingsPage.tsx`, `src/App.tsx` | `src/settings/OrganizationSettingsPage.test.tsx`, `src/App.test.tsx`, `npm run check:quick` |
| Public entry, routing, and navigation | `src/HomePage.tsx`, `src/App.tsx`, `docs/product/ui-design.md` | `src/App.test.tsx`, `npm run check:quick`, `npm run check:e2e` |
| shadcn/ui design system | `docs/product/design/`, `components.json`, `src/index.css`, `src/components/ui/`, `src/lib/utils.ts` | `src/components/ui/shadcn-smoke.test.tsx`, `src/App.test.tsx`, `e2e/runtime-fleet.spec.ts`, `e2e/runtime-work-board.spec.ts`, `npm run check:repo`, `npm run check:quick`, `npm run check:e2e` |
| Self-review workflow | `docs/operations/self-review.md`, `AGENTS.md`, `docs/product/design/review-and-harness.md` | `npm run check:repo`, plus the narrowest harness for the reviewed surface |
| Commit message convention | `.githooks/commit-msg`, `scripts/check-commit-message.mjs`, `scripts/check-commit-message.test.mjs` | `npm run check:commit-message`, `npm run setup:git-hooks` |
| Repo context and docs | `AGENTS.md`, `README.md`, `docs/product/ui-design.md`, `docs/product/design/`, `docs/product/auth-and-access-spec.md`, `docs/product/cli-device-capability-spec.md`, `docs/product/agent-skill-probing-spec.md`, `docs/product/operation-job-runner-spec.md`, `docs/product/notification-spec.md`, `docs/operations/` | `npm run check:repo` |

When a user points out a missed behavior or review gap, decide whether it should become:

- Context: durable agent rule in this file.
- Spec: acceptance criteria or non-goal in a product spec.
- Harness: executable check in unit, component, browser, contract, or future runtime tests.

For UI work, read `docs/product/ui-design.md` for product intent, then read `docs/product/design/README.md` and the relevant design spec files before editing. UI changes that alter visual language, token usage, component behavior, content terminology, page patterns, or review expectations must update `docs/product/design/` in the same change.

## Test Layout

Keep the test layout simple and tied to what each harness can prove:

- Put pure logic tests next to the source they verify, for example `src/catalog/catalog-query.test.ts`.
- Put React component and jsdom interaction tests near the component surface, for example `src/App.test.tsx`.
- Keep shared Vitest / Testing Library setup in `src/test/setup.ts`.
- Put real-browser Playwright specs in `e2e/`. Use this for user workflows, responsive layout, browser rendering, and behavior jsdom cannot prove.
- Keep Playwright server state isolated from manual dev/acceptance state. The default e2e web server uses `scripts/dev-e2e.ts`, an isolated `lorume_e2e` Postgres database, the standalone backend, and a Vite proxy so test fixture posts do not overwrite manual review data. Backend API-only e2e uses `scripts/dev-backend-e2e.ts` and the isolated `lorume_backend_e2e` Postgres database.
- Keep auth harnesses and Console harnesses separated. `check:e2e` sets `VITE_LORUME_APP_MODE=agent` so Runtime Fleet and Runs browser tests validate the Console directly; auth entry, email-code login, organization creation, and invitation flows are covered by `src/auth/*` component/API/backend tests.
- Prefer adding the smallest focused test that captures the important behavior. Do not create broad `tests/`, `specs/`, or `harnesses/` directories until the project has enough surfaces to justify them.

## Agent-Ready Growth

Lorume should become agent-ready by growing only the infrastructure the project actually needs. The current layer is **Runtime Fleet + Agent Skill Probing + Runs Task Board + Operations / Notifications + Production-Like Backend Harness Ready** for the first frontend/runtime surfaces: root guide, TinySpecs, TypeScript object models, standalone backend, Postgres-backed query APIs, backend bundle and Docker/Nginx config checks, outbound device control channel, collector snapshot harnesses, unit/component tests, browser layout harness, and one full verification entry point.

Extend this guide and `./scripts/verify.sh` only when a real project surface appears:

- Frontend code: add frontend commands and checks; keep browser layout checks in Playwright when jsdom cannot prove behavior.
- Backend service: add API, schema and contract checks.
- Catalog object models: document the schema source of truth and generated-file policy if any.
- Runtime / Execution Fabric: add worker setup, collector registration, runtime adapter, sandbox, queue, health-check, and artifact rules.
- PR or release flow: add the smallest useful gates for owner review, approval boundary, audit evidence, and rollback notes.

Do not add empty `specs/`, `evals/`, `harnesses/`, service directories, heavyweight spec frameworks, or generic agent platform rules before Lorume has a Lorume-specific need.

## Verification

Run the full repository harness before handing off changes:

```sh
./scripts/verify.sh
```

Equivalent package entry points are `npm run verify`, `npm run check`, and `npm run harness`. If the local agent runtime has Node but no `npm` binary, `./scripts/verify.sh` falls back to `scripts/run-package-script.mjs` so the same harness still runs. The full harness verifies required product documents/assets, local Markdown links, Postgres schema checks, backend store/control/API checks, backend API-only E2E, backend bundle and deploy config checks, collector script behavior, TypeScript typecheck, unit/component tests, production build, and the Playwright responsive layout harness.

If the local Playwright browser is missing, install the current test browser once:

```sh
npm run setup:e2e
```

Current harness scripts:

| Script | Purpose | Run When |
|---|---|---|
| `npm run setup:e2e` | Install the current Playwright Chromium browser. | Once per local machine, or when Playwright asks for browser installation. |
| `npm run setup:git-hooks` | Point Git at `.githooks/` so commit messages are checked locally. | Once per checkout, before making local commits. |
| `npm run db:up` | Start local Postgres through Docker Compose. | Before local backend DB development or manual schema checks. |
| `npm run db:setup` | Apply the current Postgres schema baseline to `DATABASE_URL`, defaulting to local compose Postgres. | Schema changes, local DB setup, or backend service development. |
| `npm run check:commit-message` | Unit-check the commit message validator used by `.githooks/commit-msg`. | Commit convention, git hook, repo workflow, or package script changes. |
| `npm run check:cli` | Deterministic local `lorume` CLI command and safety checks. | CLI command contract, file-copy safety, connector context, or package `bin` changes. |
| `npm run check:repo` | Required source-of-truth paths and local Markdown links. | Docs, assets, agent context, or product spec changes. |
| `npm run check:backend:standalone` | Standalone backend HTTP and WebSocket smoke tests. | Backend server composition, local backend entrypoint, or server lifecycle changes. |
| `npm run check:backend:e2e` | Playwright API-only backend harness using isolated Postgres, authenticated user APIs, installer assets, device-token collector ingestion, real collector-process upload, backend query APIs, and heartbeat-only device WebSocket. | Backend auth/API contracts, device registration token flow, installer command assets, collector ingestion/query wiring, or device WebSocket connection-health changes. |
| `npm run check:db` | Starts local Postgres, runs schema/repository integration tests against temporary databases, and drops them. | Database schema, schema setup runner, Postgres repository, Docker Compose, or Postgres dependency changes. |
| `npm run check:backend` | Focused local backend store, control channel, HTTP API, Agent Skill probe API, and collector POST / WebSocket harness. | Runtime snapshot API, backend API handler, Agent Skill probe snapshot paths, collector posting, device WebSocket heartbeat lifecycle, or backend persistence changes. |
| `npm run check:runtime` | Focused Runtime / Device Registration and `device_state` unit/script harness. | Device / Runtime / Agent / Task model, collector, installer, fixture, OpenClaw adapter, or query changes. |
| `npm run check:quick` | TypeScript typecheck plus Vitest unit/component tests. | Catalog model, Runtime Fleet query logic, React behavior, labels, or seed data changes. |
| `npm run check:build` | Production TypeScript/Vite build. | Frontend, dependency, Vite, TypeScript, or package changes. |
| `npm run build:backend` | Bundle the standalone backend to `dist/backend/backend-server.mjs`. | Backend entrypoint, server imports, or production-like runtime changes. |
| `npm run start:backend` | Run the bundled backend artifact. | Manual smoke of production-like backend output after `npm run build:backend`. |
| `npm run check:deploy` | Build backend bundle and verify Docker / Nginx / production-like compose config. | Deployment-shape, backend bundle, Dockerfile, compose, or Nginx changes. |
| `npm run smoke:production` | Check deployed public health/readiness and installer resources; add `LORUME_SMOKE_COOKIE` or `LORUME_SMOKE_BEARER_TOKEN` to also check authenticated Runtime Fleet, Runs, collection-health, and diagnostics read paths. | After ECS deploy, DNS/Nginx changes, backend query changes, or collector registration changes. |
| `npm run check:e2e` | Playwright browser harness using isolated Postgres, standalone backend, Vite proxy, and agent-mode auth for Console surfaces. | Runtime Fleet/Runs interaction paths, layout, toolbar, responsive behavior, navigation shell, backend query wiring, or visual regression risk. |
| `npm run verify` | Full harness, same as `./scripts/verify.sh`. | Before handoff, commit, or review. |

Current remote deployment and `gezilinll-claw` real-device collector update commands live in [docs/operations/ssh-deployment.md](docs/operations/ssh-deployment.md). Keep SSH targets, tokens, cookies, bearer tokens, keys, and raw production logs out of committed files and final reports.

Local frontend development:

```sh
npm install
npm run setup:e2e
npm run db:up
npm run db:setup
```

Then run these in separate terminals:

```sh
npm run dev:backend
npm run dev
```

Local backend development:

```sh
npm run db:up
npm run db:setup
npm run dev:backend
```

Production-like local smoke before ECS:

```sh
npm run check:deploy
docker compose -f docker-compose.prod-like.yml up --build
```

## Change Hygiene

- Prefer focused commits: product docs, object model, frontend, backend, runtime, and verification changes should be easy to review independently.
- Commit messages must follow the Lorume convention enforced by `.githooks/commit-msg`: `type(scope): subject` or `type: subject`; avoid untyped subjects like `Add runtime API`.
- Before committing, check `git status --short` and make sure there are no unrelated user changes mixed in.
- If adding generated output later, document the source command and avoid hand-editing generated files.
- Do not claim completion until the relevant harness has passed and the final answer names what was verified.
