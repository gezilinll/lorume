# Device Install Health Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lorume's device installer contract, Device status rules, and collector diagnostics locally repeatable without touching production backend state.

**Architecture:** Treat the repository-local installer manifest and source files as the source of truth. Automated tests run only against local handlers, temporary install directories, and isolated local backend/Postgres instances; public domain reachability is deployment/operations validation and never a project harness pass condition. Device status is derived from connection freshness plus inventory ingestion health, while collector diagnostics stay lightweight through structured local logs and backend ingestion/diagnostic APIs.

**Tech Stack:** TypeScript backend/runtime modules, Bash installer, Node.js collector scripts, Vitest unit/script/API tests, Playwright backend API-only E2E, isolated local Postgres, existing Runtime Fleet React query model.

---

## Non-Negotiable Rules

| Rule | Meaning |
|---|---|
| No production mutation in tests | Automated tests and harnesses must never create production device tokens, write production backend data, truncate production tables, or depend on a deployed domain such as `claw.gezilinll.com`. |
| Local source of truth | Installer tests read repository-local relative paths and compare local source content to local installed content. A deployed HTTP response is never evidence that local installer files are current. |
| Domain checks are ops checks | `claw.gezilinll.com` or future `lorume.com` reachability can be recorded in deployment runbooks, but it must not be a required project test. |
| Device status is independent | Device status must not be derived from Runtime or Agent work state. Device, Runtime, and Agent health remain separate concepts. |
| Control channel stays control-only | WebSocket remains `hello` and `heartbeat` only. Backend must not trigger `inventory.refresh`, `agent.skill_probe`, task execution, or arbitrary commands. |
| Secrets stay out | Device tokens, session tokens, login codes, Slock keys, bearer tokens, and production DB URLs must not be committed, logged, snapshotted, or printed in final summaries. |

## Device Status Contract

User-visible Device statuses are exactly:

| Status | Label | Rule |
|---|---|---|
| `syncing` | `同步中` | No successful inventory exists yet, and there is no explicit error. A fresh connection inside the first sync window also stays here. |
| `online` | `在线` | Latest heartbeat is fresh and latest inventory succeeded within the inventory freshness window. |
| `offline` | `离线` | At least one inventory succeeded before, but heartbeat or inventory freshness has expired, and there is no newer explicit error. |
| `abnormal` | `异常` | Token rejection, malformed payload, backend DB write failure, latest inventory failure, or a fresh connection that has exceeded the first sync window without any successful inventory. |

Initial policy constants:

| Constant | Value |
|---|---:|
| First sync window | `120_000ms` |
| Heartbeat freshness | `90_000ms` |
| Inventory freshness | `300_000ms` |

Internal reason codes are allowed for diagnostics, but UI surfaces only the four labels above.

## File Map

| File | Responsibility |
|---|---|
| `AGENTS.md` | Durable agent rules for local-only harnesses, installer contract testing, and production mutation red lines. |
| `docs/product/runtime-device-registration-spec.md` | Product source of truth for installer manifest, local-path installer harness, Device four-state contract, and collector diagnostics. |
| `docs/product/backend-service-spec.md` | Backend source of truth for local-only backend E2E, diagnostics API, and production smoke boundaries. |
| `src/backend/device-installer-manifest.ts` | New exported manifest of device package files using repository-relative paths. |
| `src/backend/device-installer-http-api.ts` | Serve installer package files from the shared manifest and generate bootstrap script from the same manifest. |
| `src/backend/backend-server.test.ts` | Backend handler contract for manifest files and local file content. |
| `src/runtime/device-collector-script.test.ts` | Local installer script contract: local source files install into a temporary directory with matching content and expected config. |
| `scripts/install-device-collector.sh` | Local-path installer implementation using repo-relative source files under `--source-dir`. |
| `src/runtime/runtime-device-health.ts` | New pure Device status and diagnostics derivation module. |
| `src/runtime/runtime-device-health.test.ts` | Unit tests for `syncing`, `online`, `offline`, `abnormal`, thresholds, and reason codes. |
| `src/runtime/runtime-collection-health.ts` | Keep per-snapshot collection health unchanged; Device four-state status lives in `runtime-device-health.ts`. |
| `src/server/runtime-inventory-store.ts` | Connection freshness input for Device status derivation. |
| `src/server/postgres-store.ts` | Existing `listCollectorIngestions` repository method provides diagnostics input. |
| `src/server/runtime-http-api.ts` | Add or extend Device diagnostics API without creating production mutation paths. |
| `src/server/runtime-http-api-postgres.test.ts` | API tests for diagnostics in isolated local Postgres. |
| `scripts/lorume-device-collector.mjs` | Lightweight structured collector diagnostic events with secret redaction. |
| `src/runtime/runtime-inventory-query.ts` | Runtime Fleet query model consumes Device status labels without mixing Runtime/Agent status. |
| `src/runtime/runtime-inventory-query.test.ts` | UI query tests for Device status mapping. |
| `src/App.test.tsx` | Component-level smoke for Runtime Fleet status labels if the page renders them directly. |
| `e2e/runtime-backend-api.spec.ts` | Local backend API-only E2E; may validate diagnostics with a real collector process against isolated local backend/Postgres. |
| `scripts/smoke-production.mjs` | Keep as non-mutating production health/read smoke; do not add token creation or install-chain mutation. |

---

## Task 1: Solidify Rules In Specs And Agent Guide

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/product/runtime-device-registration-spec.md`
- Modify: `docs/product/backend-service-spec.md`

- [ ] **Step 1: Add test red lines to `AGENTS.md` Working Rules**

Add these bullets under `## Working Rules`:

```markdown
- Automated tests, harnesses, and smoke scripts must never mutate the real production backend or production database. Device token creation, collector ingestion, table cleanup, and installer execution tests must target local isolated backend/Postgres instances and temporary install directories only.
- Public domain reachability such as `claw.gezilinll.com` or `lorume.com` is deployment/operations validation. Do not make deployed domain availability, ICP/TLS state, or production installer reachability a required project harness condition.
- Installer contract tests must use repository-local relative paths as the source of truth. They may verify that the local backend handler serves those files, but installation integrity must compare local source files with local temporary install results instead of trusting deployed HTTP content.
```

- [ ] **Step 2: Update `docs/product/runtime-device-registration-spec.md` installer contract**

In the installer/API section, add:

```markdown
Installer package files are declared by repository-relative paths. The current package manifest is:

| Package file | Repository source |
|---|---|
| `install-device-collector.sh` | `scripts/install-device-collector.sh` |
| `lorume-device-collector.mjs` | `scripts/lorume-device-collector.mjs` |
| `lorume-runtime-adapters.mjs` | `scripts/lorume-runtime-adapters.mjs` |
| `lorume.mjs` | `scripts/lorume.mjs` |

Automated installer tests must run from local source paths and temporary install directories. They must prove that the manifest paths exist, that installed runtime files match the repository source content, and that config is written without legacy fields. They must not use a deployed domain as the source of truth.
```

- [ ] **Step 3: Add Device four-state contract to `docs/product/runtime-device-registration-spec.md`**

Add this under the WebSocket/control-plane or collection status section:

```markdown
Device has exactly four user-visible status labels: `同步中`, `在线`, `离线`, and `异常`.

- `同步中`: no successful inventory exists yet and no explicit error exists.
- `在线`: heartbeat is fresh and the latest inventory succeeded within the freshness window.
- `离线`: at least one inventory succeeded before, but heartbeat or inventory freshness expired, and no newer explicit error exists.
- `异常`: token rejection, malformed payload, backend write failure, latest inventory failure, or a fresh connection that exceeded the first sync window without a successful inventory.

Device status must be derived independently from Runtime and Agent status.
```

- [ ] **Step 4: Update `docs/product/backend-service-spec.md` harness boundary**

Replace or qualify the production smoke harness bullet so it reads:

```markdown
- production smoke harness: `npm run smoke:production` is non-mutating and may check deployed `/healthz`, `/readyz`, authenticated read APIs, and collection-health reads. It must not create device tokens, run installer flows, post collector snapshots, or write production data.
- backend API-only E2E harness: local isolated Postgres plus local backend validates device token creation, installer assets, real collector-process upload, Device diagnostics, query APIs, and heartbeat-only WebSocket.
```

- [ ] **Step 5: Run documentation guard**

Run:

```bash
npm run check:repo
```

Expected output includes:

```text
check:repo: ok
```

- [ ] **Step 6: Commit specs and guide**

```bash
git add AGENTS.md docs/product/runtime-device-registration-spec.md docs/product/backend-service-spec.md
git commit -m "docs(runtime): clarify local device installer test boundaries"
```

---

## Task 2: Introduce A Shared Local Installer Manifest

**Files:**
- Create: `src/backend/device-installer-manifest.ts`
- Modify: `src/backend/device-installer-http-api.ts`
- Modify: `src/backend/backend-server.test.ts`

- [ ] **Step 1: Write the failing backend manifest test**

Add this to `src/backend/backend-server.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  deviceInstallerPackageManifest,
  deviceInstallerRuntimeFiles,
} from "./device-installer-manifest";

const repoRoot = process.cwd();

it("keeps installer manifest paths repository-relative and present", () => {
  expect(deviceInstallerPackageManifest.map((entry) => entry.fileName)).toEqual([
    "install-device-collector.sh",
    "lorume-device-collector.mjs",
    "lorume-runtime-adapters.mjs",
    "lorume.mjs",
  ]);
  for (const entry of deviceInstallerPackageManifest) {
    expect(path.isAbsolute(entry.sourcePath)).toBe(false);
    expect(readFileSync(path.join(repoRoot, entry.sourcePath), "utf8").length).toBeGreaterThan(0);
  }
  expect(deviceInstallerRuntimeFiles.map((entry) => entry.fileName)).toEqual([
    "lorume-device-collector.mjs",
    "lorume-runtime-adapters.mjs",
    "lorume.mjs",
  ]);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npx vitest run src/backend/backend-server.test.ts -t "installer manifest"
```

Expected: fails because `src/backend/device-installer-manifest.ts` does not exist yet.

- [ ] **Step 3: Create `src/backend/device-installer-manifest.ts`**

```ts
export interface DeviceInstallerPackageFile {
  fileName: string;
  sourcePath: string;
  contentType: string;
}

export interface DeviceInstallerRuntimeFile {
  fileName: string;
  sourcePath: string;
  mode: "0755" | "0644";
}

export const deviceInstallerPackageManifest = [
  {
    fileName: "install-device-collector.sh",
    sourcePath: "scripts/install-device-collector.sh",
    contentType: "text/x-shellscript; charset=utf-8",
  },
  {
    fileName: "lorume-device-collector.mjs",
    sourcePath: "scripts/lorume-device-collector.mjs",
    contentType: "text/javascript; charset=utf-8",
  },
  {
    fileName: "lorume-runtime-adapters.mjs",
    sourcePath: "scripts/lorume-runtime-adapters.mjs",
    contentType: "text/javascript; charset=utf-8",
  },
  {
    fileName: "lorume.mjs",
    sourcePath: "scripts/lorume.mjs",
    contentType: "text/javascript; charset=utf-8",
  },
] as const satisfies readonly DeviceInstallerPackageFile[];

export const deviceInstallerRuntimeFiles = [
  {
    fileName: "lorume-device-collector.mjs",
    sourcePath: "scripts/lorume-device-collector.mjs",
    mode: "0755",
  },
  {
    fileName: "lorume-runtime-adapters.mjs",
    sourcePath: "scripts/lorume-runtime-adapters.mjs",
    mode: "0644",
  },
  {
    fileName: "lorume.mjs",
    sourcePath: "scripts/lorume.mjs",
    mode: "0755",
  },
] as const satisfies readonly DeviceInstallerRuntimeFile[];

export function findDeviceInstallerPackageFile(fileName: string): DeviceInstallerPackageFile | undefined {
  return deviceInstallerPackageManifest.find((entry) => entry.fileName === fileName);
}
```

- [ ] **Step 4: Update `src/backend/device-installer-http-api.ts` to use the manifest**

Replace the local `installerFiles` object with:

```ts
import {
  deviceInstallerPackageManifest,
  findDeviceInstallerPackageFile,
} from "./device-installer-manifest";
```

Use the manifest in the file route:

```ts
const file = findDeviceInstallerPackageFile(fileName);
if (!file) {
  sendText(response, 404, "text/plain; charset=utf-8", "not found");
  return;
}

try {
  const body = await readFile(path.join(process.cwd(), file.sourcePath), "utf8");
  sendText(response, 200, file.contentType, body);
} catch {
  sendText(response, 404, "text/plain; charset=utf-8", "not found");
}
```

Generate bootstrap download lines from the manifest:

```ts
function remoteInstallerScript(): string {
  const downloads = deviceInstallerPackageManifest
    .map((file) => `download "${file.fileName}"`)
    .join("\n");

  return `#!/usr/bin/env bash
set -euo pipefail

SERVER_URL=""
for ((index = 1; index <= $#; index++)); do
  if [[ "\${!index}" == "--server-url" ]]; then
    next_index=$((index + 1))
    if [[ $next_index -le $# ]]; then
      SERVER_URL="\${!next_index}"
    fi
  fi
done

if [[ -z "$SERVER_URL" ]]; then
  echo "--server-url is required" >&2
  exit 1
fi

BASE_URL="\${SERVER_URL%/}"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

download() {
  local name="$1"
  local output="$TMP_DIR/scripts/$name"
  mkdir -p "$TMP_DIR/scripts"
  curl -fsSL "$BASE_URL/api/device-collector/files/$name" -o "$output"
}

${downloads}

chmod 0755 "$TMP_DIR/scripts/install-device-collector.sh"
bash "$TMP_DIR/scripts/install-device-collector.sh" --source-dir "$TMP_DIR" "$@"
`;
}
```

- [ ] **Step 5: Run focused backend manifest test**

```bash
npx vitest run src/backend/backend-server.test.ts -t "installer manifest|installer bundle"
```

Expected: tests pass and installer endpoint still serves only the manifest files.

- [ ] **Step 6: Commit manifest changes**

```bash
git add src/backend/device-installer-manifest.ts src/backend/device-installer-http-api.ts src/backend/backend-server.test.ts
git commit -m "test(runtime): define local device installer manifest"
```

---

## Task 3: Prove Local Installer Output Matches Local Manifest

**Files:**
- Modify: `src/runtime/device-collector-script.test.ts`
- Read: `scripts/install-device-collector.sh`

- [ ] **Step 1: Write the failing local installer integrity test**

Add imports:

```ts
import { statSync } from "node:fs";
import { deviceInstallerRuntimeFiles } from "../backend/device-installer-manifest";
```

Add this test near the existing installer tests:

```ts
it("installs runtime files from local manifest paths with matching content", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "lorume-local-installer-home-"));
  const installDir = path.join(homeDir, "collector");

  try {
    execFileSync("bash", [
      installerScript,
      "--source-dir",
      repoRoot,
      "--install-dir",
      installDir,
      "--server-url",
      "http://127.0.0.1:4184",
      "--device-id",
      "manifest-device",
      "--device-token",
      "local-test-token",
      "--interval-ms",
      "60000",
      "--no-service",
    ], { encoding: "utf8", env: { ...process.env, HOME: homeDir } });

    for (const file of deviceInstallerRuntimeFiles) {
      const source = readFileSync(path.join(repoRoot, file.sourcePath), "utf8");
      const installedPath = path.join(installDir, file.fileName);
      expect(readFileSync(installedPath, "utf8")).toBe(source);
      const mode = (statSync(installedPath).mode & 0o777).toString(8);
      expect(mode).toBe(file.mode);
    }

    const config = JSON.parse(readFileSync(path.join(installDir, "config.json"), "utf8"));
    expect(config).toMatchObject({
      installDir,
      serverUrl: "http://127.0.0.1:4184",
      deviceId: "manifest-device",
      intervalMs: 60000,
    });
    expect(config.deviceToken).toBe("local-test-token");
    expect(config).not.toHaveProperty("deviceName");
    expect(config).not.toHaveProperty("name");
    expect(config).not.toHaveProperty("connectionMode");
  } finally {
    rmSync(homeDir, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run the focused test**

```bash
npx vitest run src/runtime/device-collector-script.test.ts -t "local manifest paths"
```

Expected: passes if current installer already installs the exact local source files; otherwise fails with the mismatched file or mode.

- [ ] **Step 3: Keep installer implementation aligned with expected source commands**

If Step 2 reports a mismatch, update `scripts/install-device-collector.sh` so these commands remain the source of truth:

```bash
SOURCE_COLLECTOR="$SOURCE_DIR/scripts/lorume-device-collector.mjs"
SOURCE_RUNTIME_ADAPTERS="$SOURCE_DIR/scripts/lorume-runtime-adapters.mjs"
SOURCE_CLI="$SOURCE_DIR/scripts/lorume.mjs"

install -m 0755 "$SOURCE_COLLECTOR" "$INSTALL_DIR/lorume-device-collector.mjs"
install -m 0755 "$SOURCE_CLI" "$INSTALL_DIR/lorume.mjs"
install -m 0644 "$SOURCE_RUNTIME_ADAPTERS" "$INSTALL_DIR/lorume-runtime-adapters.mjs"
```

- [ ] **Step 4: Run installer script checks**

```bash
npx vitest run src/runtime/device-collector-script.test.ts -t "installs runtime files|installs the collector|posts during installer once mode|uninstalls the collector|stops the collector"
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit installer integrity coverage**

```bash
git add src/runtime/device-collector-script.test.ts scripts/install-device-collector.sh
git commit -m "test(runtime): verify local collector install artifacts"
```

---

## Task 4: Add Pure Device Four-State Derivation

**Files:**
- Create: `src/runtime/runtime-device-health.ts`
- Create: `src/runtime/runtime-device-health.test.ts`
- Read: `src/runtime/runtime-collection-health.ts`

- [ ] **Step 1: Write failing unit tests for all four statuses**

Create `src/runtime/runtime-device-health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveDeviceHealthStatus } from "./runtime-device-health";

const now = new Date("2026-05-21T09:00:00.000Z");

describe("deriveDeviceHealthStatus", () => {
  it("returns syncing before the first successful inventory when no explicit error exists", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:59:30.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
      },
      inventoryIngestions: [],
    })).toMatchObject({
      status: "syncing",
      label: "同步中",
      reason: "first_sync_pending",
    });
  });

  it("returns online when heartbeat and inventory are fresh", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:50:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:45.000Z",
      },
      inventoryIngestions: [{
        deviceId: "device-a",
        snapshotType: "inventory",
        status: "succeeded",
        observedAt: "2026-05-21T08:59:30.000Z",
        receivedAt: "2026-05-21T08:59:35.000Z",
        counts: { devices: 1 },
        warnings: [],
      }],
    })).toMatchObject({
      status: "online",
      label: "在线",
      reason: "heartbeat_and_inventory_fresh",
    });
  });

  it("returns offline when previous inventory succeeded but freshness expired", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "stale",
        connectedAt: "2026-05-21T08:00:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:40:00.000Z",
      },
      inventoryIngestions: [{
        deviceId: "device-a",
        snapshotType: "inventory",
        status: "succeeded",
        observedAt: "2026-05-21T08:40:00.000Z",
        receivedAt: "2026-05-21T08:40:10.000Z",
        counts: { devices: 1 },
        warnings: [],
      }],
    })).toMatchObject({
      status: "offline",
      label: "离线",
      reason: "inventory_or_heartbeat_stale",
    });
  });

  it("returns abnormal for the latest failed inventory", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:50:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
      },
      inventoryIngestions: [{
        deviceId: "device-a",
        snapshotType: "inventory",
        status: "failed",
        observedAt: "2026-05-21T08:59:30.000Z",
        receivedAt: "2026-05-21T08:59:35.000Z",
        counts: {},
        warnings: [],
        error: "invalid runtime inventory snapshot",
      }],
    })).toMatchObject({
      status: "abnormal",
      label: "异常",
      reason: "last_inventory_failed",
      message: "最近一次设备资产采集失败",
    });
  });

  it("returns abnormal when a fresh connection exceeds the first sync window without inventory", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:55:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
      },
      inventoryIngestions: [],
    })).toMatchObject({
      status: "abnormal",
      label: "异常",
      reason: "first_sync_timeout",
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
npx vitest run src/runtime/runtime-device-health.test.ts
```

Expected: fails because `runtime-device-health.ts` does not exist.

- [ ] **Step 3: Create `src/runtime/runtime-device-health.ts`**

```ts
import type { CollectionHealthIngestion } from "./runtime-collection-health";

export type DeviceHealthStatus = "syncing" | "online" | "offline" | "abnormal";

export type DeviceHealthReason =
  | "first_sync_pending"
  | "first_sync_timeout"
  | "heartbeat_and_inventory_fresh"
  | "inventory_or_heartbeat_stale"
  | "last_inventory_failed"
  | "control_error";

export interface DeviceHealthConnection {
  deviceId: string;
  status: "online" | "stale" | "offline";
  connectedAt?: string;
  lastHeartbeatAt?: string;
  lastError?: string;
}

export interface DeviceHealthStatusInput {
  deviceId: string;
  now: Date;
  connection?: DeviceHealthConnection | null;
  inventoryIngestions: CollectionHealthIngestion[];
  firstSyncWindowMs?: number;
  heartbeatFreshMs?: number;
  inventoryFreshMs?: number;
}

export interface DeviceHealthStatusResult {
  deviceId: string;
  status: DeviceHealthStatus;
  label: "同步中" | "在线" | "离线" | "异常";
  reason: DeviceHealthReason;
  message: string;
  lastHeartbeatAt?: string;
  lastInventorySuccessAt?: string;
  lastInventoryFailureAt?: string;
}

const defaultFirstSyncWindowMs = 120_000;
const defaultHeartbeatFreshMs = 90_000;
const defaultInventoryFreshMs = 300_000;

const labels: Record<DeviceHealthStatus, DeviceHealthStatusResult["label"]> = {
  syncing: "同步中",
  online: "在线",
  offline: "离线",
  abnormal: "异常",
};

export function deriveDeviceHealthStatus(input: DeviceHealthStatusInput): DeviceHealthStatusResult {
  const firstSyncWindowMs = input.firstSyncWindowMs ?? defaultFirstSyncWindowMs;
  const heartbeatFreshMs = input.heartbeatFreshMs ?? defaultHeartbeatFreshMs;
  const inventoryFreshMs = input.inventoryFreshMs ?? defaultInventoryFreshMs;
  const latestInventory = latestInventoryIngestion(input.inventoryIngestions);
  const latestSuccess = latestSucceededInventory(input.inventoryIngestions);
  const lastHeartbeatAt = input.connection?.lastHeartbeatAt;

  if (input.connection?.lastError) {
    return result(input, "abnormal", "control_error", "设备连接出现异常", {
      lastHeartbeatAt,
      lastInventorySuccessAt: receivedAt(latestSuccess),
      lastInventoryFailureAt: latestInventory?.status === "failed" ? receivedAt(latestInventory) : undefined,
    });
  }

  if (latestInventory?.status === "failed") {
    return result(input, "abnormal", "last_inventory_failed", "最近一次设备资产采集失败", {
      lastHeartbeatAt,
      lastInventorySuccessAt: receivedAt(latestSuccess),
      lastInventoryFailureAt: receivedAt(latestInventory),
    });
  }

  if (!latestSuccess) {
    if (isFirstSyncTimedOut(input.connection?.connectedAt, input.now, firstSyncWindowMs)) {
      return result(input, "abnormal", "first_sync_timeout", "设备连接后仍未完成首次同步", { lastHeartbeatAt });
    }
    return result(input, "syncing", "first_sync_pending", "等待设备完成首次同步", { lastHeartbeatAt });
  }

  const heartbeatFresh = isFresh(lastHeartbeatAt, input.now, heartbeatFreshMs);
  const inventoryFresh = isFresh(receivedAt(latestSuccess), input.now, inventoryFreshMs);
  if (heartbeatFresh && inventoryFresh) {
    return result(input, "online", "heartbeat_and_inventory_fresh", "设备在线且采集正常", {
      lastHeartbeatAt,
      lastInventorySuccessAt: receivedAt(latestSuccess),
    });
  }

  return result(input, "offline", "inventory_or_heartbeat_stale", "设备最近未保持在线同步", {
    lastHeartbeatAt,
    lastInventorySuccessAt: receivedAt(latestSuccess),
  });
}

function result(
  input: DeviceHealthStatusInput,
  status: DeviceHealthStatus,
  reason: DeviceHealthReason,
  message: string,
  times: Pick<DeviceHealthStatusResult, "lastHeartbeatAt" | "lastInventorySuccessAt" | "lastInventoryFailureAt"> = {},
): DeviceHealthStatusResult {
  return {
    deviceId: input.deviceId,
    status,
    label: labels[status],
    reason,
    message,
    ...times,
  };
}

function latestInventoryIngestion(ingestions: CollectionHealthIngestion[]): CollectionHealthIngestion | undefined {
  return ingestions
    .filter((ingestion) => ingestion.snapshotType === "inventory")
    .sort((left, right) => Date.parse(receivedAt(right) ?? "") - Date.parse(receivedAt(left) ?? ""))[0];
}

function latestSucceededInventory(ingestions: CollectionHealthIngestion[]): CollectionHealthIngestion | undefined {
  return ingestions
    .filter((ingestion) => ingestion.snapshotType === "inventory" && ingestion.status === "succeeded")
    .sort((left, right) => Date.parse(receivedAt(right) ?? "") - Date.parse(receivedAt(left) ?? ""))[0];
}

function receivedAt(ingestion: CollectionHealthIngestion | undefined): string | undefined {
  if (!ingestion) return undefined;
  const value = ingestion.receivedAt;
  return value instanceof Date ? value.toISOString() : value;
}

function isFresh(value: string | undefined, now: Date, maxAgeMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp <= maxAgeMs;
}

function isFirstSyncTimedOut(connectedAt: string | undefined, now: Date, firstSyncWindowMs: number): boolean {
  if (!connectedAt) return false;
  const timestamp = Date.parse(connectedAt);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp > firstSyncWindowMs;
}
```

- [ ] **Step 4: Run Device health tests**

```bash
npx vitest run src/runtime/runtime-device-health.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit Device status model**

```bash
git add src/runtime/runtime-device-health.ts src/runtime/runtime-device-health.test.ts
git commit -m "feat(runtime): derive device health states"
```

---

## Task 5: Expose Local Device Diagnostics API

**Files:**
- Modify: `src/server/runtime-http-api.ts`
- Modify: `src/server/runtime-http-api-postgres.test.ts`
- Read: `src/server/postgres-store.ts`

- [ ] **Step 1: Write failing API tests**

In `src/server/runtime-http-api-postgres.test.ts`, add a test under the Postgres-backed runtime HTTP API suite:

```ts
it("derives device diagnostics from local connection and inventory ingestion", async () => {
  const { baseUrl, store, close } = await startPostgresRuntimeApi();
  try {
    store.writeDeviceConnection({
      deviceId: "diagnostic-device",
      status: "online",
      connectedAt: "2026-05-21T08:59:00.000Z",
      lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
    });

    await postJson(`${baseUrl}/api/device-snapshots`, {
      observedAt: "2026-05-21T08:59:30.000Z",
      collector: { version: "0.1.0", status: "online" },
      device: {
        id: "diagnostic-device",
        hostname: "diagnostic.local",
        os: "darwin",
        architecture: "arm64",
        lastSeenAt: "2026-05-21T08:59:30.000Z",
      },
      runtimes: [],
      agents: [],
      reports: [],
    });

    const response = await fetch(`${baseUrl}/api/devices/diagnostic-device/diagnostics?now=2026-05-21T09:00:00.000Z`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deviceId: "diagnostic-device",
      status: "online",
      label: "在线",
      reason: "heartbeat_and_inventory_fresh",
      message: "设备在线且采集正常",
    });
  } finally {
    await close();
  }
});
```

Add another test for latest failed inventory:

```ts
it("marks diagnostics abnormal after invalid inventory ingestion", async () => {
  const { baseUrl, store, close } = await startPostgresRuntimeApi();
  try {
    store.writeDeviceConnection({
      deviceId: "broken-diagnostic-device",
      status: "online",
      connectedAt: "2026-05-21T08:59:00.000Z",
      lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
    });

    await postJson(`${baseUrl}/api/device-snapshots`, {
      observedAt: "2026-05-21T08:59:30.000Z",
      device: { id: "broken-diagnostic-device" },
    });

    const response = await fetch(`${baseUrl}/api/devices/broken-diagnostic-device/diagnostics?now=2026-05-21T09:00:00.000Z`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deviceId: "broken-diagnostic-device",
      status: "abnormal",
      label: "异常",
      reason: "last_inventory_failed",
    });
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run failing API tests**

```bash
npx vitest run src/server/runtime-http-api-postgres.test.ts -t "diagnostics"
```

Expected: fails because `/api/devices/:deviceId/diagnostics` is not implemented.

- [ ] **Step 3: Add diagnostics route in `src/server/runtime-http-api.ts`**

Import the derivation helper:

```ts
import { deriveDeviceHealthStatus } from "../runtime/runtime-device-health";
```

Add this route before the collection-health route:

```ts
const diagnosticsMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/diagnostics$/);
if (diagnosticsMatch) {
  const deviceId = decodeURIComponent(diagnosticsMatch[1] ?? "");
  const nowParam = requestUrl.searchParams.get("now");
  const now = nowParam ? new Date(nowParam) : new Date();
  const ingestions = await options.postgresStore.listCollectorIngestions(deviceId);
  const connection = options.store.readDeviceConnection(deviceId, now);
  sendJson(response, 200, deriveDeviceHealthStatus({
    deviceId,
    now,
    connection,
    inventoryIngestions: ingestions,
  }));
  return;
}
```

- [ ] **Step 4: Run diagnostics API tests**

```bash
npx vitest run src/server/runtime-http-api-postgres.test.ts -t "diagnostics"
```

Expected: all diagnostics tests pass.

- [ ] **Step 5: Run backend focused checks**

```bash
npm run check:backend
```

Expected: backend tests pass.

- [ ] **Step 6: Commit diagnostics API**

```bash
git add src/server/runtime-http-api.ts src/server/runtime-http-api-postgres.test.ts
git commit -m "feat(runtime): expose device diagnostics"
```

---

## Task 6: Add Lightweight Collector Diagnostic Events

**Files:**
- Modify: `scripts/lorume-device-collector.mjs`
- Modify: `src/runtime/device-collector-script.test.ts`

- [ ] **Step 1: Write failing collector log test**

Add this test to `src/runtime/device-collector-script.test.ts`:

```ts
it("writes lightweight collector diagnostics for successful local once uploads", async () => {
  const { server, receivedSnapshot, baseUrl } = await startSnapshotServer();
  const logDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-success-logs-"));
  const logPath = path.join(logDir, "collector.jsonl");

  try {
    await runNodeScript([
      collectorScript,
      "--once",
      "--fixture",
      fixturePath,
      "--server-url",
      baseUrl,
      "--device-token",
      "secret-device-token",
    ], { env: { ...process.env, LORUME_COLLECTOR_LOG_PATH: logPath } });
    await receivedSnapshot;

    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "inventory_collected", level: "info" }),
      expect.objectContaining({ event: "inventory_upload_succeeded", level: "info" }),
    ]));
    expect(JSON.stringify(records)).not.toContain("secret-device-token");
  } finally {
    server.close();
    rmSync(logDir, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run failing collector log test**

```bash
npx vitest run src/runtime/device-collector-script.test.ts -t "successful local once uploads"
```

Expected: fails because success diagnostic events are not written yet.

- [ ] **Step 3: Add success events in `scripts/lorume-device-collector.mjs`**

Inside the inventory collection/upload path, use the existing collector logger and add:

```js
logger.info({
  event: "inventory_collected",
  deviceId: snapshot.device.id,
  counts: {
    runtimes: snapshot.runtimes.length,
    agents: snapshot.agents.length,
    reports: snapshot.reports.length,
  },
});
```

After successful POST:

```js
logger.info({
  event: "inventory_upload_succeeded",
  deviceId: snapshot.device.id,
  serverUrl: redactUrl(resolveServerUrl(config, args)),
});
```

Add equivalent work-state events only where work-state upload already has a clear success point:

```js
logger.info({
  event: "work_state_upload_succeeded",
  deviceId: workStateSnapshot.deviceId,
  counts: {
    workItems: workStateSnapshot.workItems.length,
    conversations: workStateSnapshot.conversations.length,
    executions: workStateSnapshot.executions.length,
  },
});
```

Do not log request headers, `deviceToken`, full config, or raw payload bodies.

- [ ] **Step 4: Run collector script tests**

```bash
npx vitest run src/runtime/device-collector-script.test.ts -t "successful local once uploads|failure logs|uploads inventory and work-state"
```

Expected: selected tests pass and secret redaction remains enforced.

- [ ] **Step 5: Commit collector diagnostics**

```bash
git add scripts/lorume-device-collector.mjs src/runtime/device-collector-script.test.ts
git commit -m "feat(runtime): log collector diagnostics"
```

---

## Task 7: Feed Device Status Into Runtime Fleet Query Model

**Files:**
- Modify: `src/runtime/runtime-inventory-query.ts`
- Modify: `src/runtime/runtime-inventory-query.test.ts`
- Read: `src/runtime/RuntimeFleetPage.tsx`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: Write failing query test for Device labels**

Add to `src/runtime/runtime-inventory-query.test.ts`:

```ts
it("uses the four Device status labels without reading Runtime or Agent state", () => {
  const onlineHealth = new Map([[
    "fixture-mac",
    {
      deviceId: "fixture-mac",
      status: "online",
      label: "在线",
      reason: "heartbeat_and_inventory_fresh",
      message: "设备在线且采集正常",
    },
  ]]);

  const detail = getRuntimeFleetDetail(
    {
      ...snapshot,
      runtimes: snapshot.runtimes.map((runtime) => ({ ...runtime, status: "degraded" })),
      agents: snapshot.agents.map((agent) => ({ ...agent, status: "inactive" })),
    },
    "device",
    "fixture-mac",
    undefined,
    undefined,
    onlineHealth,
  );

  expect(detail).toMatchObject({
    kind: "device",
    id: "fixture-mac",
    statusLabel: "在线",
  });
});
```

- [ ] **Step 2: Run failing query test**

```bash
npx vitest run src/runtime/runtime-inventory-query.test.ts -t "four Device status labels"
```

Expected: fails until the query model accepts Device diagnostics input.

- [ ] **Step 3: Extend query model input minimally**

In `src/runtime/runtime-inventory-query.ts`, add a diagnostics map input to `getRuntimeFleetDetail`:

```ts
import type { DeviceHealthStatusResult } from "./runtime-device-health";

type DeviceHealthById = ReadonlyMap<string, Pick<DeviceHealthStatusResult, "label" | "status">>;
```

When building device detail, prefer diagnostics:

```ts
const health = deviceHealthById?.get(device.id);
const statusLabel = health?.label ?? "同步中";
```

Do not inspect Runtime or Agent status to compute Device status.

- [ ] **Step 4: Confirm Runtime Fleet page consumes the query model label**

Read `RuntimeFleetPage.tsx` and confirm the visible Device label comes from `runtime-inventory-query.ts`. Keep selected-device `collection-health` fetching for details and avoid broad API fan-out. Do not add a new polling endpoint for every row.

- [ ] **Step 5: Run focused UI/query checks**

```bash
npx vitest run src/runtime/runtime-inventory-query.test.ts src/App.test.tsx
```

Expected: tests pass.

- [ ] **Step 6: Commit Runtime Fleet status consumption**

```bash
git add src/runtime/runtime-inventory-query.ts src/runtime/runtime-inventory-query.test.ts src/runtime/RuntimeFleetPage.tsx src/App.test.tsx
git commit -m "feat(runtime): show device health labels"
```

---

## Task 8: Local Backend E2E For Diagnostics Without Production Mutation

**Files:**
- Modify: `e2e/runtime-backend-api.spec.ts`
- Read: `scripts/dev-backend-e2e.ts`

- [ ] **Step 1: Add local diagnostics assertion to existing backend E2E**

In the test that already creates a device token and ingests snapshots, after collection health assertions add:

```ts
const diagnosticsResponse = await request.get("/api/devices/fixture-mac/diagnostics?now=2026-05-20T08:01:30.000Z");
expect(diagnosticsResponse.status()).toBe(200);
await expect(diagnosticsResponse.json()).resolves.toMatchObject({
  deviceId: "fixture-mac",
  status: "online",
  label: "在线",
});
```

In the real collector-process E2E, after `waitForCollectorHealth`, add:

```ts
const diagnosticsResponse = await request.get(`/api/devices/${encodeURIComponent(deviceId)}/diagnostics`);
expect(diagnosticsResponse.status()).toBe(200);
await expect(diagnosticsResponse.json()).resolves.toMatchObject({
  deviceId,
});
```

Do not create any production URL, production token, or production DB connection in this E2E.

- [ ] **Step 2: Run backend E2E locally**

```bash
npm run check:backend:e2e
```

Expected:

```text
2 passed
```

- [ ] **Step 3: Commit backend E2E diagnostics**

```bash
git add e2e/runtime-backend-api.spec.ts scripts/dev-backend-e2e.ts
git commit -m "test(runtime): cover local device diagnostics e2e"
```

---

## Task 9: Full Verification And Final Review

**Files:**
- Read: `git status --short`
- Read: `docs/product/runtime-device-registration-spec.md`
- Read: `AGENTS.md`

- [ ] **Step 1: Run focused checks first**

```bash
npm run check:repo
npm run check:runtime
npm run check:backend
npm run check:backend:e2e
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run full harness**

```bash
./scripts/verify.sh
```

Expected:

```text
verify: ok
```

- [ ] **Step 3: Inspect working tree**

```bash
git status --short
```

Expected: only intended files are changed or the tree is clean after commits.

- [ ] **Step 4: Final self-review checklist**

Confirm these statements are true before handoff:

```text
Installer tests use local repository paths and temporary install directories.
No automated test writes to production backend or production DB.
No test requires claw.gezilinll.com or lorume.com to be reachable.
Device status labels are exactly 同步中 / 在线 / 离线 / 异常.
Device status does not derive from Runtime or Agent status.
Collector diagnostics do not log tokens or raw secrets.
Backend E2E runs against isolated local Postgres and cleans up after itself.
```

- [ ] **Step 5: Final commit if any verification-only docs changed**

```bash
git add AGENTS.md docs/product/runtime-device-registration-spec.md docs/product/backend-service-spec.md src/backend src/runtime src/server scripts e2e
git commit -m "feat(runtime): harden local device install diagnostics"
```

Skip this commit only when all previous task commits already include every intended change.

---

## Execution Notes

- Prefer implementing this plan in order. Task 1 locks the boundaries; Tasks 2-3 prevent installer contract drift; Tasks 4-5 create the Device status and diagnostics model; Task 6 improves collector observability; Tasks 7-8 wire the model into existing query/E2E surfaces.
- If a real-device or deployed-domain issue appears while executing this plan, classify it as operations validation unless it reveals a local code contract gap. Add a local failing test only for code contract gaps.
- If a task exposes a mismatch between this plan and current code signatures, update the plan in the same branch before continuing so the next worker does not inherit stale instructions.
