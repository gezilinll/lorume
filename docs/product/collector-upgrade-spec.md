# Collector Upgrade Spec

版本：TinySpec v0.1

Collector upgrade 是 Lorume 对已注册设备上的 Device Collector 做版本治理和受限自升级的正式能力。它把升级建模为用户可见的 Operation / Job，通过已认证的设备 WebSocket 下发窄控制消息，由 collector 在本机完成下载、校验、安装、重启确认和失败上报。

## 目标

- 服务端维护当前可安装的 collector 最新版本和白名单设备包 manifest。
- owner / admin 可以从 Runtime Fleet 对单台设备发起 collector 升级。
- 升级作为 `collector_upgrade` Operation 和 `collector_upgrade_device` Job 展示在 Operations 抽屉中，用户能看到实时阶段、结果和失败摘要。
- 服务端只向已通过 device token 认证、当前在线且声明支持升级协议的 collector 下发升级请求。
- Collector 在设备本机执行固定自升级流程：下载 manifest、下载包文件、校验 sha256、写入 staging、备份当前文件、替换白名单文件、重启并确认新版本。
- 升级失败必须尽量保留旧 collector 继续采集；失败摘要进入 Operation、Notification、collector 结构化日志和本地 upgrade state。

## 非目标

- 不开放远程 shell、任意命令执行、任意文件写入或后端触发的 runtime adapter 命令。
- 不把 collector 升级写成 Runs 会话任务或 Lorume `Task`；它是平台运维 Operation。
- 不用 WebSocket 做聊天、任务调度、外部平台协议模拟或通用控制通道。
- 不在第一版做批量灰度、自动全组织升级、跨组织版本策略、强制降级或 service definition 迁移。
- 不覆盖 `config.json`、device token、task sync cache、collector 日志或本地 runtime adapter 采集状态。
- 不要求当前已经安装的 `0.1.0` collector 自动理解升级协议；低于升级协议能力的设备必须先手动重装一次。

## 对象和状态

### Collector Version

服务端当前 collector 版本来自正在部署的设备包 manifest，而不是前端硬编码。Manifest 至少包含：

```ts
export interface CollectorPackageManifest {
  schemaVersion: "collector-package-v1";
  version: string;
  createdAt: string;
  minUpgradeProtocolVersion: number;
  files: Array<{
    fileName: string;
    path: string;
    mode: "0755" | "0644";
    sha256: string;
    bytes: number;
  }>;
}
```

`files[].fileName` 只能来自 collector 运行时文件白名单：

- `lorume-device-collector.mjs`
- `lorume-runtime-adapters.mjs`
- `local-ip-normalization.mjs`
- `lorume.mjs`
- 未来实现升级 helper 时新增的固定文件名，例如 `lorume-collector-upgrade-helper.mjs`

安装器包可以继续公开 `install-device-collector.sh`，但自升级 manifest 第一版不替换安装 shell，只替换 collector 安装目录内的运行时文件。

Manifest 不包含 device token、server session、平台 API key、本机路径或外部 runtime 原始证据。

### Device Collector Capability

Collector 在 `hello` 和 `heartbeat` 中继续上报 `collectorVersion`，并在具备自升级能力后额外上报：

```ts
export interface CollectorControlCapability {
  collectorVersion: string;
  upgrade?: {
    protocolVersion: number;
    supported: true;
    installPath?: string;
    lastUpgradeJobId?: string;
    lastUpgradeStatus?: "succeeded" | "failed" | "rolled_back";
  };
}
```

服务端只有在设备当前连接已认证、`upgrade.supported === true` 且 `upgrade.protocolVersion >= manifest.minUpgradeProtocolVersion` 时，才允许创建可自动执行的升级 Job。否则 Operation 必须进入 `requires_manual_step`，提示用户先手动重装支持升级协议的 collector。

### Operation / Job

Collector 升级使用现有 Operations 模块：

- `Operation.type = "collector_upgrade"`
- `Operation.resourceType = "device"`
- `Operation.resourceId = deviceId`
- `Operation.targetType = "collector"`
- `Operation.targetId = targetVersion`
- `Operation.metadata` 保存 `deviceId`、`currentVersion`、`targetVersion`、`requestedManifestVersion` 和最后进度摘要。
- `OperationJob.type = "collector_upgrade_device"`
- `OperationJob.payload` 保存非敏感升级上下文、nonce、stage、progress message 和 deadline。

Collector 升级 Job 是外部完成型 Job。Runner claim 后发送 WebSocket 升级请求，但不能立刻把 Job 标记为成功。Job 保持 `running`，由 collector 进度消息、重新连接版本确认或超时检查完成。

Job progress stage 使用固定枚举：

| Stage | 含义 |
|---|---|
| `queued` | Operation / Job 已创建，尚未发给设备。 |
| `dispatched` | 服务端已向设备 socket 发送升级请求。 |
| `acknowledged` | Collector 已接收并接受请求。 |
| `downloading` | Collector 正在下载 manifest 或包文件。 |
| `verifying` | Collector 正在校验 manifest、文件白名单、sha256 和版本约束。 |
| `installing` | Collector 正在 staging、备份和替换文件。 |
| `restart_pending` | Collector 已完成替换，准备退出并由 launchd/systemd 拉起。 |
| `reconnected` | 服务端已看到目标设备以目标 collector 版本重新连接。 |
| `succeeded` | 升级最终成功。 |
| `failed` | 升级失败，旧 collector 仍应尽量保持可用。 |
| `rolled_back` | Collector 已恢复备份版本并继续运行。 |

## 服务端协议

### API

新增或扩展以下后端 API：

- `GET /api/device-collector/manifest.json`
  - 公开、无密钥。
  - 返回当前部署的 collector package manifest。
  - 响应必须 `no-store` 或带明确版本，避免设备拿到旧 manifest。
- `POST /api/devices/:deviceId/collector-upgrade`
  - 需要当前用户是设备所属组织的 owner / admin。
  - 创建 `collector_upgrade` Operation 和 `collector_upgrade_device` Job。
  - 默认目标版本是当前 manifest version。
  - 设备不在线、不属于当前组织、不支持升级协议或当前版本已是最新时，返回 Operation 摘要，并让 Job 进入 `requires_manual_step`、`unsupported` 或 `succeeded`。
- `GET /api/operations` / `GET /api/operations/:operationId`
  - 继续作为升级进度和结果的用户可见查询入口。

第一版只支持单设备升级。批量升级以后可以通过创建一个 Operation 和多条 `collector_upgrade_device` Job 扩展，不改变设备侧协议。

### WebSocket Downlink

服务端只通过已认证的 `WS /api/device-control/ws` 向目标设备 socket 发送升级请求：

```json
{
  "type": "collector.upgrade.request",
  "protocolVersion": 1,
  "operationId": "op_xxx",
  "jobId": "job_xxx",
  "deviceId": "gezilinll-claw",
  "currentVersion": "0.1.0",
  "targetVersion": "0.1.2",
  "manifestUrl": "https://claw.gezilinll.com/api/device-collector/manifest.json",
  "packageBaseUrl": "https://claw.gezilinll.com/api/device-collector/files",
  "deadlineAt": "2026-06-02T12:00:00.000Z",
  "nonce": "upgrade_xxx"
}
```

字段规则：

- `type` 必须固定为 `collector.upgrade.request`。
- `protocolVersion` 当前为 `1`。
- `operationId` 和 `jobId` 必须属于当前组织内的升级 Operation / Job。
- `deviceId` 必须匹配该 WebSocket 已认证设备。
- `targetVersion` 必须等于当前服务端 manifest version，除非未来实现显式版本选择。
- `manifestUrl` 和 `packageBaseUrl` 必须指向同一个 Lorume backend origin。
- `nonce` 用于幂等和防止重复请求混淆，不是密钥。
- 消息不得包含 shell 命令、任意路径、device token、session token 或平台 API key。

服务端发送后将 Job progress 更新为 `dispatched`。如果 socket 不存在或发送失败，Job 失败重试；重试耗尽后进入 `requires_manual_step`，提示用户检查设备连接或手动重装。

### Collector Progress Messages

Collector 通过同一 WebSocket 上报升级进度：

```json
{
  "type": "collector.upgrade.progress",
  "protocolVersion": 1,
  "operationId": "op_xxx",
  "jobId": "job_xxx",
  "deviceId": "gezilinll-claw",
  "nonce": "upgrade_xxx",
  "stage": "downloading",
  "status": "running",
  "currentVersion": "0.1.0",
  "targetVersion": "0.1.2",
  "message": "Downloading collector package",
  "observedAt": "2026-06-02T11:58:00.000Z"
}
```

`status` 只能是 `running`、`succeeded`、`failed` 或 `requires_manual_step`。失败消息可以包含短错误摘要，但不得包含 token、请求头、本机完整环境变量、平台 API key 或原始下载响应。

服务端必须验证：

- progress 来自当前 Job 绑定的设备 socket。
- `operationId`、`jobId`、`deviceId`、`nonce` 匹配。
- stage 是固定枚举。
- final `succeeded` 不能单独作为成功依据；服务端还必须看到目标设备重新连接并上报 `collectorVersion === targetVersion`。

### Completion Rules

成功条件：

1. Job 已进入 `restart_pending` 或之后阶段。
2. 设备在 `deadlineAt` 前重新 `hello` 或 `heartbeat`。
3. 新连接上报 `collectorVersion === targetVersion`。
4. 连接消息来自同一个已认证 device id。

满足后，服务端将 Job 标记为 `succeeded`，Operation 汇总为 `succeeded`，并创建通知事件。

失败条件：

- 设备拒绝升级请求。
- Manifest 获取失败。
- 文件白名单或 sha256 校验失败。
- 目标版本小于或等于当前版本且不是显式重装。
- 安装阶段失败且无法恢复。
- `deadlineAt` 前未看到目标版本重新连接。
- 重启后仍上报旧版本。

失败后，Job 进入 `failed` 或 `requires_manual_step`。如果 collector 报告已恢复备份，stage 记录为 `rolled_back`，但 Job 仍按失败处理，提示用户检查目标设备。

## Collector 自升级流程

Collector 收到升级请求后按以下顺序执行：

1. 校验请求字段、协议版本、device id、nonce、target version、manifest URL 和 package base URL。
2. 如果当前版本已等于 target version，发送 `succeeded` progress；服务端仍以 heartbeat 版本确认最终状态。
3. 获取 upgrade lock。Upgrade lock 与采集 run lock 必须互斥，避免采集和升级同时写安装目录。
4. 写本地 `upgrade-state.json`，记录 `jobId`、`operationId`、`targetVersion`、`stage`、`startedAt` 和脱敏错误摘要。
5. 下载 manifest 到 staging 目录：`~/.lorume/collector/.upgrade/<jobId>/`。
6. 验证 manifest schema、版本、白名单文件、相对路径、sha256 和字节数。
7. 下载每个文件到 staging，并逐个校验 sha256。
8. 备份当前白名单文件到 `~/.lorume/collector/.previous/<jobId>/`。
9. 原子替换安装目录内的白名单文件，保留 `config.json`、日志目录、task sync cache 和本机状态。
10. 发送 `restart_pending` progress。
11. 退出主 collector 进程，让 launchd `KeepAlive` 或 systemd `Restart=always` 拉起新版本。
12. 新版本启动后读取 `upgrade-state.json`，如果目标版本匹配，立即发送 `succeeded` progress 并继续正常 heartbeat。

安装阶段出错时：

- Collector 优先恢复备份文件。
- 恢复成功时发送 `rolled_back` progress，并继续以旧版本运行。
- 恢复失败时发送 `failed` progress，保留本地错误摘要，不能删除 config 或 token。

第一版不处理 service definition 迁移。如果 manifest 声明需要 launchd/systemd service definition 改动，collector 必须拒绝自动升级并返回 `requires_manual_step`。

## Runtime Fleet 和 Operations UI

Runtime Fleet 是 collector 版本展示和发起单设备升级的主入口：

- 顶部 workbar 展示当前服务端 collector 最新版本和待升级设备数。
- Device 卡片展示 `Collector <version>` 以及 `最新`、`待升级`、`升级中`、`升级失败`、`需手动升级` 或 `未上报` 版本状态。
- Device 详情面板展示当前版本、最新版本和升级状态。
- 详情面板提供 `升级 Collector` 操作；失败、需手动升级或待升级时可以再次发起，由后端创建新的 Operation。
- Operations 抽屉展示对应 Operation / Job 详情，承担 `查看任务` 语义。
- Device 采集状态仍只使用 `同步中`、`在线`、`离线`、`异常`；collector 版本状态不能改写 collection status。

Operations 抽屉是升级进度和结果的任务观察入口：

- 列表显示 `collector_upgrade` Operation。
- 详情显示目标 Device、当前版本、目标版本、Job stage、最近 progress message、开始时间、完成时间和失败摘要。
- 运行中的 collector upgrade 可以更频繁轮询 Operation 详情，例如 `3-5s`；不要求第一版引入 SSE 或 WebSocket 推送到浏览器。

Organization Settings 只保留设备 token、安装命令和手动重装入口。它可以展示当前服务端 collector 版本，但不做逐设备升级管理。

## 安全和审计边界

- 升级请求只发给已认证设备 socket；未认证 WebSocket 不可进入控制通道。
- 设备 token 只用于设备认证，不写入 Operation metadata、Job payload、progress message、日志或通知。
- Manifest 和文件下载不需要 device token，但必须使用 HTTPS 或本地开发同源 HTTP。
- Collector 只写安装目录下白名单文件，拒绝 `..`、绝对路径、符号链接逃逸和非白名单文件。
- Progress message 只允许短摘要，不能包含原始环境变量、请求头、token 或平台 payload。
- Operation / Notification 只展示用户可理解的摘要，不展示后端 raw payload。
- 失败或超时时必须保留人工恢复路径：复制安装命令、SSH 进入目标设备重装、或使用已安装 CLI 停止/卸载。

## Harness

第一版实现必须覆盖：

- Manifest API harness：`GET /api/device-collector/manifest.json` 返回白名单文件、版本、sha256 和 no-store 语义；文件 hash 与本地源文件一致。
- Control channel harness：已认证设备 hello/heartbeat 仍可用；服务端能向指定设备发送 `collector.upgrade.request`；不支持的任意消息仍被拒绝。
- Operation runner harness：`collector_upgrade_device` Job dispatch 后保持 running；progress 更新 Job payload；目标版本 heartbeat 后完成；超时后失败或需要人工处理。
- Collector script harness：收到升级请求后下载 fixture manifest/files、校验 hash、staging、备份、替换、保留 config 和 task sync cache，并写脱敏 upgrade state。
- Rollback harness：校验失败或安装失败时恢复备份文件并上报 `rolled_back` / `failed`。
- Backend API-only E2E：本地 isolated backend/Postgres、真实 collector 进程、device token WebSocket、升级消息、重启后目标版本确认。
- Runtime Fleet component harness：展示最新版本、每台设备版本状态、单设备升级按钮，并确认升级请求会创建 Operation。
- Operations drawer harness：展示 collector upgrade Operation / Job stage、progress message 和失败摘要。
- Repo and DB harness：`npm run check:repo`、`npm run check:backend`、`npm run check:db`、`npm run check:runtime` 覆盖新增 source of truth、schema 和 collector 行为。
