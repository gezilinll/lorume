# Runtime Fleet Page Spec

版本：TinySpec v1.1

Runtime Fleet 是 Lorume 查看设备、Runtime 和 Agent 采集状态的管理页面。页面只展示后端已有的四对象模型：`Device`、`Runtime`、`Agent` 和由 `Task` 派生出的计数/上下文。

## 分层原则

- Device 管机器事实、collector 元信息和采集状态。
- Runtime 管设备上的运行环境，例如 OpenClaw、Slock、Multica、Codex。
- Agent 管 Runtime 下的工作主体。
- Task 管 Agent 承接的任务。
- Runtime Fleet 不把任务忙闲写进 Runtime/Agent 状态。Runtime/Agent 状态只表示 collection status。
- 页面不展示 adapter capabilities、endpoint、sourceRefs、Agent origin 或 Agent load 这类 adapter/internal 字段。

## 目标

- 展示设备的 device id、hostname、OS、架构、最近同步、本地 / 出口 IP 和 collector 元信息。
- 展示设备上的 Runtime；Runtime kind 候选项来自后端真实返回的数据。
- 展示 Runtime 下的 Agent、归属 Runtime、采集状态、最近同步和派生 Task 数量。
- 支持按关键词、Runtime kind、同步时间过滤。
- Runtime kind 候选项必须来自当前后端数据中真实存在的 Runtime。
- 点击设备、Runtime 或 Agent 后，在右侧详情面板查看身份信息、归属关系、采集状态和必要 diagnostics。
- Agent 行级 Skill 探测仍是只读能力；它展示已存储 metadata，不请求设备执行远端探测。
- 页面自动轮询后端已有数据，不下发远端采集命令。

## 非目标

- 不创建、编辑或删除外部平台 Agent。
- 不接管聊天入口。
- 不展示所有网络接口、MAC 地址或内部进程端口。
- 不把 Task 直接塞进 Runtime 详情作为任务看板。
- 不提供 Runtime/Agent 的 working/idle 状态 badge。
- 不展示 `Conversation`、`Execution`、`Capability`、`SourceRef` 作为一等对象。
- 不展示后端没有返回、当前 adapter 未采集或缺少 harness 覆盖的 Runtime 结果。

## 数据源

- `GET /api/runtime-fleet`：正式 Runtime Fleet 查询 API，返回 Device、Runtime、Agent 和派生 Task 计数。
- `GET /api/runtime-tasks`：正式 Runs / Work Board 查询 API，返回 Task 查询页。
- `GET /api/devices/:deviceId/collection-health`：读取采集诊断摘要，用于解释 `collectionStatus`，不渲染成独立健康区块，只返回 `device_state` 检查项。
- `GET /api/agents/:agentId/skill-probe`：读取目标 Agent 最近一次已存储的只读 Skill metadata。

没有后端数据或本地 backend 不可用时，页面只在非 production 模式允许使用明确标识的 fixture 做离线预览。Production 构建必须展示明确错误和空状态，不回退 fixture。

## 状态展示

Runtime Fleet 对 Device、Runtime 和 Agent 只展示 `collectionStatus`：

| 状态 | 中文标签 | 页面含义 |
|---|---|---|
| `syncing` | 同步中 | 已注册/已连接，但还没有稳定采集结果。 |
| `online` | 在线 | 最近成功采集且仍新鲜。 |
| `offline` | 离线 | 曾经成功采集，但连接或采集结果过期。 |
| `error` | 异常 | 最近采集、校验或入库失败。 |

页面可以展示派生 Task 计数，例如 `进行中 2`、`失败 1`，但这些计数不能改写 Runtime/Agent 的 collection status。

Task 页面或 Runs / Work Board 对 Task 展示 `Task.status`：

| 状态 | 中文标签 |
|---|---|
| `todo` | 待处理 |
| `in_progress` | 进行中 |
| `review` | 待验收 |
| `done` | 已完成 |
| `blocked` | 阻塞 |
| `failed` | 失败 |
| `cancelled` | 已取消 |
| `unknown` | 未知 |

## 页面字段策略

### Device

- 列表/卡片展示 device id、hostname、collector version、collection status、最近同步、Runtime 数和 Agent 数。
- 详情展示基础信息、网络、collector、已注册 Runtime。
- 不展示由 Runtime/Agent/Task 推导出的工作状态。

### Runtime

- 列表展示 Runtime 名称、kind、所属设备、collection status、最近同步、Agent 数和 Task 计数。
- 详情展示基础信息、归属关系、diagnostics paths 和 lastError。
- 不展示 `endpoint`、`capabilities`、`sourceRefs`。

### Agent

- 列表展示 Agent 名称、归属 Runtime、collection status、最近同步和 Task 计数。
- Agent 来源通过 `agent.runtimeId -> runtime.kind` 派生，不显示 `origin` 字段。
- 详情展示基础信息、归属关系、diagnostics paths、Task 计数和 Skill metadata 状态。
- 不展示 `sourceRefs` 或 `load`。

### Task Context

Runtime Fleet 可以在 Agent 详情里展示 Task 摘要，但 Task 本体和泳道分组属于 Runs / Work Board。

Task 的 channel 和 conversation 是嵌套上下文字段，不是独立实体。页面可以展示如 DingTalk 群聊名、私聊名、会话标题和最近活动时间。

## 验收标准

- 主导航可以进入 Runtime Fleet 页面。
- 顶部统计显示设备、Runtime、Agent 数量；不显示独立异常统计卡。
- Runtime 筛选项来自当前后端数据；如果当前数据只有 OpenClaw，就只显示 `全部 / OpenClaw`。
- Device、Runtime、Agent 状态只显示 `同步中 / 在线 / 离线 / 异常`。
- Runtime/Agent 不显示 `工作中` 或 `空闲` 作为自身状态。
- Agent 任务数量由 `Task.agentId` 聚合。
- Runtime 任务数量通过 `Task.agentId -> Agent.runtimeId` 聚合。
- 页面不展示 Runtime `capabilities/endpoint/sourceRefs`。
- 页面不展示 Agent `origin/sourceRefs/load`。
- Production 查询失败时展示错误状态，不回退 fixture。
- 页面自动读取后端查询结果，并展示上次刷新时间。
- 页面不展示请求设备刷新按钮，不暴露远端命令轮询状态。
- 桌面和移动宽度下不横向溢出。
