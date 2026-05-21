# Device Install Health Diagnostics Implementation Plan

> Current-rule version. Lorume has no historical users, so this plan does not keep old `inventory` / `work_state` compatibility paths.

**Goal:** Make Lorume's device installer contract, Device status rules, and collector diagnostics locally repeatable without touching production backend state.

**Architecture:** Treat repository-local installer files as the source of truth. Automated tests run only against local handlers, temporary install directories, and isolated local backend/Postgres instances. Public domain reachability is deployment/operations validation, not a project harness condition. Device status is derived from connection freshness plus `device_state` ingestion health, while collector diagnostics stay lightweight through structured local logs and backend ingestion/diagnostic APIs.

## Non-Negotiable Rules

| Rule | Meaning |
|---|---|
| No production mutation in tests | Automated tests and harnesses must never create production device tokens, write production backend data, truncate production tables, or depend on a deployed domain such as `claw.gezilinll.com`. |
| Local source of truth | Installer tests read repository-local relative paths and compare local source content to local installed content. A deployed HTTP response is never evidence that local installer files are current. |
| Domain checks are ops checks | `claw.gezilinll.com` or future `lorume.com` reachability can be recorded in deployment runbooks, but it must not be a required project test. |
| Device status is independent | Device status must not be derived from Runtime, Agent, or Task state. |
| Control channel stays control-only | WebSocket remains `hello` and `heartbeat` only. Backend must not trigger collection, Agent Skill probes, task execution, or arbitrary commands. |
| Current snapshot only | `device_state` is the only collector snapshot kind. Old `inventory` / `work_state` commands, endpoints, tables, and fallback reads are removed. |
| Secrets stay out | Device tokens, session tokens, login codes, Slock keys, bearer tokens, and production DB URLs must not be committed, logged, snapshotted, or printed in final summaries. |

## Device Status Contract

User-visible Device statuses are exactly:

| Status | Label | Rule |
|---|---|---|
| `syncing` | `同步中` | No successful `device_state` report exists yet, and there is no explicit error. A fresh connection inside the first sync window also stays here. |
| `online` | `在线` | Latest heartbeat is fresh and latest `device_state` report succeeded within the freshness window. |
| `offline` | `离线` | At least one `device_state` report succeeded before, but heartbeat or report freshness has expired, and there is no newer explicit error. |
| `abnormal` | `异常` | Token rejection, malformed payload, backend DB write failure, latest `device_state` failure, or a fresh connection that exceeded the first sync window without any successful `device_state` report. |

Initial policy constants:

| Constant | Value |
|---|---:|
| First sync window | `120_000ms` |
| Heartbeat freshness | `90_000ms` |
| Device-state freshness | `300_000ms` |

Internal reason codes are allowed for diagnostics, but UI surfaces only the four labels above.

## File Map

| File | Responsibility |
|---|---|
| `AGENTS.md` | Durable agent rules for local-only harnesses, installer contract testing, production mutation red lines, and current-only runtime model rules. |
| `docs/product/runtime-device-registration-spec.md` | Product source of truth for installer manifest, local-path installer harness, Device four-state contract, collector diagnostics, and `device_state` snapshot semantics. |
| `docs/product/backend-service-spec.md` | Backend source of truth for local-only backend E2E, diagnostics API, current-only ingestion, and production smoke boundaries. |
| `src/backend/device-installer-manifest.ts` | Exported manifest of device package files using repository-relative paths. |
| `src/backend/device-installer-http-api.ts` | Serve installer package files from the shared manifest and generate bootstrap script from the same manifest. |
| `src/backend/backend-server.test.ts` | Backend handler contract for manifest files and local file content. |
| `src/runtime/device-collector-script.test.ts` | Local installer script contract: local source files install into a temporary directory with matching content and expected config. |
| `scripts/install-device-collector.sh` | Local-path installer implementation using repo-relative source files under `--source-dir`. |
| `src/runtime/runtime-device-health.ts` | Pure Device status and diagnostics derivation module. |
| `src/runtime/runtime-device-health.test.ts` | Unit tests for `syncing`, `online`, `offline`, `abnormal`, thresholds, and reason codes. |
| `src/runtime/runtime-collection-health.ts` | Per-`device_state` collection health derived from collector ingestion records. |
| `src/server/runtime-device-state-store.ts` | Current local snapshot validation/store for `Device / Runtime / Agent / Task`. |
| `src/server/postgres-store.ts` | Current Postgres persistence for `devices`, `runtimes`, `agents`, `tasks`, and `collector_ingestions`. |
| `src/server/runtime-http-api.ts` | Current `device_state` ingestion, Runtime Fleet / Task query APIs, Device diagnostics, and heartbeat-only WebSocket composition. |
| `src/server/runtime-http-api-postgres.test.ts` | API tests for current ingestion/query/diagnostics in isolated local Postgres and negative tests for removed legacy APIs. |
| `scripts/lorume-device-collector.mjs` | Device-side collector with local diagnostics and `POST /api/device-state-snapshots`. |
| `src/runtime/runtime-fleet-query.ts` | Runtime Fleet query model consuming Device status labels without mixing Runtime/Agent state. |
| `src/runtime/runtime-fleet-query.test.ts` | UI query tests for Device status mapping and hidden internal fields. |
| `src/App.test.tsx` | Component-level smoke for Runtime Fleet and Runs behavior. |
| `e2e/runtime-backend-api.spec.ts` | Local backend API-only E2E with a real collector process against isolated local backend/Postgres. |
| `scripts/smoke-production.mjs` | Non-mutating production health/read smoke only. |

## Test Pyramid

| Layer | What It Proves |
|---|---|
| Unit | Device status derivation, collection-health derivation, Runtime Fleet query shaping, current-only CLI command behavior. |
| Script/contract | Installer installs repository-local files, uninstall removes declared artifacts, collector logs diagnostics without secrets, old collector modes are rejected. |
| Backend API | `POST /api/device-state-snapshots`, `GET /api/runtime-fleet`, `GET /api/runtime-tasks`, diagnostics, and removed legacy API 404 behavior. |
| DB integration | Current migrations create/use only `devices`, `runtimes`, `agents`, `tasks`, and `collector_ingestions`; cleanup migration drops old work-state tables/columns. |
| Backend E2E | Isolated local backend/Postgres accepts a real collector-process `device_state` upload and exposes current query APIs. |
| Browser E2E | Runtime Fleet and Runs render the current four-object model without legacy snapshot fallback. |

## Acceptance

- `lorume collect device-state --json` is the only supported collection command.
- Collector posts only `/api/device-state-snapshots`.
- Backend persists only the current four-object model plus ingestion records.
- Runtime Fleet reads `/api/runtime-fleet`.
- Runs reads `/api/runtime-tasks`.
- Legacy routes and commands are rejected, not silently converted.
- `./scripts/verify.sh` passes after implementation.
