# Runtime Fleet Remaining Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收口 Runtime Fleet 截图验收中遗留的设备网络、状态、路径和筛选 UI 问题，让页面展示更稳定、更少噪音。

**Architecture:** 保持当前 `Device -> Runtime -> Agent -> Task` 四对象模型和线性关系，不迁移内部 ID、不新增实体、不恢复历史兼容逻辑。Collector/adapter 负责把本机事实规范化为 Lorume 字段，Runtime Fleet 只消费后端查询模型，不在 React 里猜测平台语义。

**Tech Stack:** TypeScript, React, Vitest, Playwright, Node collector scripts, Postgres-backed backend APIs.

---

## Current Decisions

- 完整 Lorume 内部 ID 不再作为详情正文展示；详情通过 `复制 ID` 按钮复制内部 ID。不要切换 UUID，不做 ID 迁移。
- Device、Runtime、Agent 的状态仍然独立计算。Device 离线不强制把 Runtime/Agent 改成异常。
- Device 普通断连应显示 `离线`；只有 control-plane 真错误、最近 `device_state` 失败或首次同步超时才显示 `异常`。
- Runtime/Agent 只展示 `collectionStatus`：`同步中 / 在线 / 离线 / 异常`。工作忙闲、任务失败数量只能作为 Task 派生信息。
- 自动化测试不得写真实生产后端或生产数据库；真实设备验证只能作为观察者验收，发现缺口后回到项目代码/测试修复，再重新验证。
- 长期规则进对应 product spec 和 harness；这份文件是执行方案，不替代 product spec。

## Files To Touch

- `docs/product/runtime-fleet-page-spec.md`: 更新字段策略、状态阈值、筛选 UI 非目标和验收标准。
- `docs/product/runtime-device-registration-spec.md`: 约束 Device 网络采集字段，明确 `localIps` 的过滤规则。
- `src/runtime/runtime-device-health.ts`: 如需调整 heartbeat 判定，集中在这里改默认阈值和 reason，不在页面层写状态逻辑。
- `src/runtime/runtime-device-health.test.ts`: 覆盖 transient heartbeat loss、control error、device_state failed、first sync timeout。
- `scripts/lorume-runtime-adapters.mjs`: 规范 `collectLocalIps()`、Runtime root path、Slock Agent diagnostics path。
- `scripts/lorume-device-collector.mjs`: 保持与 adapter 侧 `collectLocalIps()` 同步。
- `src/runtime/device-collector-script.test.ts`: 覆盖 collector 生成的网络字段和 metadata snapshot。
- `src/cli/lorume-cli.test.ts`: 覆盖 `lorume collect device-state` 侧网络字段和 Runtime/Agent diagnostics。
- `src/runtime/runtime-fleet-query.ts`: 调整详情字段格式，例如 local IP 展示、空路径展示和筛选数据流。
- `src/runtime/runtime-fleet-query.test.ts`: 覆盖 Runtime Fleet detail model。
- `src/runtime/RuntimeFleetPage.tsx`: 移除筛选 toolbar，保留轻量聚合视图。
- `src/App.test.tsx`: 覆盖页面不展示筛选条、详情字段可读、复制 ID 行为保留。
- `e2e/runtime-fleet.spec.ts`: 更新浏览器验收，去掉搜索/筛选操作，保留详情打开和响应式检查。

## Task 1: Spec Alignment

- [ ] **Step 1: Update Runtime Fleet spec**

  In `docs/product/runtime-fleet-page-spec.md`, change these rules:

  ```markdown
  - Runtime Fleet 当前不展示搜索、Runtime kind 和同步时间筛选条；页面先作为轻量聚合视图展示全量 Device、Runtime 和 Agent。
  - Device 网络详情展示去噪后的本机局域网 IP 和公网 IP。`localIps` 只展示 collector 认为对用户有解释价值的地址，不展示 link-local IPv6、虚拟网桥、Docker/VM/VPN 噪音地址。
  - Runtime 详情的本地路径只展示 Runtime 根目录；adapter 内部文件、状态库、sessions 子目录等不作为默认详情字段展示。
  - Agent 本地路径只在 adapter 能证明存在本机目录时展示；没有本机目录时显示 `不适用`，不能留空造成漏采集错觉。
  ```

- [ ] **Step 2: Update registration spec**

  In `docs/product/runtime-device-registration-spec.md`, add Device network collection rules:

  ```markdown
  `Device.network.localIps` is a user-facing, normalized list of local addresses. The collector must prefer active private IPv4 addresses and must drop loopback, link-local IPv6, Docker/VM bridge ranges, and interface network placeholder addresses. If no private IPv4 exists, the collector may include at most one globally routable IPv6 address. Public IP is stored separately as `Device.network.publicIp` when the backend can derive it from the request.
  ```

- [ ] **Step 3: Run doc harness**

  Run:

  ```sh
  npm run check:repo
  ```

  Expected: `check:repo: ok`.

## Task 2: Device Local IP Normalization

- [ ] **Step 1: Write failing collector/CLI tests**

  Add tests that assert `collectLocalIps()` drops noisy addresses and keeps useful private IPv4 addresses. If direct function import is not available because the scripts are executable modules, add a small exported or test-only helper only if it does not change runtime behavior.

  Required sample input:

  ```ts
  [
    { address: "127.0.0.1", internal: true },
    { address: "10.1.67.125", internal: false },
    { address: "192.168.107.0", internal: false },
    { address: "192.168.139.3", internal: false },
    { address: "172.17.0.1", internal: false },
    { address: "fe80::2d47:7ef3:5ff2:3f4a", internal: false },
    { address: "fd07:b51a:cc66:0:a617:db5e:ab7:e9f1", internal: false }
  ]
  ```

  Expected normalized result:

  ```ts
  ["10.1.67.125", "192.168.139.3"]
  ```

  Do not keep `192.168.x.0` addresses because they are usually network placeholder addresses, not useful host addresses.

- [ ] **Step 2: Run tests and verify failure**

  Run:

  ```sh
  npm run test:run -- src/runtime/device-collector-script.test.ts src/cli/lorume-cli.test.ts
  ```

  Expected before implementation: at least one assertion fails because current `collectLocalIps()` returns every non-internal address.

- [ ] **Step 3: Implement one shared normalization rule**

  Update both `scripts/lorume-runtime-adapters.mjs` and `scripts/lorume-device-collector.mjs` so `collectLocalIps()` uses the same rule:

  - Skip `entry.internal`.
  - Keep IPv4 only for the first version.
  - Keep only RFC1918 ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
  - Drop `*.0` and `*.255` host endings.
  - Drop common bridge/container ranges unless no better private IPv4 exists: `172.16.0.0/12` can be kept only when no `10.*` or `192.168.*` address exists.
  - Return unique sorted values.

- [ ] **Step 4: Run focused tests**

  Run:

  ```sh
  npm run test:run -- src/runtime/device-collector-script.test.ts src/cli/lorume-cli.test.ts src/runtime/runtime-fleet-query.test.ts
  ```

  Expected: all selected tests pass.

## Task 3: Device Status Threshold Review

- [ ] **Step 1: Add tests for current desired status semantics**

  In `src/runtime/runtime-device-health.test.ts`, add concrete assertions using the existing `deriveDeviceHealthStatus` API:

  ```ts
  it("keeps a device online after one missed heartbeat interval when device-state is fresh", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:50:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:15.000Z",
      },
      deviceStateIngestions: [{
        deviceId: "device-a",
        snapshotType: "device_state",
        status: "succeeded",
        collectedAt: "2026-05-21T08:58:30.000Z",
        receivedAt: "2026-05-21T08:59:00.000Z",
        counts: { devices: 1 },
        diagnostics: [],
      }],
    })).toMatchObject({
      status: "online",
      reason: "heartbeat_and_device_state_fresh",
    });
  });

  it("returns offline, not error, after multiple missed heartbeats when the last device-state succeeded", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "stale",
        connectedAt: "2026-05-21T08:50:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:58:00.000Z",
      },
      deviceStateIngestions: [{
        deviceId: "device-a",
        snapshotType: "device_state",
        status: "succeeded",
        collectedAt: "2026-05-21T08:58:30.000Z",
        receivedAt: "2026-05-21T08:59:00.000Z",
        counts: { devices: 1 },
        diagnostics: [],
      }],
    })).toMatchObject({
      status: "offline",
      reason: "device_state_or_heartbeat_stale",
    });
  });
  ```

  Existing tests already cover `last_device_state_failed`, `first_sync_timeout`, and `control_error`; keep those assertions and do not invent UI-level status rules.

- [ ] **Step 2: Run tests and inspect result**

  Run:

  ```sh
  npm run test:run -- src/runtime/runtime-device-health.test.ts src/server/runtime-control-channel.test.ts
  ```

  Expected: existing threshold may already satisfy the first two assertions because default `heartbeatFreshMs` is `90_000`; if it fails, fix only `src/runtime/runtime-device-health.ts` or control-channel stale/error handling.

- [ ] **Step 3: Fix only proven gaps**

  If a successful heartbeat does not clear previous transient connection errors, update `src/server/runtime-control-channel.ts` so a later successful hello/heartbeat represents the current connection state. Keep real `lastError` only for current unresolved control-plane errors.

- [ ] **Step 4: Run backend status checks**

  Run:

  ```sh
  npm run test:run -- src/runtime/runtime-device-health.test.ts src/server/runtime-control-channel.test.ts src/server/runtime-http-api.test.ts
  ```

  Expected: all selected tests pass.

## Task 4: Runtime And Agent Local Path Display

- [ ] **Step 1: Write failing adapter/query tests**

  Add assertions:

  ```ts
  const home = "/tmp/lorume-home";
  expect(openClawRuntime.diagnostics.paths).toEqual([{ label: "根目录", path: `${home}/.openclaw` }]);
  expect(codexRuntime.diagnostics.paths).toEqual([{ label: "根目录", path: `${home}/.codex` }]);
  expect(slockAgentWithLocalDir.diagnostics.paths).toEqual([{ label: "根目录", path: `${home}/.slock/agents/pmo` }]);
  expect(slockAgentWithoutLocalDir.diagnostics.paths ?? []).toEqual([]);
  ```

  In `src/runtime/runtime-fleet-query.test.ts`, assert empty Agent paths render as:

  ```ts
  ["不适用"]
  ```

  if the detail section remains visible.

- [ ] **Step 2: Run tests and verify failure**

  Run:

  ```sh
  npm run test:run -- src/cli/lorume-cli.test.ts src/runtime/runtime-fleet-query.test.ts
  ```

  Expected before implementation: OpenClaw/Codex runtime paths still show adapter-specific subpaths, and Slock Agent paths are empty.

- [ ] **Step 3: Normalize adapter paths**

  Update `scripts/lorume-runtime-adapters.mjs`:

  - OpenClaw Runtime path: `[{ label: "根目录", path: path.join(homeDir(), ".openclaw") }]`
  - Codex Runtime path: `[{ label: "根目录", path: codexRoot }]`
  - Slock Agent path: use `LORUME_SLOCK_HOME || ~/.slock`; if `~/.slock/agents/<profileId>` exists, set `[{ label: "根目录", path }]`; otherwise leave diagnostics path empty.

  Do not fake paths from API-only Slock profile data.

- [ ] **Step 4: Normalize empty path display**

  Update `src/runtime/runtime-fleet-query.ts` so a path section that is intentionally empty can show `不适用` for Agent details instead of blank `暂无`. Keep Runtime empty paths as `暂无` because Runtime should normally have a root directory when detected.

- [ ] **Step 5: Run focused checks**

  Run:

  ```sh
  npm run test:run -- src/cli/lorume-cli.test.ts src/runtime/runtime-fleet-query.test.ts src/App.test.tsx
  ```

  Expected: all selected tests pass.

## Task 5: Remove Runtime Fleet Filter Toolbar

- [ ] **Step 1: Update failing UI tests**

  In `src/App.test.tsx`, assert Runtime Fleet no longer renders:

  ```ts
  expect(screen.queryByLabelText("运行资产筛选")).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText("搜索设备、Runtime、Agent 或任务")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("RUNTIME")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("同步时间")).not.toBeInTheDocument();
  ```

  Update any existing tests that type into the search box to instead click rows directly.

- [ ] **Step 2: Update Playwright Runtime Fleet spec**

  In `e2e/runtime-fleet.spec.ts`, remove search/filter interactions. Keep:

  - page opens Runtime Fleet;
  - Device/Runtime/Agent lists render;
  - clicking an Agent opens details;
  - no horizontal overflow at laptop widths.

- [ ] **Step 3: Run tests and verify failure**

  Run:

  ```sh
  npm run test:run -- src/App.test.tsx
  npm run test:e2e -- e2e/runtime-fleet.spec.ts
  ```

  Expected before implementation: tests fail because toolbar still exists.

- [ ] **Step 4: Remove toolbar UI and unused state**

  Update `src/runtime/RuntimeFleetPage.tsx`:

  - Remove `query`, `runtimeKind`, `lastSeenRange`, `runtimeKindOptions`, and toolbar JSX.
  - Use the full current snapshot for list rendering.
  - Keep summary cards, Device list, Runtime list, Agent list, detail panel, Skill probe button, and copy ID button.

  Update `src/runtime/runtime-fleet-query.ts` only if the filter helpers become unused; remove dead exports and tests instead of keeping compatibility for deleted UI.

- [ ] **Step 5: Run focused checks**

  Run:

  ```sh
  npm run test:run -- src/runtime/runtime-fleet-query.test.ts src/App.test.tsx
  npm run test:e2e -- e2e/runtime-fleet.spec.ts
  ```

  Expected: all selected tests pass.

## Final Verification

- [ ] **Step 1: Run quick harness**

  ```sh
  npm run check:quick
  ```

  Expected: typecheck and Vitest pass.

- [ ] **Step 2: Run repo docs harness**

  ```sh
  npm run check:repo
  ```

  Expected: `check:repo: ok`.

- [ ] **Step 3: Run Runtime Fleet browser harness**

  ```sh
  npm run test:e2e -- e2e/runtime-fleet.spec.ts
  ```

  Expected: all Runtime Fleet browser tests pass.

- [ ] **Step 4: Optional observer validation on real device**

  After code is merged and deployed, run real-device observation without manual DB or filesystem intervention:

  - start collector on `gezilinll-claw`;
  - wait for one successful metadata snapshot;
  - open Runtime Fleet;
  - confirm `localIps` is concise, Device status does not flicker to `异常` on ordinary reconnect, Runtime paths are root directories, and Slock Agent path is either a real root path or `不适用`.

  If observation finds a gap, add/adjust a harness first, fix project code, redeploy, then re-run observation.
