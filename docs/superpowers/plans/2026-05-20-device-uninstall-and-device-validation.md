# Device Uninstall And Device Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimum backend/device-agent capability needed to uninstall/reinstall Lorume on `gezilinll-claw`, clear backend state, and validate only Device-level collection data from a one-line install command.

**Architecture:** Keep Lorume device cleanup product-driven: the agent may execute Lorume stop/uninstall/install commands on the real device, but must not manually remove leftover files or services to make the device look clean. Device state becomes a narrow machine fact model: no `device.name`, no `device.status`, and no `device.connectionMode`; Runtime and Agent may still be collected and ingested, but are not part of this validation scope.

**Tech Stack:** Node.js CLI scripts, Bash installer/uninstaller, TypeScript runtime models, Postgres migrations/repositories, Vitest unit/API tests, Playwright backend E2E, real-device SSH validation against `ssh gezilinll-claw`.

---

## Non-Negotiable Scope

- Do not involve frontend registration flow in this P0 validation.
- Do not productize token lifecycle here. Use the simplest safe self-test path to obtain a device token.
- Do not manually delete Lorume files, launchd plists, systemd units, or process state on `gezilinll-claw` to cover for a broken uninstall.
- If uninstall leaves residue, stop the real-device procedure, diagnose why the product uninstall failed, fix the project code/tests, redeploy/reinstall the fixed capability, then rerun uninstall.
- Backend database cleanup is allowed as an explicit validation setup step; device uninstall must not clear remote backend data.
- Runtime/Agent data may be ingested during this run, but acceptance ignores it. It can be cleaned in a later pass.

## Known Real Device

Read-only probe already confirmed:

| Field | Value |
|---|---|
| SSH target | `gezilinll-claw` |
| SSH config hostname | `10.1.67.125` |
| Remote hostname | `gezilinll-clawdeMacBook-Pro.local` |
| OS | `Darwin 24.5.0 arm64` |
| Address observed by host command | `10.1.67.125` |

## Device Data Contract

Device state must contain only these machine/device facts plus collector metadata:

| Field | Required | Source |
|---|---:|---|
| `device.id` | yes | install command/config or sanitized hostname fallback |
| `device.hostname` | yes | `os.hostname()` |
| `device.os` | yes | `os.platform()` |
| `device.architecture` | yes | `os.arch()` |
| `device.lastSeenAt` | yes | device-state snapshot observation time |
| `device.user.username` | yes when readable | `os.userInfo().username` |
| `device.network.localIps` | yes when present | non-internal OS network interfaces |
| `device.network.publicIp` | yes when backend can infer | trusted forwarded header or request remote address |
| `collector.version` | yes | collector package |
| `collector.status` | yes | collector process state |
| `collector.installPath` | yes after installed | installer config |
| `collector.lastError` | optional | collector runtime error |

Remove these from Device schema, API payloads, fixtures, and UI usage:

| Removed field | Reason |
|---|---|
| `device.name` | Product no longer needs a separate Device display name in this validation scope. Use `device.id` or `hostname` for labels. |
| `device.status` | Device health must not be a collector/runtime/agent rollup stored on the device fact object. UI can derive display status from connection/collection health separately. |
| `device.connectionMode` | Current product connection mode is not a machine-collected fact and has no useful user-facing value in this validation scope. |

---

## File Map

| File | Responsibility |
|---|---|
| `docs/product/runtime-device-registration-spec.md` | Source of truth for narrowed Device contract, uninstall behavior, observer rule, real-device validation acceptance. |
| `docs/product/runtime-fleet-page-spec.md` | Runtime Fleet wording after removing Device `name/status/connectionMode`. |
| `docs/product/cli-device-capability-spec.md` | CLI command contract for `device.identify`, `collect device-state`, `collector stop`, and `collector uninstall`. |
| `src/runtime/runtime-model.ts` | Remove `RuntimeDevice.name/status/connectionMode`; keep runtime/agent status independent. |
| `scripts/lorume-runtime-adapters.mjs` | Emit narrowed Device fields and stop rolling runtime state into device facts. |
| `scripts/lorume-device-collector.mjs` | Emit/control narrowed device identity; keep `deviceName` out of snapshot and heartbeat payload unless control channel still temporarily accepts it. |
| `scripts/install-device-collector.sh` | Add stop/uninstall behavior and install metadata needed for clean removal. |
| `scripts/lorume.mjs` | Add CLI commands for stop/uninstall, remove `device.name/status/connectionMode` from `device identify`. |
| `db/migrations/` | Add migration dropping `devices.name`, `devices.status`, and `devices.connection_mode`. |
| `src/server/runtime-device-state-store.ts` | Relax validation so Device no longer requires `name/status/connectionMode`. |
| `src/server/postgres-store.ts` | Upsert/query narrowed Device columns, enrich `publicIp`, order by stable remaining fields. |
| `src/server/runtime-http-api.ts` | Enrich Device public IP during ingestion without trusting arbitrary client-supplied public IP more than proxy/remote evidence. |
| `src/runtime/runtime-fleet-query.ts` | Derive Device display label/status without removed fields. |
| `src/runtime/RuntimeFleetPage.tsx` | Remove Device name/connection-mode display assumptions. Use id/hostname and derived status. |
| `fixtures/runtime/collector-snapshot.sample.json` | Update fixture to narrowed Device object. |
| `src/runtime/device-collector-script.test.ts` | Installer/uninstaller and collector script coverage. |
| `src/cli/lorume-cli.test.ts` | CLI Device contract and new stop/uninstall command tests. |
| `src/runtime/runtime-model.ts` | Device model and status-independence tests. |
| `src/server/runtime-http-api*.test.ts` | API validation and public IP enrichment tests. |
| `src/server/postgres-store.test.ts` | DB read/write tests after schema change. |
| `e2e/runtime-backend-api.spec.ts` | Backend E2E for real collector process with narrowed Device assertion. |

---

## Task 1: Lock The Device Contract In Specs And Guards

**Files:**
- Modify: `docs/product/runtime-device-registration-spec.md`
- Modify: `docs/product/runtime-fleet-page-spec.md`
- Modify: `docs/product/cli-device-capability-spec.md`
- Modify: `scripts/check-repo.sh`

- [ ] **Step 1: Update the specs**

Write the narrowed contract into the specs:

```markdown
Device only records machine and collector facts: id, hostname, os, architecture,
lastSeenAt, user.username, network.localIps, network.publicIp, and collector
metadata. Device does not include name, stored status, or connectionMode.
Runtime and Agent status are independent and must not roll up into Device facts.
```

Add the observer rule:

```markdown
During real-device cleanup, agents may run Lorume stop/uninstall/install
commands and read logs/state. They must not manually delete residual Lorume
files or services. Residue means uninstall is defective and must be fixed in
the project before rerunning validation.
```

- [ ] **Step 2: Add repo guard checks**

In `scripts/check-repo.sh`, add forbidden text checks for product docs that reintroduce old Device semantics:

```python
forbidden_device_phrases = [
    ("docs/product/runtime-device-registration-spec.md", "展示名", "Device must not document a collected display name"),
    ("docs/product/runtime-device-registration-spec.md", "connectionMode", "Device must not document collected connectionMode"),
    ("docs/product/runtime-device-registration-spec.md", "Runtime 不可达或设备", "Device status must not roll up runtime health"),
]
```

- [ ] **Step 3: Run focused check**

Run:

```bash
npm run check:repo
```

Expected: passes after the docs and guard agree.

---

## Task 2: Remove Device `name/status/connectionMode` From The Type Model

**Files:**
- Modify: `src/runtime/runtime-model.ts`
- Modify: `src/runtime/runtime-model.ts`
- Modify: `fixtures/runtime/collector-snapshot.sample.json`

- [ ] **Step 1: Write failing type/model tests**

Add tests that assert the fields are absent and runtime status cannot affect Device facts:

```ts
it("keeps device facts narrow and independent from runtime health", () => {
  const snapshot = createDeviceStateSnapshot({
    observedAt: "2026-05-20T00:00:00.000Z",
    collector: { version: "0.1.0", status: "online", installPath: "/tmp/lorume" },
    device: {
      id: "device-a",
      hostname: "device-a.local",
      os: "darwin",
      architecture: "arm64",
      lastSeenAt: "2026-05-20T00:00:00.000Z",
      user: { username: "gezilinll-claw" },
      network: { localIps: ["10.1.67.125"], publicIp: "203.0.113.10" },
    },
    reports: [{
      source: "codex",
      collectedAt: "2026-05-20T00:00:00.000Z",
      runtimes: [{
        externalId: "runtime-main",
        kind: "codex",
        name: "Codex CLI",
        status: "degraded",
        capabilities: [],
      }],
      agents: [],
    }],
  });

  expect(snapshot.device).toEqual({
    id: "device-a",
    hostname: "device-a.local",
    os: "darwin",
    architecture: "arm64",
    lastSeenAt: "2026-05-20T00:00:00.000Z",
    user: { username: "gezilinll-claw" },
    network: { localIps: ["10.1.67.125"], publicIp: "203.0.113.10" },
  });
  expect(snapshot.device).not.toHaveProperty("name");
  expect(snapshot.device).not.toHaveProperty("status");
  expect(snapshot.device).not.toHaveProperty("connectionMode");
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
npx vitest run src/runtime/runtime-model.ts
```

Expected: fails because `RuntimeDevice` still requires/emits removed fields.

- [ ] **Step 3: Update `RuntimeDevice`**

Change `src/runtime/runtime-model.ts` so `RuntimeDevice` has only the narrowed fields:

```ts
export interface RuntimeDevice {
  id: string;
  hostname: string;
  os: string;
  architecture?: string;
  lastSeenAt?: string;
  user?: RuntimeDeviceUser;
  network?: RuntimeDeviceNetwork;
}
```

Remove `rollupDeviceStatus()` and stop assigning `device.status` in `createDeviceStateSnapshot()`.

- [ ] **Step 4: Update fixtures**

Remove `name`, `status`, and `connectionMode` from `fixtures/runtime/collector-snapshot.sample.json` device objects.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run src/runtime/runtime-model.ts
npm run check:runtime
```

Expected: runtime tests pass after downstream test updates in later tasks.

---

## Task 3: Emit Narrow Device Facts From CLI And Collector

**Files:**
- Modify: `scripts/lorume.mjs`
- Modify: `scripts/lorume-runtime-adapters.mjs`
- Modify: `scripts/lorume-device-collector.mjs`
- Modify: `src/cli/lorume-cli.test.ts`
- Modify: `src/runtime/device-collector-script.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Update `src/cli/lorume-cli.test.ts`:

```ts
it("identifies the device without name, status, or connectionMode", () => {
  const result = runLorume(["device", "identify", "--device-id", "test-device"]);
  const body = JSON.parse(result.stdout);

  expect(body.device).toMatchObject({
    id: "test-device",
    hostname: expect.any(String),
    os: expect.any(String),
    architecture: expect.any(String),
  });
  expect(body.device).not.toHaveProperty("name");
  expect(body.device).not.toHaveProperty("status");
  expect(body.device).not.toHaveProperty("connectionMode");
});
```

- [ ] **Step 2: Write failing collector snapshot tests**

Update `src/runtime/device-collector-script.test.ts`:

```ts
expect(snapshot.device).toMatchObject({
  id: "test-device",
  hostname: expect.any(String),
  os: expect.any(String),
  architecture: expect.any(String),
});
expect(snapshot.device).not.toHaveProperty("name");
expect(snapshot.device).not.toHaveProperty("status");
expect(snapshot.device).not.toHaveProperty("connectionMode");
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
npx vitest run src/cli/lorume-cli.test.ts src/runtime/device-collector-script.test.ts
```

Expected: fails because current scripts still emit old fields.

- [ ] **Step 4: Update script emitters**

Remove old fields from:

```js
// scripts/lorume.mjs identifyDevice()
device: {
  architecture: arch(),
  hostname: hostname(),
  id: deviceId,
  os: platform(),
  ...(localIps.length ? { network: { localIps } } : {}),
  user: { username: safeUsername() },
}
```

```js
// scripts/lorume-runtime-adapters.mjs createDevice()
return {
  id: config.deviceId || defaultId,
  hostname: hostname(),
  os: platform(),
  architecture: arch(),
  lastSeenAt: observedAt,
  user: { username: safeUsername() },
  ...(localIps.length ? { network: { localIps } } : {}),
};
```

Keep `--device-name` only if needed as a deprecated ignored argument during one transition; prefer removing it from new install commands in Task 5.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run src/cli/lorume-cli.test.ts src/runtime/device-collector-script.test.ts
npm run check:cli
npm run check:runtime
```

Expected: passes with narrowed device payloads.

---

## Task 4: Remove Old Device Columns From Backend Storage

**Files:**
- Create: `db/migrations/0010_narrow_device_facts.sql`
- Modify: `src/server/runtime-device-state-store.ts`
- Modify: `src/server/postgres-store.ts`
- Modify: `src/server/postgres-store.test.ts`
- Modify: `src/server/runtime-http-api-postgres.test.ts`
- Modify: `src/server/runtime-http-api.test.ts`
- Modify: `src/server/db-migrate.test.ts`

- [ ] **Step 1: Write failing backend tests**

In `src/server/postgres-store.test.ts`, add or update assertions:

```ts
const fleet = await store.readRuntimeFleet();
expect(fleet.devices[0]).toMatchObject({
  id: "fixture-mac",
  hostname: expect.any(String),
  os: expect.any(String),
});
expect(fleet.devices[0]).not.toHaveProperty("name");
expect(fleet.devices[0]).not.toHaveProperty("status");
expect(fleet.devices[0]).not.toHaveProperty("connectionMode");
```

In `src/server/runtime-device-state-store.ts` tests, make invalid snapshots fail only when `id/hostname/os` are missing, not when removed fields are missing.

- [ ] **Step 2: Run backend tests and confirm failure**

Run:

```bash
npx vitest run src/server/postgres-store.test.ts src/server/runtime-http-api-postgres.test.ts src/server/runtime-http-api.test.ts src/server/db-migrate.test.ts
```

Expected: fails because schema/upsert/validation still expects removed fields.

- [ ] **Step 3: Add migration**

Create `db/migrations/0010_narrow_device_facts.sql`:

```sql
ALTER TABLE devices DROP COLUMN IF EXISTS name;
ALTER TABLE devices DROP COLUMN IF EXISTS status;
ALTER TABLE devices DROP COLUMN IF EXISTS connection_mode;
```

- [ ] **Step 4: Update Postgres store**

Change `upsertDevice()` in `src/server/postgres-store.ts` to insert only:

```sql
id, hostname, os, architecture, collector, last_seen_at, observed_at, raw, updated_at
```

Change `readRuntimeFleet()` ordering from `ORDER BY name` to a stable remaining field:

```sql
SELECT raw, observed_at FROM devices ORDER BY hostname, id
```

- [ ] **Step 5: Update validation**

Change `src/server/runtime-device-state-store.ts` snapshot validation:

```ts
if (!isRecord(value.device) || typeof value.device.id !== "string") return false;
if (typeof value.device.hostname !== "string" || typeof value.device.os !== "string") return false;
```

- [ ] **Step 6: Run DB/backend checks**

Run:

```bash
npm run check:db
npm run check:backend
```

Expected: passes with narrowed schema and API payloads.

---

## Task 5: Enrich `network.publicIp` At Backend Ingestion

**Files:**
- Modify: `src/server/runtime-http-api.ts`
- Modify: `src/server/runtime-http-api.test.ts`
- Modify: `src/server/runtime-http-api-postgres.test.ts`
- Modify: `src/server/postgres-store.test.ts`

- [ ] **Step 1: Write failing API test**

Add a test that posts a snapshot with `x-forwarded-for` and verifies the stored Device raw has `publicIp`:

```ts
const response = await fetch(`${baseUrl}/api/device-state-snapshots`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.10, 10.0.0.12",
  },
  body: JSON.stringify(snapshotWithoutPublicIp),
});
expect(response.status).toBe(201);

const fleet = await fetch(`${baseUrl}/api/runtime-fleet`).then((item) => item.json());
expect(fleet.devices[0].network.publicIp).toBe("203.0.113.10");
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
npx vitest run src/server/runtime-http-api.test.ts src/server/runtime-http-api-postgres.test.ts
```

Expected: fails because backend does not enrich public IP yet.

- [ ] **Step 3: Implement enrichment**

Before `options.store.writeLatestSnapshot(body)`, clone and enrich body:

```ts
function enrichDeviceNetworkFromRequest(body: unknown, request: IncomingMessage): unknown {
  if (!body || typeof body !== "object") return body;
  const candidate = body as Record<string, unknown>;
  const device = candidate.device;
  if (!device || typeof device !== "object") return body;
  const publicIp = inferPublicIp(request);
  if (!publicIp) return body;
  const nextDevice = device as Record<string, unknown>;
  return {
    ...candidate,
    device: {
      ...nextDevice,
      network: {
        ...(typeof nextDevice.network === "object" && nextDevice.network ? nextDevice.network : {}),
        publicIp,
      },
    },
  };
}
```

`inferPublicIp()` should prefer the first valid `x-forwarded-for` value, then `request.socket.remoteAddress`, while stripping IPv6 mapped prefixes like `::ffff:`.

- [ ] **Step 4: Run focused checks**

Run:

```bash
npx vitest run src/server/runtime-http-api.test.ts src/server/runtime-http-api-postgres.test.ts src/server/postgres-store.test.ts
npm run check:backend
```

Expected: passes and persists public IP in Device raw.

---

## Task 6: Update Runtime Fleet Query/UI For Removed Device Fields

**Files:**
- Modify: `src/runtime/runtime-fleet-query.ts`
- Modify: `src/runtime/runtime-fleet-query.test.ts`
- Modify: `src/runtime/RuntimeFleetPage.tsx`
- Modify: `src/App.test.tsx`
- Modify: `e2e/runtime-fleet.spec.ts`

- [ ] **Step 1: Write failing query tests**

Update device label expectations:

```ts
const detail = getRuntimeFleetDetail(snapshot, "device", "fixture-mac");
expect(detail?.title).toBe("fixture-mac");
expect(detail?.facts).toEqual(expect.arrayContaining([
  { label: "Hostname", value: "fixture-mac.local" },
]));
expect(JSON.stringify(detail)).not.toContain("connectionMode");
```

- [ ] **Step 2: Update status derivation**

`deriveDeviceFleetStatus()` should not read `device.status`. It should use collection/connection health only:

```ts
export function deriveDeviceFleetStatus(
  _snapshot: DeviceStateSnapshot,
  device: RuntimeDevice,
  collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
): RuntimeFleetObjectStatus {
  const collectionStatus = collectionHealthByDeviceId?.get(device.id)?.status;
  if (collectionStatus === "failed") return "exception";
  if (collectionStatus === "no_data") return "unknown";
  return "working";
}
```

If connection state becomes available in the same response later, extend this function then; do not infer Device status from Runtime or Agent.

- [ ] **Step 3: Update page rendering**

In `DevicePanel`, render:

```tsx
<strong>{device.id}</strong>
<span>{device.hostname}</span>
```

Remove display of connection mode. Do not add a replacement label unless the user-facing value is useful.

- [ ] **Step 4: Run UI checks**

Run:

```bash
npx vitest run src/runtime/runtime-fleet-query.test.ts src/App.test.tsx
npm run check:quick
npm run check:e2e
```

Expected: Runtime Fleet renders Device using id/hostname and no longer depends on removed fields.

---

## Task 7: Add Stop And Uninstall Product Capability

**Files:**
- Modify: `scripts/install-device-collector.sh`
- Modify: `scripts/lorume.mjs`
- Modify: `src/cli/lorume-cli.test.ts`
- Modify: `src/runtime/device-collector-script.test.ts`
- Modify: `docs/product/cli-device-capability-spec.md`
- Modify: `docs/product/runtime-device-registration-spec.md`

- [ ] **Step 1: Write failing installer tests**

In `src/runtime/device-collector-script.test.ts`, add tests using fake platform commands in `PATH`.

For macOS:

```ts
it("uninstalls launchd collector service and install files through product command", () => {
  const installDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-"));
  const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-home-"));
  const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-bin-"));
  writeFileSync(path.join(fakeBin, "launchctl"), "#!/usr/bin/env bash\necho \"$@\" >> \"$LORUME_FAKE_LAUNCHCTL_LOG\"\n");
  chmodSync(path.join(fakeBin, "launchctl"), 0o755);

  runInstaller(["--install-dir", installDir, "--no-service"], { HOME: fakeHome, PATH: `${fakeBin}:${process.env.PATH}` });
  runInstaller(["--install-dir", installDir, "--uninstall"], { HOME: fakeHome, PATH: `${fakeBin}:${process.env.PATH}` });

  expect(existsSync(installDir)).toBe(false);
});
```

Add a second test that runs uninstall twice and expects success both times.

- [ ] **Step 2: Write failing CLI tests**

In `src/cli/lorume-cli.test.ts`, assert new commands exist:

```ts
expect(runLorume(["collector", "stop", "--install-dir", installDir]).status).toBe(0);
expect(runLorume(["collector", "uninstall", "--install-dir", installDir]).status).toBe(0);
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
npx vitest run src/runtime/device-collector-script.test.ts src/cli/lorume-cli.test.ts
```

Expected: fails because stop/uninstall commands do not exist.

- [ ] **Step 4: Implement installer flags**

Add flags to `scripts/install-device-collector.sh`:

```bash
--stop       Stop Lorume collector service without removing files
--uninstall  Stop service, remove service definition, and remove install dir
```

Implementation rules:

- macOS service path: `$HOME/Library/LaunchAgents/ai.lorume.collector.plist`
- Linux service path: `$HOME/.config/systemd/user/lorume-collector.service`
- `--stop` is idempotent.
- `--uninstall` is idempotent.
- `--uninstall` removes install dir only after service stop/unregister commands have been attempted.
- Do not echo device token or config contents.

- [ ] **Step 5: Implement CLI wrappers**

Add to `scripts/lorume.mjs`:

```js
if (group === "collector" && command === "stop") {
  writeJson(stopCollector(flags));
  return;
}
if (group === "collector" && command === "uninstall") {
  writeJson(uninstallCollector(flags));
  return;
}
```

These wrappers should invoke the installed/unpacked `install-device-collector.sh` with `--stop` or `--uninstall` and return JSON status.

- [ ] **Step 6: Run focused checks**

Run:

```bash
npx vitest run src/runtime/device-collector-script.test.ts src/cli/lorume-cli.test.ts
npm run check:cli
npm run check:runtime
```

Expected: stop/uninstall are covered and idempotent.

---

## Task 8: Backend E2E For Narrow Device Ingestion

**Files:**
- Modify: `e2e/runtime-backend-api.spec.ts`
- Modify: `playwright.backend.config.ts` only if needed

- [ ] **Step 1: Update backend E2E assertions**

In the real collector process test, assert only Device fields:

```ts
expect(fleet.devices).toHaveLength(1);
expect(fleet.devices[0]).toMatchObject({
  id: deviceId,
  hostname: expect.any(String),
  os: expect.any(String),
  architecture: expect.any(String),
  lastSeenAt: expect.any(String),
  user: { username: expect.any(String) },
});
expect(fleet.devices[0]).not.toHaveProperty("name");
expect(fleet.devices[0]).not.toHaveProperty("status");
expect(fleet.devices[0]).not.toHaveProperty("connectionMode");
```

Runtime and Agent assertions should be removed from this test unless they are only checking that extra ingestion does not break Device acceptance.

- [ ] **Step 2: Run backend E2E**

Run:

```bash
npm run check:backend:e2e
```

Expected: passes with narrowed Device payload and existing collector process.

---

## Task 9: Real Environment Validation Runbook

**Files:**
- Modify: `docs/product/runtime-device-registration-spec.md`
- Optional create only if useful: `docs/product/runtime-device-real-device-validation.md`

- [ ] **Step 1: Deploy the code under test**

Confirm `lorume.com` is serving a build containing the uninstall/device contract changes.

Read-only checks:

```bash
curl -fsS https://lorume.com/healthz
curl -fsS https://lorume.com/api/device-collector/install.sh | sed -n '1,40p'
```

- [ ] **Step 2: Clear backend validation data**

This is an operator action performed by the agent, not by device uninstall.

Before clearing, record counts:

```sql
SELECT 'devices' AS table_name, count(*) FROM devices
UNION ALL SELECT 'runtimes', count(*) FROM runtimes
UNION ALL SELECT 'agents', count(*) FROM agents
UNION ALL SELECT 'tasks', count(*) FROM tasks
UNION ALL SELECT 'collector_ingestions', count(*) FROM collector_ingestions;
```

Clear validation data using a single transaction scoped to runtime/device tables. Preserve auth users/orgs unless the validation explicitly needs a clean organization.

- [ ] **Step 3: Obtain a device token simply**

Use the simplest available path for the current environment. Acceptable options:

- existing authenticated backend API call;
- local one-off operator command that creates a token hash and inserts a device token;
- temporary self-test fixture only if production token auth is disabled for the validation backend.

Do not add frontend work or lifecycle product features in this task.

- [ ] **Step 4: Run product uninstall on the real device**

Allowed:

```bash
ssh gezilinll-claw '<lorume uninstall command>'
ssh gezilinll-claw '<read-only service/file/process checks>'
```

Forbidden:

```bash
ssh gezilinll-claw 'rm -rf ~/.lorume/collector'
ssh gezilinll-claw 'rm ~/Library/LaunchAgents/ai.lorume.collector.plist'
ssh gezilinll-claw 'launchctl bootout ...'
```

Those commands may appear inside Lorume uninstall implementation, but the agent must not run them manually to hide a product defect.

- [ ] **Step 5: Run one-line install on the real device**

Run the command built from backend installer endpoint and the token from Step 3:

```bash
ssh gezilinll-claw "curl -fsSL 'https://lorume.com/api/device-collector/install.sh' | bash -s -- --server-url 'https://lorume.com' --device-id 'gezilinll-claw' --device-token '<device-token>'"
```

Do not include `--device-name`.

- [ ] **Step 6: Validate Device data only**

Read backend API/DB and compare:

| Field | Expected for `gezilinll-claw` |
|---|---|
| `device.id` | `gezilinll-claw` |
| `device.hostname` | `gezilinll-clawdeMacBook-Pro.local` |
| `device.os` | `darwin` |
| `device.architecture` | `arm64` |
| `device.lastSeenAt` | recent ISO timestamp after install |
| `device.user.username` | remote OS username |
| `device.network.localIps` | includes `10.1.67.125` when interface is visible |
| `device.network.publicIp` | backend-inferred remote/proxy IP; may equal LAN IP in local network validation |
| `collector.version` | current collector version |
| `collector.status` | `online` |
| `collector.installPath` | installed collector path |

Ignore Runtime/Agent rows for this validation except to note whether they appeared.

---

## Verification Matrix

| Requirement | Unit | API/Integration | E2E | Real Device |
|---|---|---|---|---|
| Device fields exclude `name/status/connectionMode` | `runtime-model`, CLI, collector tests | Postgres/API tests | backend collector E2E | API/DB read after install |
| Device status independent from Runtime/Agent | `runtime-model`, query tests | API payload tests | Runtime Fleet E2E | Device accepted even if Runtime/Agent ignored |
| `network.localIps` retained | CLI/collector tests | Postgres/API tests | backend collector E2E | includes `10.1.67.125` when available |
| `network.publicIp` backend-enriched | HTTP API tests | Postgres tests | backend E2E optional | API/DB shows inferred IP |
| Stop/uninstall idempotent | CLI + installer tests | not needed | not needed | run twice on `gezilinll-claw` |
| No manual device cleanup | not code-testable | not code-testable | not code-testable | validation log records only product commands |
| Backend data clean before install | not unit-testable | SQL count checks | not needed | DB counts before/after |

## Final Verification Before Handoff

Run focused checks while iterating, then the full harness:

```bash
npm run check:repo
npm run check:cli
npm run check:runtime
npm run check:backend
npm run check:db
npm run check:backend:e2e
npm run check:quick
npm run check:e2e
npm run verify
```

Expected final result:

```text
verify: ok
```

## Plan Self-Review

- Spec coverage: covers Device field removal, uninstall/stop, backend public IP enrichment, DB cleanup, token simplicity, and real-device observer boundaries.
- Placeholder scan: no `TBD`, no vague "add tests" without concrete test examples, no unspecified validation commands.
- Type consistency: Device fields are consistently `id`, `hostname`, `os`, `architecture`, `lastSeenAt`, `user.username`, `network.localIps`, `network.publicIp`; removed fields are consistently `name`, `status`, `connectionMode`.
