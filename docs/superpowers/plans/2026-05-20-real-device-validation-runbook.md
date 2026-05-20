# Real Device Validation Runbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the deployed Lorume collector uninstall/reinstall flow on the real `gezilinll-claw` device, then verify only the Device-level inventory facts reported to the backend.

**Architecture:** Treat the real device as an acceptance environment, not a place to patch state by hand. The backend/database preparation is operator-owned, while device cleanup must happen only through Lorume stop/uninstall/install product capabilities. Any behavior gap discovered on the real device must feed back into the test pyramid before the code is changed or the real-device step is retried.

**Tech Stack:** SSH, Bash installer/uninstaller, Lorume CLI, HTTPS backend APIs at `lorume.com`, Postgres SQL, Vitest focused checks, Playwright backend E2E, full `./scripts/verify.sh` harness.

---

## Non-Negotiable Validation Rules

| Rule | Meaning |
|---|---|
| Product cleanup only | On `gezilinll-claw`, run Lorume stop/uninstall/install commands only. Do not manually remove install directories, launchd plists, systemd units, logs, or processes to make validation pass. |
| Read-only inspection | After uninstall or install, SSH checks may inspect files, services, processes, and logs. If residue exists, stop the procedure and fix Lorume's uninstall capability. |
| Test pyramid feedback | A real-device failure is not just an ops issue. First classify whether it exposes a missing automated test. If yes, write the smallest failing unit/API/E2E test, verify it fails, implement the fix, rerun focused checks, rerun `./scripts/verify.sh`, redeploy, then retry the real-device step. |
| Scope of acceptance | This run validates Device facts only. Runtime and Agent rows may appear, but they are not acceptance criteria for this run. |
| No frontend dependency | Do not add or rely on a frontend registration flow. Token creation may use the authenticated backend API or a simple operator path. |
| Secrets discipline | Do not paste device tokens, session cookies, login codes, or production DB URLs into docs, commits, screenshots, or final summaries. |

## Known Real Device

| Field | Value |
|---|---|
| SSH target | `gezilinll-claw` |
| Expected LAN IP | `10.1.67.125` |
| Expected hostname | `gezilinll-clawdeMacBook-Pro.local` |
| Expected OS | `darwin` |
| Expected architecture | `arm64` |
| Device id for this run | `gezilinll-claw` |

## File Map

| File | Responsibility During This Run |
|---|---|
| `docs/product/runtime-device-registration-spec.md` | Durable source of truth for Device facts, uninstall observer rule, and real-device acceptance. Update only if the run discovers durable behavior that the product spec missed. |
| `docs/product/cli-device-capability-spec.md` | Durable CLI contract for `lorume collector stop` and `lorume collector uninstall`. Update only if command semantics change. |
| `scripts/install-device-collector.sh` | Installer, stopper, and uninstaller implementation. Fix this if real-device service/file cleanup fails. |
| `scripts/lorume.mjs` | CLI wrapper for `collector stop/uninstall`. Fix this if CLI delegation or JSON output fails. |
| `scripts/lorume-device-collector.mjs` | Device-side collection and upload script. Fix this if real-device upload, config, or local facts are wrong. |
| `src/runtime/device-collector-script.test.ts` | Unit/script-level coverage for installer, stop, uninstall, and collector once-mode behavior. Add the first regression here for installer or collector script gaps. |
| `src/cli/lorume-cli.test.ts` | CLI contract coverage. Add the first regression here for `lorume collector stop/uninstall` gaps. |
| `src/server/runtime-http-api.test.ts` | API-level ingestion and network enrichment coverage. Add the first regression here for HTTP ingestion or `network.publicIp` gaps. |
| `e2e/runtime-backend-api.spec.ts` | Backend E2E for real collector process upload. Add the first regression here for backend plus collector process integration gaps. |

## Testing Feedback Gate

Before changing code for any real-device issue, classify the finding:

| Finding Type | Required First Automated Test | Focused Check After Fix |
|---|---|---|
| CLI command missing, wrong JSON, wrong exit code, wrong installer args | `src/cli/lorume-cli.test.ts` | `npm run check:cli -- src/cli/lorume-cli.test.ts` |
| Installer does not stop service, keeps wrong files, deletes unsafe path, or writes wrong config | `src/runtime/device-collector-script.test.ts` | `npm run check:runtime -- src/runtime/device-collector-script.test.ts` |
| Collector emits wrong Device facts or reintroduces `name/status/connectionMode` | `src/runtime/device-collector-script.test.ts` or `src/runtime/runtime-normalize.test.ts` | `npm run check:runtime` |
| Backend accepts bad payload or fails to enrich `network.publicIp` | `src/server/runtime-http-api.test.ts` | `npm run check:backend` |
| DB persists old fields or migration misses deployed schema | `src/server/db-migrate.test.ts` and `src/server/postgres-store.test.ts` | `npm run check:db` |
| Collector process cannot upload to backend in once mode | `e2e/runtime-backend-api.spec.ts` | `npm run check:backend:e2e` |
| UI displays removed fields or mixes Device/Runtime/Agent state | `src/runtime/runtime-inventory-query.test.ts`, `src/App.test.tsx`, or `e2e/runtime-fleet.spec.ts` | `npm run check:quick && npm run check:e2e` |
| Pure environment issue with no code behavior gap | Record evidence in the validation notes, do not add artificial tests. |

Every code fix discovered during this run must finish with:

```bash
./scripts/verify.sh
```

Expected:

```text
verify: ok
```

## Task 1: Confirm The Deployed Backend Serves The New Collector Bits

**Files:**
- Read: `src/backend/device-installer-http-api.ts`
- Read: `scripts/install-device-collector.sh`
- Read: `scripts/lorume.mjs`
- Optional modify after a gap: `src/backend/backend-server.test.ts`

- [ ] **Step 1: Set local shell variables for this validation run**

```bash
export LORUME_SERVER_URL="https://lorume.com"
export LORUME_DEVICE_ID="gezilinll-claw"
export LORUME_SSH_TARGET="gezilinll-claw"
```

- [ ] **Step 2: Check backend health and readiness**

```bash
curl -fsS "$LORUME_SERVER_URL/healthz"
curl -fsS "$LORUME_SERVER_URL/readyz"
```

Expected: both commands return successful health/readiness responses.

- [ ] **Step 3: Inspect the deployed installer entrypoint**

```bash
curl -fsSL "$LORUME_SERVER_URL/api/device-collector/install.sh" | sed -n '1,140p'
```

Expected: the script downloads `install-device-collector.sh`, `lorume-device-collector.mjs`, `lorume-runtime-adapters.mjs`, and `lorume.mjs` from `/api/device-collector/files/...`.

- [ ] **Step 4: Confirm the deployed installer command path does not expose old Device name arguments**

```bash
if curl -fsSL "$LORUME_SERVER_URL/api/device-collector/install.sh" | grep -q -- "--device-name"; then
  echo "FAIL: deployed installer still mentions --device-name" >&2
  exit 1
fi
```

Expected: command exits `0` and prints nothing.

- [ ] **Step 5: If Step 4 fails, add an automated regression before fixing deployment code**

Add or extend `src/backend/backend-server.test.ts` so the installer endpoint response is asserted not to contain `--device-name`:

```ts
expect(installerScript).not.toContain("--device-name");
```

Run:

```bash
npm run check:backend -- src/backend/backend-server.test.ts
```

Expected before the fix: failing test proves the deployed/package contract gap is real. After the fix and redeploy: pass.

## Task 2: Record Backend State And Clear Runtime Validation Data

**Files:**
- Read: `db/migrations/0001_backend_core.sql`
- Read: `db/migrations/0010_narrow_device_facts.sql`
- Optional modify after a gap: `src/server/db-migrate.test.ts`
- Optional modify after a gap: `src/server/postgres-store.test.ts`

- [ ] **Step 1: Set the production or target database URL only in shell memory**

```bash
read -rsp "DATABASE_URL for validation target: " DATABASE_URL
export DATABASE_URL
printf '\n'
```

Expected: no secret is printed.

- [ ] **Step 2: Record pre-clean counts**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT 'devices' AS table_name, count(*) FROM devices
UNION ALL SELECT 'runtimes', count(*) FROM runtimes
UNION ALL SELECT 'agents', count(*) FROM agents
UNION ALL SELECT 'collector_ingestions', count(*) FROM collector_ingestions
UNION ALL SELECT 'work_items', count(*) FROM work_items
UNION ALL SELECT 'work_conversations', count(*) FROM work_conversations
UNION ALL SELECT 'work_executions', count(*) FROM work_executions
ORDER BY table_name;
"
```

Expected: counts are visible in terminal for operator notes, not committed.

- [ ] **Step 3: Confirm old Device columns are absent**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'devices'
  AND column_name IN ('name', 'status', 'connection_mode')
ORDER BY column_name;
"
```

Expected: zero rows.

- [ ] **Step 4: If Step 3 returns rows, stop and fix migration coverage**

First add a regression in `src/server/db-migrate.test.ts` asserting migration `0010_narrow_device_facts` is present and removes the old columns from an upgraded schema. Then run:

```bash
npm run check:db
```

Expected before the fix: failing DB test. After the fix and migration deployment: pass.

- [ ] **Step 5: Clear runtime validation data only**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
BEGIN;
TRUNCATE TABLE
  collector_ingestions,
  agent_skill_probe_snapshots,
  agent_skill_probe_requests,
  work_executions,
  work_conversations,
  work_items,
  agents,
  runtimes,
  devices
RESTART IDENTITY CASCADE;
COMMIT;
"
```

Expected: runtime/device validation data is empty while users, organizations, memberships, sessions, invitations, and device tokens are preserved unless the operator intentionally clears tokens separately.

- [ ] **Step 6: Record post-clean counts**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT 'devices' AS table_name, count(*) FROM devices
UNION ALL SELECT 'runtimes', count(*) FROM runtimes
UNION ALL SELECT 'agents', count(*) FROM agents
UNION ALL SELECT 'collector_ingestions', count(*) FROM collector_ingestions
UNION ALL SELECT 'work_items', count(*) FROM work_items
UNION ALL SELECT 'work_conversations', count(*) FROM work_conversations
UNION ALL SELECT 'work_executions', count(*) FROM work_executions
ORDER BY table_name;
"
```

Expected: listed runtime/device tables have count `0`.

## Task 3: Create A Device Token Without Adding Frontend Work

**Files:**
- Read: `src/auth/auth-http-api.ts`
- Read: `src/settings/OrganizationSettingsPage.tsx`
- Optional modify after a gap: `src/auth/auth-http-api.test.ts`

- [ ] **Step 1: Use an authenticated owner/admin session to request an email login code**

```bash
export LORUME_OPERATOR_EMAIL="your-admin-email@example.com"
curl -fsS -c /tmp/lorume-real-device-cookies.txt \
  -H "content-type: application/json" \
  -d "{\"email\":\"$LORUME_OPERATOR_EMAIL\"}" \
  "$LORUME_SERVER_URL/api/auth/email-code"
```

Expected: response status is accepted and the login code is delivered through the configured email provider.

- [ ] **Step 2: Enter the login code into shell memory**

```bash
read -rsp "Lorume login code: " LORUME_LOGIN_CODE
export LORUME_LOGIN_CODE
printf '\n'
```

Expected: no login code is printed.

- [ ] **Step 3: Login and capture the organization id**

```bash
curl -fsS -b /tmp/lorume-real-device-cookies.txt -c /tmp/lorume-real-device-cookies.txt \
  -H "content-type: application/json" \
  -d "{\"email\":\"$LORUME_OPERATOR_EMAIL\",\"code\":\"$LORUME_LOGIN_CODE\"}" \
  "$LORUME_SERVER_URL/api/auth/login" \
  | node -e '
let body = "";
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(body);
  const organization = parsed.organizations?.[0];
  if (!organization?.organizationId) {
    console.error("No organizationId in login response");
    process.exit(1);
  }
  console.log(`export LORUME_ORGANIZATION_ID=${organization.organizationId}`);
});
'
```

Expected: terminal prints one `export LORUME_ORGANIZATION_ID=...` command. Run that printed export command in the same shell.

- [ ] **Step 4: Create a one-time plaintext device token and keep it only in shell memory**

```bash
curl -fsS -b /tmp/lorume-real-device-cookies.txt \
  -H "content-type: application/json" \
  -d "{\"deviceId\":\"$LORUME_DEVICE_ID\",\"name\":\"$LORUME_DEVICE_ID\"}" \
  "$LORUME_SERVER_URL/api/organizations/$LORUME_ORGANIZATION_ID/device-tokens" \
  | node -e '
let body = "";
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(body);
  const token = parsed.deviceToken?.token;
  if (!token || !token.startsWith("agt_device_")) {
    console.error("No plaintext device token in response");
    process.exit(1);
  }
  console.log(`export LORUME_DEVICE_TOKEN=${token}`);
});
'
```

Expected: terminal prints one `export LORUME_DEVICE_TOKEN=...` command. Run that printed export command in the same shell. Do not paste the token into docs or final summaries.

- [ ] **Step 5: If token creation fails, add API coverage before changing auth code**

Add or extend `src/auth/auth-http-api.test.ts` around `POST /api/organizations/:organizationId/device-tokens` and prove the current failure. Then run:

```bash
npm run check:backend -- src/auth/auth-http-api.test.ts
```

Expected before the fix: failing test. After the fix: pass.

## Task 4: Run Lorume Product Uninstall On The Real Device

**Files:**
- Read: `scripts/lorume.mjs`
- Read: `scripts/install-device-collector.sh`
- Optional modify after a gap: `src/cli/lorume-cli.test.ts`
- Optional modify after a gap: `src/runtime/device-collector-script.test.ts`

- [ ] **Step 1: Probe the device without changing state**

```bash
ssh "$LORUME_SSH_TARGET" 'hostname; uname -a; command -v node || true; test -d "$HOME/.lorume/collector" && echo "collector-dir-present" || echo "collector-dir-absent"; launchctl list 2>/dev/null | grep -i lorume || true'
```

Expected: SSH succeeds. Record whether the collector directory or service appears.

- [ ] **Step 2: Run product stop if the installed CLI exists**

```bash
ssh "$LORUME_SSH_TARGET" 'if test -x "$HOME/.lorume/collector/lorume.mjs"; then node "$HOME/.lorume/collector/lorume.mjs" collector stop --json --install-dir "$HOME/.lorume/collector"; else echo "installed Lorume CLI not found; skip stop and use installer uninstall after redeploy"; fi'
```

Expected: either JSON reports `collector.stop` succeeded, or the device clearly reports that the old CLI is absent.

- [ ] **Step 3: Run product uninstall using the deployed installer when the old CLI is absent or stale**

```bash
ssh "$LORUME_SSH_TARGET" "curl -fsSL '$LORUME_SERVER_URL/api/device-collector/install.sh' | bash -s -- --install-dir \"\$HOME/.lorume/collector\" --uninstall"
```

Expected: uninstall exits `0`.

- [ ] **Step 4: Inspect for residue using read-only checks**

```bash
ssh "$LORUME_SSH_TARGET" 'set -eu
test ! -d "$HOME/.lorume/collector" && echo "install-dir-removed"
test ! -f "$HOME/Library/LaunchAgents/ai.lorume.collector.plist" && echo "launchd-plist-removed"
if pgrep -fl "lorume-device-collector" >/tmp/lorume-processes.txt 2>/dev/null; then
  cat /tmp/lorume-processes.txt
  exit 1
fi
echo "collector-process-absent"
'
```

Expected: prints `install-dir-removed`, `launchd-plist-removed`, and `collector-process-absent`.

- [ ] **Step 5: If residue remains, do not manually delete it**

Add the smallest automated regression:

```bash
npm run check:runtime -- src/runtime/device-collector-script.test.ts
npm run check:cli -- src/cli/lorume-cli.test.ts
```

Expected: add a failing test that represents the residue class, then fix `scripts/install-device-collector.sh` or `scripts/lorume.mjs`, rerun focused checks and `./scripts/verify.sh`, redeploy, and retry Task 4 from Step 1.

## Task 5: Run The One-Line Install Command On The Real Device

**Files:**
- Read: `scripts/install-device-collector.sh`
- Read: `scripts/lorume-device-collector.mjs`
- Optional modify after a gap: `src/runtime/device-collector-script.test.ts`
- Optional modify after a gap: `e2e/runtime-backend-api.spec.ts`

- [ ] **Step 1: Confirm the token variable exists without printing it**

```bash
test -n "$LORUME_DEVICE_TOKEN"
```

Expected: exits `0`.

- [ ] **Step 2: Execute the one-line installer**

```bash
ssh "$LORUME_SSH_TARGET" "curl -fsSL '$LORUME_SERVER_URL/api/device-collector/install.sh' | bash -s -- --server-url '$LORUME_SERVER_URL' --device-id '$LORUME_DEVICE_ID' --device-token '$LORUME_DEVICE_TOKEN'"
```

Expected: install exits `0`; it does not include `--device-name`.

- [ ] **Step 3: Inspect installation state without changing it**

```bash
ssh "$LORUME_SSH_TARGET" 'set -eu
test -d "$HOME/.lorume/collector" && echo "install-dir-present"
test -f "$HOME/.lorume/collector/config.json" && echo "config-present"
test -f "$HOME/.lorume/collector/lorume-device-collector.mjs" && echo "collector-present"
node -e '"'"'
const fs = require("fs");
const path = `${process.env.HOME}/.lorume/collector/config.json`;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
if (config.deviceName || config.name) process.exit(2);
if (config.deviceId !== "gezilinll-claw") process.exit(3);
console.log("config-device-id-ok");
'"'"'
'
```

Expected: prints `install-dir-present`, `config-present`, `collector-present`, and `config-device-id-ok`.

- [ ] **Step 4: If install or config shape fails, add a regression before changing code**

Add the first failing test to `src/runtime/device-collector-script.test.ts` for installer/config behavior, then run:

```bash
npm run check:runtime -- src/runtime/device-collector-script.test.ts
```

Expected before fix: failing test. After fix and redeploy: pass.

## Task 6: Validate Device-Level Data In Backend

**Files:**
- Read: `src/runtime/runtime-normalize.ts`
- Read: `src/server/postgres-store.ts`
- Read: `src/runtime/runtime-inventory-query.ts`
- Optional modify after a gap: `src/server/runtime-http-api.test.ts`
- Optional modify after a gap: `src/runtime/runtime-inventory-query.test.ts`

- [ ] **Step 1: Poll the Runtime Fleet API using the authenticated session cookie**

```bash
for attempt in $(seq 1 30); do
  curl -fsS -b /tmp/lorume-real-device-cookies.txt "$LORUME_SERVER_URL/api/runtime-fleet" > /tmp/lorume-runtime-fleet.json
  node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync("/tmp/lorume-runtime-fleet.json", "utf8"));
const device = body.devices?.find((item) => item.id === process.env.LORUME_DEVICE_ID);
process.exit(device ? 0 : 1);
' && break
  sleep 5
done
```

Expected: loop exits before 30 attempts.

- [ ] **Step 2: Print only non-secret Device facts for review**

```bash
node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync("/tmp/lorume-runtime-fleet.json", "utf8"));
const device = body.devices?.find((item) => item.id === process.env.LORUME_DEVICE_ID);
if (!device) {
  console.error("Device not found");
  process.exit(1);
}
const facts = {
  id: device.id,
  hostname: device.hostname,
  os: device.os,
  architecture: device.architecture,
  lastSeenAt: device.lastSeenAt,
  user: { username: device.user?.username },
  network: {
    localIps: device.network?.localIps,
    publicIp: device.network?.publicIp,
  },
  collector: {
    version: device.collector?.version,
    status: device.collector?.status,
    installPath: device.collector?.installPath,
  },
};
console.log(JSON.stringify(facts, null, 2));
'
```

Expected facts:

| Field | Expected |
|---|---|
| `id` | `gezilinll-claw` |
| `hostname` | `gezilinll-clawdeMacBook-Pro.local` or the current OS hostname if the device has changed |
| `os` | `darwin` |
| `architecture` | `arm64` |
| `lastSeenAt` | recent ISO timestamp after install |
| `user.username` | remote OS username |
| `network.localIps` | includes `10.1.67.125` when the interface is visible |
| `network.publicIp` | backend-inferred IP from proxy or remote address |
| `collector.version` | current collector version |
| `collector.status` | `online` |
| `collector.installPath` | installed collector path |

- [ ] **Step 3: Assert removed fields are absent from the API payload**

```bash
node -e '
const fs = require("fs");
const raw = fs.readFileSync("/tmp/lorume-runtime-fleet.json", "utf8");
const body = JSON.parse(raw);
const device = body.devices?.find((item) => item.id === process.env.LORUME_DEVICE_ID);
if (!device) process.exit(1);
for (const field of ["name", "status", "connectionMode"]) {
  if (Object.prototype.hasOwnProperty.call(device, field)) {
    console.error(`Device unexpectedly includes ${field}`);
    process.exit(2);
  }
}
console.log("removed-device-fields-absent");
'
```

Expected: prints `removed-device-fields-absent`.

- [ ] **Step 4: Confirm persisted facts directly in Postgres**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT
  id,
  hostname,
  os,
  architecture,
  last_seen_at,
  raw->'device'->'user'->>'username' AS username,
  raw->'device'->'network'->'localIps' AS local_ips,
  raw->'device'->'network'->>'publicIp' AS public_ip,
  raw->'collector'->>'status' AS collector_status,
  raw->'collector'->>'installPath' AS collector_install_path
FROM devices
WHERE id = 'gezilinll-claw';
"
```

Expected: one row for `gezilinll-claw`, with Device facts matching the API output.

- [ ] **Step 5: If Device data is wrong, add the right regression before changing code**

Use this mapping:

| Wrong Observation | First Regression |
|---|---|
| API includes `name/status/connectionMode` | `src/runtime/runtime-normalize.test.ts` and `src/server/runtime-http-api.test.ts` |
| DB still has old columns | `src/server/db-migrate.test.ts` |
| `publicIp` is missing despite proxy/remote evidence | `src/server/runtime-http-api.test.ts` |
| `localIps` is missing due to collector interface parsing | `src/runtime/device-collector-script.test.ts` |
| Runtime/Agent status changes Device status | `src/runtime/runtime-inventory-query.test.ts` |

Run the focused check from the Testing Feedback Gate, then run:

```bash
./scripts/verify.sh
```

Expected: `verify: ok` before redeploy and retry.

## Task 7: Close The Validation Run

**Files:**
- Optional modify: `docs/product/runtime-device-registration-spec.md`
- Optional modify: `docs/product/cli-device-capability-spec.md`

- [ ] **Step 1: Summarize accepted Device facts without secrets**

Write a short local operator note outside committed docs that includes:

```text
Date:
Server:
Device id:
Hostname:
OS:
Architecture:
lastSeenAt:
user.username:
network.localIps:
network.publicIp:
collector.version:
collector.status:
collector.installPath:
Runtime/Agent rows present but ignored:
Unexpected observations:
Automated tests added:
```

Expected: no token, cookie, login code, DB URL, or private log content appears.

- [ ] **Step 2: Decide whether specs need durable updates**

Only update product specs if real-device validation changes durable product behavior. Examples:

| Observation | Spec Action |
|---|---|
| The accepted Device facts remain exactly as planned | No spec update needed. |
| macOS service path differs from spec | Update `docs/product/runtime-device-registration-spec.md`. |
| CLI stop/uninstall JSON shape changes | Update `docs/product/cli-device-capability-spec.md`. |
| A new non-goal or observer rule is discovered | Update `docs/product/runtime-device-registration-spec.md`. |

- [ ] **Step 3: Run final verification after any spec or code change**

```bash
./scripts/verify.sh
```

Expected:

```text
verify: ok
```

- [ ] **Step 4: Report completion status**

Report:

| Item | Include |
|---|---|
| Code version | branch/commit or deployment identifier |
| Real-device uninstall | passed/failed and residue summary |
| Real-device install | passed/failed |
| Device facts | accepted fields and any mismatch |
| Runtime/Agent | whether rows appeared, explicitly out of scope |
| Test pyramid feedback | tests added or reason no tests were needed |
| Remaining risk | launchd/systemd edge cases, network/proxy IP ambiguity, or token lifecycle items |

Do not include device token, session cookie, login code, or database URL.

## Verification Matrix

| Requirement | Automated Before Real Device | Real Device Acceptance |
|---|---|---|
| Installer installs collector and writes config | `src/runtime/device-collector-script.test.ts` | install directory and config exist on `gezilinll-claw` |
| Installer stop does not remove files | `src/runtime/device-collector-script.test.ts` | service/process stops while files remain when using stop |
| Installer uninstall removes product-owned files | `src/runtime/device-collector-script.test.ts` | install dir and service file absent after uninstall |
| CLI delegates stop/uninstall to installer | `src/cli/lorume-cli.test.ts` | installed CLI or deployed installer can perform cleanup |
| Device fields exclude `name/status/connectionMode` | runtime, API, DB, and E2E tests | API and DB payload for `gezilinll-claw` omit all three |
| Device status independent from Runtime/Agent | runtime/query tests | Device accepted even if Runtime/Agent rows appear |
| `network.localIps` captured | collector tests | includes `10.1.67.125` when visible |
| `network.publicIp` backend-enriched | HTTP API tests | API/DB shows backend-inferred public IP |
| Backend data clean before install | DB command, not unit-testable | counts are recorded as `0` before install |
| Test pyramid feedback loop | process rule | any real-device code gap adds a failing test first |

## Plan Self-Review

- Spec coverage: covers deployment preflight, DB cleanup, token creation without frontend work, product-only uninstall, one-line install, Device-only acceptance, and test-pyramid feedback.
- Placeholder scan: runtime secrets are captured through shell variables and `read -rsp`; no token, login code, or DB URL is written into the plan.
- Type consistency: Device fields are consistently `id`, `hostname`, `os`, `architecture`, `lastSeenAt`, `user.username`, `network.localIps`, `network.publicIp`, and `collector` metadata; removed fields are consistently `name`, `status`, and `connectionMode`.
