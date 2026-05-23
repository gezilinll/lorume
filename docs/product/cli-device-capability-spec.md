# CLI Device Capability Spec

状态：当前规则

本规格定义 `lorume` CLI 的设备侧确定性能力边界。被采集设备上只有 Lorume device package 这一条安装入口，稳定本地调用面是 `lorume` CLI；collector / daemon 只能编排 CLI 命令、上传结果和维护连接健康，不能直接探测第三方 Runtime 的私有目录、内部 API、token 或进程语义，也不能承担后端命令执行器角色。CLI 不具备推理能力，也不负责分析、编辑、安装或迁移 Skill。

## 目标

- 提供一个本地 `lorume` CLI 入口，用于暴露设备侧确定性能力。
- 输出稳定 JSON，方便 collector、backend、frontend query model 和 harness 消费。
- 允许读取本机设备事实。
- 允许 live-first 采集 Device / Runtime / Agent / Task device-state 和 Agent Skill metadata。
- 允许从标准 `device_state` snapshot 列出已知 Runtime 和 Agent，用于测试和离线诊断。
- 允许在显式传入的本地或测试授权 context 中查询 connector / device 在线状态。
- 允许复制明确传入的本地文件或目录，并拒绝路径穿越和未授权目标路径。

## 非目标

- 不让 CLI 推理、规划或决定 Skill 安装策略。
- 不实现 Agent 迁移。
- 不实现 centralized Skill storage、Skill 编辑、发布、分配或同步。
- 不绕过 Lorume backend 的组织、设备 token、Operation 或 Notification 边界。
- 不开放任意命令执行。
- 不要求用户额外安装 Lorume 之外的“connector CLI”。OpenClaw、Multica、Slock 等平台命令或 API 只能作为 `lorume` CLI 内部 adapter 的可选依赖。
- 不把第三方平台私有路径、内部 token、raw payload 或 debug-only evidence 暴露给 collector、backend API 或 UI。

## 命令契约

所有支持 `--json` 的命令都必须输出 JSON object。错误也输出 JSON object 到 stderr，并使用非零退出码。

所有错误 JSON 必须包含稳定 `code` 和用户可读 `message`。新增错误码必须进入共享错误映射，不能把 `invalid_or_expired_code` 这类技术字符串直接展示给用户。

### `lorume device identify --json`

返回当前设备事实：

- `device.id`
- `device.hostname`
- `device.os`
- `device.architecture`
- `device.lastSeenAt`
- `device.network.localIps`（可选，来自本机非 internal 网络接口）
- `device.network.publicIp`（可选，只能来自后端观测或显式配置，CLI 不主动访问外部探测服务）
- `device.user.username`（可选）
- `collectedAt`

测试和安装脚本可以通过 `--device-id` 覆盖稳定设备身份。Device 不返回额外显示名、存储状态或连接模式字段。

### `lorume collect device-state --json [--snapshot <path>]`

返回 `DeviceStateSnapshot`：

- `collectedAt`
- `device`
- `runtimes`
- `agents`
- `tasks`
- `diagnostics`

当前默认 runtime adapter allowlist 只启用 OpenClaw adapter。被禁用的 adapter 不得执行命令、读取目录或生成对象。可通过本地配置或环境变量显式设置：

```sh
LORUME_ENABLED_RUNTIME_ADAPTERS=openclaw
```

`DeviceStateSnapshot` 是 CLI 本地采集 envelope；collector 上报后端时必须拆成 Device / Runtime / Agent metadata snapshot 和 Task batch。OpenClaw Task 采集必须输出所有符合产品标准的 Task，collector 再按大小和数量预算分批上传。Task 只允许通过 `agentId` 关联 Agent，必须带 `adapter.kind`，不直接携带 `runtimeId`，不返回 `title`、`description`、`toolCalls` 或 `lastSeenAt`。Runtime 不返回 `endpoint`、`capabilities` 或 `sourceRefs`；Agent 不返回 `origin`、`sourceRefs` 或 `load`。

### `lorume collector stop --json --install-dir <path>`

停止本机 Lorume collector 服务，但不删除安装文件或配置。该命令必须幂等：服务不存在或已经停止时仍返回成功状态，并在 JSON 中说明没有可停止的服务。

### `lorume collector uninstall --json --install-dir <path>`

停止本机 Lorume collector 服务、移除 launchd / systemd 服务定义，并删除指定安装目录、collector 日志目录和 task sync cache。该命令必须幂等：服务定义、安装目录或本地 collector state 不存在时仍返回成功状态。命令不得输出 device token、collector config 明文或平台 token。

### `lorume agent skill-probe --json --agent-id <id>`

返回一个 Agent 的只读 Skill metadata snapshot。该命令只列出 Skill root、entry path、Markdown 文件名和非 Markdown 文件名；不能返回 Skill 文件内容、token、安装建议、编辑建议或迁移计划。

### `lorume runtime list --json --snapshot <path>`

读取标准 `device_state` snapshot，返回：

- `device`
- `runtimes`
- `agents`
- `collectedAt`

该命令不解释平台原始字段，只消费已归一化 snapshot。Collector 正式采集只调用 `lorume collect device-state --json`；`runtime list` 仅用于离线诊断和 fixture 检查。

### `lorume connector status --json --context <path> --target <id>`

读取本地或测试提供的授权 context。CLI 只能查询 context 中显式出现的 target。缺失 target 返回 `not_found`，不能扫描网络、猜测设备状态，或把该命令当作后端触发采集入口。

### `lorume files copy --json --from <path> --to <path> --allow-root <path>`

复制明确指定的本地文件或目录。`from` 和 `to` 都必须落在至少一个 `--allow-root` 目录内。CLI 必须拒绝：

- `..` 路径穿越后落到 allow root 外的路径。
- 未传 `--allow-root` 的复制请求。
- 不存在的来源路径。

## Harness

- `src/cli/lorume-cli.test.ts` 覆盖命令 shape、JSON 输出、路径安全和 unsupported command。
- `src/cli/lorume-cli.test.ts` 覆盖 `collect device-state`、`agent skill-probe` 的 JSON 合同、可选字段和错误码映射。
- `src/runtime/device-collector-script.test.ts` 必须验证 collector 通过 `lorume` CLI 获取 `device_state`，而不是直接新增第三方私有探测逻辑。
- `npm run check:cli` 运行 CLI harness。
- `npm run check:runtime`、`npm run check:backend`、`npm run check:quick` 继续覆盖 collector、backend 和 TypeScript 边界。
