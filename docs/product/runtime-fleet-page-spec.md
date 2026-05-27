# Runtime Fleet Page Spec

版本：TinySpec v1.4

Runtime Fleet 是 Lorume 查看设备、Runtime 和 Agent 采集状态的管理页面。页面只展示后端已有的四对象模型：`Device`、`Runtime`、`Agent` 和由 `Task` 派生出的计数/上下文。

## 分层原则

- Device 管机器事实、collector 元信息和采集状态。
- Runtime 管设备上的运行环境；当前已实现的 Runtime kind 只有 OpenClaw 和 Codex。
- Agent 管 Runtime 下的工作主体。
- Task 管 Agent 承接的任务。
- Runtime Fleet 不把任务忙闲写进 Runtime/Agent 状态。Runtime/Agent 状态只表示 collection status。
- 页面不展示 adapter capabilities、endpoint、sourceRefs、Agent origin 或 Agent load 这类 adapter/internal 字段。

## 目标

- 展示设备的 device id、hostname、OS、架构、Task 派生的最近活跃、本地 / 出口 IP 和 collector 元信息。
- 展示设备上的 Runtime；Runtime kind 候选项来自后端真实返回的数据。
- 展示 Runtime 下的 Agent、归属 Runtime、采集状态、Task 派生的最近活跃和派生 Task 数量。
- Runtime Fleet 当前不展示搜索、Runtime kind 和同步时间筛选条；页面顶部工作栏展示全局数量，页面主体展示全量 Device、Runtime 和 Agent。
- 点击设备、Runtime 或 Agent 后，在右侧详情面板查看身份信息、归属关系、采集状态和必要 diagnostics。
- 详情面板不直接展示完整 Lorume 内部对象 ID；需要排障时，通过 `复制 ID` 按钮复制当前 Device、Runtime 或 Agent 的完整 ID。
- Agent 行级 Skill 探测仍是只读能力；它展示已存储 metadata，不请求设备执行远端探测。
- 页面自动轮询后端已有数据，不下发远端采集命令。

## 非目标

- 不创建、编辑或删除外部平台 Agent。
- 不接管聊天入口。
- 不展示所有网络接口、MAC 地址或内部进程端口。
- 不把 Task 直接塞进 Runtime 详情作为任务看板。
- 不提供 Runtime/Agent 的 working/idle 状态 badge。
- 不提供搜索、Runtime kind、同步时间或 Channel 筛选条。
- 不展示 `Conversation`、`Execution`、`Capability`、`SourceRef` 作为一等对象。
- 不展示后端没有返回、当前 adapter 未采集或缺少 harness 覆盖的 Runtime 结果。

## 数据源

- `GET /api/runtime-fleet`：正式 Runtime Fleet 查询 API，返回 Device、Runtime、Agent 和派生 Task 计数摘要，不返回 Task 明细数组。
- `GET /api/runtime-tasks`：正式 Runs 会话任务查询 API，返回 Task 查询页、summary 和 channel facets。
- `GET /api/devices/:deviceId/collection-health`：读取采集诊断摘要，用于解释 `collectionStatus`，不渲染成独立健康区块，只返回 `device_state` 检查项。
- `GET /api/runtimes/:runtimeId/skill-probe`：读取目标 Runtime 最近一次已存储的只读 Skill metadata。Agent 视角后续从 Runtime snapshot 的 `agentIds` 过滤得到。
- `GET /api/agents/:agentId/skill-probe`：前端迁移前的兼容读取接口，只读取已存储 metadata，不触发 Agent 级探测。

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
Device 在线态以最近成功收到的 `device_state` 为主证据；heartbeat 仅解释控制连接健康。Agent 如果在其所属 Runtime 的最新 metadata snapshot 中缺失，应显示为 `不可见` 并保留最近同步时间作为内部采集新鲜度证据，避免旧 Agent 长期停留在在线状态。Agent 本轮仍在但没有任务时仍显示 `在线`。

## 最近活跃

Runtime Fleet 用户可见的 `最近活跃` 表示 Task 处理活动时间，不表示 collector 最近同步、设备 heartbeat、页面刷新、Skill 探测、Operation 或 Notification 更新时间。

聚合规则：

- Agent：该 Agent 下 active non-stale Task 的最大活动时间。
- Runtime：该 Runtime 下所有 Agent 的 active non-stale Task 最大活动时间。
- Device：该 Device 下所有 Runtime 和 Agent 的 active non-stale Task 最大活动时间。
- Task 活动时间使用 `Task.updatedAt`，缺失时回退 `Task.createdAt`；Postgres 查询使用 `updated_source_at -> created_source_at -> updated_at -> created_at` 兜底，避免旧数据缺字段时无法排序。
- 缺少 Task 活动时展示 `暂无活跃`，不能回退到最近同步。

展示规则：

| 条件 | 展示 |
|---|---|
| 缺失 | `暂无活跃` |
| 无效时间 | `未知` |
| 0-59 秒 | `刚刚` |
| 1-59 分钟 | `N 分钟前` |
| 1-23 小时 | `N 小时前` |
| 本地时间昨天 | `昨天 HH:mm` |
| 2-6 天 | `N 天前` |
| 当前年 7 天以上 | `MM月DD日` |
| 往年或超过 60 秒的未来时间 | `YYYY年MM月DD日` |

Runs 会话任务页消费 `Task.status`，但 UI 只展示 `statusScope=board-visible` 下收敛后的五个可见泳道：

| 泳道 | 包含状态 |
|---|---|
| `待处理` | `todo` |
| `进行中` | `in_progress` |
| `待验收` | `review` |
| `已完成` | `done` |
| `需关注` | `failed`, `unknown` |

`cancelled` 仍是合法 Task 状态，但不在 Runs 前端展示为泳道，也不计入 board-visible 总数和 channel facets。`blocked` 暂不作为 Runs 页面独立泳道展示；进入页面泳道前必须先有后端上报、产品命名和 harness 覆盖。

## 页面字段策略

详情面板默认展示用户可读的名称、归属、采集状态和诊断字段，不把完整 Lorume 内部对象 ID 渲染成正文。Device、Runtime 和 Agent 详情都必须提供 `复制 ID` 操作；点击后复制当前对象的完整内部 ID，并通过 toast 给出轻量成功反馈。

### Device

- 列表/卡片使用 `users.html` 的团队动态节奏展示 device id、hostname、collection status、最近活跃、Runtime 数和 Agent 数。
- 详情展示基础信息、网络、collector、已注册 Runtime。
- 网络详情展示去噪后的本机局域网 IP 和公网 IP。`localIps` 只展示 collector 认为对用户有解释价值的地址，不展示 link-local IPv6、虚拟网桥、Docker/VM/VPN 噪音地址。
- 不展示由 Runtime/Agent/Task 推导出的工作状态。

### Runtime

- 列表使用 `users.html` 的成员目录节奏展示 Runtime 名称、版本、所属设备、collection status、最近活跃和 Task 计数。Runtime kind 不作为独立表格列或重复 badge 展示；需要识别 kind 时优先在详情或后端诊断语境中呈现。
- 详情展示基础信息、归属关系、diagnostics paths 和 lastError。
- 本地路径只展示 Runtime 根目录；adapter 内部文件、状态库、sessions 子目录等不作为默认详情字段展示。
- 不展示 `endpoint`、`capabilities`、`sourceRefs`。

### Agent

- 列表使用 `users.html` 的成员目录节奏展示 Agent 名称、归属 Runtime、collection status、最近活跃、Task 计数和只读 Skill 入口。
- Agent 来源通过 `agent.runtimeId -> runtime.kind` 派生，不显示 `origin` 字段。
- 详情展示基础信息、归属关系、diagnostics paths、Task 计数和 Skill metadata 状态。
- 本地路径只在 adapter 能证明存在本机目录时展示；没有本机目录时显示 `不适用`，不能留空造成漏采集错觉。
- 不展示 `sourceRefs` 或 `load`。

### Task Context

Runtime Fleet 可以在 Agent 详情里展示 Task 摘要，但 Task 本体和泳道分组属于 Runs 会话任务页。

Task 的 channel 和 conversation 是嵌套上下文字段，不是独立实体。页面可以展示如 DingTalk 群聊名、私聊名、会话标题和最近活动时间。

## API 契约

`GET /api/runtime-fleet` 必须返回轻量聚合视图：

- `devices`: Device 数组。
- `runtimes`: Runtime 数组。
- `agents`: Agent 数组。
- `taskSummary`: 由 active non-stale Task 派生的计数摘要。
- `summary`: 顶部统计。

`taskSummary` 必须至少包含：

- `byAgentId`: 按 `Task.agentId` 聚合的状态计数。
- `byRuntimeId`: 通过 `Task.agentId -> Agent.runtimeId` 聚合的状态计数。
- `byDeviceId`: 通过 `Task.agentId -> Agent.runtimeId -> Runtime.deviceId` 聚合的状态计数。
- `lastActiveAtByAgentId`: 按 `Task.agentId` 聚合的最近活跃 ISO 时间。
- `lastActiveAtByRuntimeId`: 通过 `Task.agentId -> Agent.runtimeId` 聚合的最近活跃 ISO 时间。
- `lastActiveAtByDeviceId`: 通过 `Task.agentId -> Agent.runtimeId -> Runtime.deviceId` 聚合的最近活跃 ISO 时间。

每个计数对象包含全部 `Task.status` 计数和 `total`。缺少某个对象 id 时，前端按全 0 处理；缺少最近活跃时展示 `暂无活跃`。Runtime Fleet 不为搜索或详情请求 Task 明细。

## 验收标准

- 主导航可以进入 Runtime Fleet 页面。
- 顶部工作栏显示设备、Runtime、Agent 数量；页面主体不再重复展示独立指标卡，也不显示独立异常统计卡。
- 刷新能力只在顶部工作栏右侧最后一个图标提供；页面主体不再渲染页面级刷新按钮。
- 页面不展示搜索、Runtime kind、同步时间、Channel 或可用性筛选条。
- Device、Runtime 状态只显示 `同步中 / 在线 / 离线 / 异常`；Agent 额外允许 `不可见`，表示此前采集到过但最新全量清单中未再出现。`不可见` badge hover/focus 时展示解释：`该 Agent 曾被采集到，但最新全量采集中未再出现。可能已被删除、停用，或已移出当前采集范围。`
- `不可见` Agent 的行级 Skill 探测入口禁用，避免对最新清单中已缺失的 Agent 发起只读探测。
- Runtime/Agent 不显示 `工作中` 或 `空闲` 作为自身状态。
- Agent 任务数量由 `Task.agentId` 聚合。
- Runtime 任务数量通过 `Task.agentId -> Agent.runtimeId` 聚合。
- Device 任务数量通过 `Task.agentId -> Agent.runtimeId -> Runtime.deviceId` 聚合。
- Runtime 表格不展示单独的 `Runtime` kind 列；名称列承载用户可读名称和版本，避免同一对象的类型信息重复占用目录宽度。
- Runtime Fleet 的 `最近活跃` 只来自 Task 活动聚合，不能来自最近同步或页面刷新时间。
- 设备即使暂时没有 Runtime，也必须在 Device 列表里可见。
- 页面不展示 Runtime `capabilities/endpoint/sourceRefs`。
- 页面不展示 Agent `origin/sourceRefs/load`。
- 详情面板不展示 `Lorume ID: ...` 长文本，Device、Runtime 和 Agent 均可通过 `复制 ID` 按钮复制内部 ID；复制成功反馈不占用详情面板布局。
- Production 查询失败时展示错误状态，不回退 fixture。
- 页面自动读取后端查询结果，并在顶部工作栏展示更新时间。
- 页面不展示请求设备刷新按钮，不暴露远端命令轮询状态。
- 桌面和移动宽度下不横向溢出。
