# Runtime Slock Adapter Spec

版本：TinySpec v0.1

本文定义 Slock adapter 如何把 Slock 平台的只读证据转换为 Lorume 当前 `Device / Runtime / Agent / Task` 模型。Slock adapter 当前默认禁用；启用后必须按本文的只读数据源、归属证明、分页、映射和 diagnostics 规则采集。

## 模型边界

Slock 在当前真实设备证据中更像协作平台和 Agent 编排层，不自动等同于 Lorume 的执行 Runtime。Slock profile 中的 `runtime` 字段才表示该 Agent 在当前设备上的执行 Runtime。Slock adapter 必须使用 profile 的真实 runtime 值派生 Lorume Runtime，不能写死为 `codex` 或 `slock`。Lorume 侧只接收已经进入实现、spec 和 harness 的 runtime kind；当前可接收 `openclaw` 和 `codex`，其中 `codex` 只作为 Slock profile runtime 的归属类型。如果真实 Slock 数据出现新的 runtime 值，必须在同一变更中补该 runtime kind 的模型、fixture 和 harness 后才能入库。

因此 Slock adapter 的边界是：

- 可以从 Slock agent-scoped profile、server、channel history 和 task thread 中读取只读证据。
- 只能把当前设备真实承载的 active Slock Agent 转成 Lorume Agent。
- Runtime 由 Slock profile 的 `runtime` 派生；不要仅因为数据来自 Slock 就生成 `Runtime.kind="slock"`，也不要把 profile runtime 写死成某个单一值。
- Slock channel / thread 是 Task 的用户触点上下文，不是新的 Conversation、Channel、Execution 或 Run 一等实体。
- 远端可见 Agent、未分配 Task、只有本机 workspace 但没有 active profile 的 Agent 不进入产品 Task，只进入 diagnostics 聚合。

关系仍然固定为 `Device -> Runtime -> Agent -> Task`。`Task` 只保存 `agentId`；需要 Runtime 或 Device 时通过后端 join 或 BFF composition 查询。

## 数据源

| 用途 | Slock 来源 | 规则 |
|---|---|---|
| 本机 Agent 归属 | `GET /internal/agent/:agentId/profile` | 只有能返回 active profile，且 profile 的 `computerHostname` 匹配当前设备时，才算当前设备真实承载的 Agent。 |
| Runtime | profile 的 `runtime`、`model`、主机信息 | `runtime` 来自 Slock profile 原始值；该值必须是 Lorume 已支持的 Runtime kind，未知、缺失或尚未覆盖 harness 时跳过该 Agent 和其 Task，并输出 diagnostics。 |
| Agent 名称 | profile 的 `displayName` / `name` | 作为 Lorume Agent `name`。server catalog 的同名信息只能补充 diagnostics，不能替代 profile 归属证明。 |
| Task 候选 | `GET /internal/agent/:agentId/history?channel=<target>` 中带 `taskNumber` / `taskStatus` / `taskAssigneeId` 的 message | 每条 task message 是一个候选 Task；只有 `taskAssigneeId` 等于当前 active profile id 时才入库。 |
| Task thread | `GET /internal/agent/:agentId/history?channel=<channelTarget>:<taskMessageId 前 8 位>` | 用于提取 Agent 回复、执行上下文和最近活动时间。 |
| Server catalog | `GET /internal/agent/:agentId/server` 的 agents 列表 | 当前 payload 只有 `name`、`description`、`status`，缺少稳定 id；不能用它把 Task 归属到本机 Agent。 |
| 本机 workspace | `~/.slock/agents/*` | 只能作为辅助证据；没有 active profile 时不生成 Agent / Task。 |

Adapter 必须用只读请求和只读文件读取。真实 Slock CLI API 是 agent-scoped API，请求必须带 `Authorization: Bearer <token>`、`X-Agent-Id: <agentId>` 和 `X-Slock-Client: lorume-collector`；如配置了 server id，再带 `X-Server-Id`。不得写 Slock 数据，不得调用会创建、修改、领取、关闭或重跑任务的接口。

Slock 只读 API 可能出现短暂 5xx、网络超时、408 或 429。Adapter 必须对这类临时失败做有限重试，再决定是否输出 diagnostics。404 等明确业务结果不重试，因为它代表 profile 或资源不存在。

当前 adapter 配置输入为：

| 配置 | 用途 |
|---|---|
| `LORUME_SLOCK_BASE_URL` / `LORUME_SLOCK_SERVER_URL` 或 `slockBaseUrl` / `slockServerUrl` | Slock server URL。 |
| `LORUME_SLOCK_AUTH_TOKEN` / `LORUME_SLOCK_API_KEY` 或对应 config 字段 | 只读请求鉴权 token。缺失时不执行 Slock 采集。 |
| `LORUME_SLOCK_AGENT_IDS` 或 `slockAgentIds` | 优先使用的本机 Slock Agent id 列表。未配置时才从 `~/.slock/agents/*` 枚举候选。 |
| `LORUME_SLOCK_CHANNEL_TARGETS` 或 `slockChannelTargets` | 可选的显式 Slock channel / DM / thread target 列表。配置后只读取这些 target；未配置时 adapter 必须从 Slock server catalog 自动发现当前 active profile 已加入的 channel。 |
| `LORUME_SLOCK_REPLY_CACHE_PATH` 或 `slockReplyCachePath` | 可选的本地 Agent 回复 cache 路径；只用于减少重复读取 task thread。默认在 collector home 下。 |
| `LORUME_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN` 或 `slockMaxReplyThreadReadsPerRun` | 单次 collector run 最多深读多少条 task thread 来补 `agentReply`。默认 `10`，可设为 `0` 表示本轮只发现 Task、不补 reply。 |

## Channel 发现规则

Slock adapter 不能依赖人工维护 channel allowlist 才能发现真实工作任务。规则：

1. 如果显式配置了 `LORUME_SLOCK_CHANNEL_TARGETS` / `slockChannelTargets`，按配置读取，用于小范围验收或定向排障。
2. 如果没有显式配置，必须对每个本机 active profile 调用 `GET /internal/agent/:agentId/server`，只取 `joined=true` 的 channel。
3. 自动发现的 target 优先使用 `target` / `ref`，缺失时用 `#${name}`，再缺失时用 `#${id}`。
4. `joined=false` 的公开可见 channel 只说明该 agent 可以看到目录，不代表当前 agent 正在承载该 channel 的工作，不自动扫描。
5. 自动发现模式按唯一 channel 去重扫描；同一个 channel 只读取一次 history，再用 message 的 `taskAssigneeId` 归属到本机 active profile，避免被多个本机 Agent 重复读取。
6. 自动发现模式仍以 channel history 生成核心 Task；`agentReply` 通过本地 reply cache 和每轮 thread 读取预算做增量富化。新 Task 或 reply 相关指纹变化时，在预算内读取 task thread；未变化时复用 cache；超出预算时核心 Task 照常入库，本轮不补 `agentReply`。
7. server catalog 只能用于 channel target 发现和展示辅助，不能替代 profile 归属证明，也不能用 Agent 名称把 Task 归属到本机。

## 分页规则

Slock history API 的分页不能只看 `hasOlder`。真实 Slock CLI 证据中 history payload 可能使用 `hasMore` / `hasOlder` 或 `has_more` / `has_older`；部分 100 条消息页面会返回 older=false 但 more=true，继续用 `before=<当前页最小 seq>` 仍能读到更早数据。

实现规则：

1. 对 channel history 和 thread history 都按 `before` 游标向前翻页。
2. 如果响应里出现 `hasMore` / `has_more` / `hasOlder` / `has_older` 任一明确分页标志，必须信任这些标志；只有完全没有分页标志时，才用当前页数量达到请求 limit 作为继续翻页的兜底条件。
3. 下一页游标使用当前页最小 `seq`。
4. Adapter 不允许按固定数量或固定字节数静默截断符合产品标准的 Task；体积控制交给 collector Task batch、ACK cache 和 hash 重传。
5. 如果为防止无限循环设置内部安全页数，命中该安全上限时必须输出 `error` diagnostic，本轮 Slock Task 不应被当成完整采集结果。

Task thread target 使用 task message 的稳定 id 派生，而不是直接使用 message 上的 `threadId`。当前证据支持的格式为：

```text
<channelTarget>:<taskMessageId 前 8 位>
```

例如 channel target 为 `#example`、task message id 为 `12345678-...` 时，thread target 为 `#example:12345678`。

## 归属筛选

第一版正式采集只入库当前设备真实承载的 Slock Agent 任务。

| 分类 | 判定 | 处理 |
|---|---|---|
| `local_active_task` | `taskAssigneeId` 能匹配本机 active profile id，且 profile runtime 可映射为 Lorume Runtime | 生成 Lorume Task。 |
| `local_peer_task` | 当前读取 agent 能看见该 Task，但 `taskAssigneeId` 指向另一个本机 active profile | 当前 agent 不生成 Task，也不写 remote/workspace warning；由被指派的本机 Agent 负责生成。 |
| `local_workspace_task` | `taskAssigneeId` 只在 `~/.slock/agents/*` 中出现，没有 active profile | 不生成 Task；写 `slock_inactive_workspace_task_ignored`。 |
| `remote_or_unknown_task` | `taskAssigneeId` 在 channel/thread 中可见，但没有本机 active profile | 不生成 Task；写 `slock_remote_agent_task_ignored`。 |
| `unassigned_task` | 缺少 `taskAssigneeId` | 不生成 Task；写 `slock_unassigned_task_ignored`。 |

不能用 Agent 名称、server catalog 名称、thread 发言名称或 LLM 推断来补足本机归属。名称只能用于展示；归属必须使用稳定 id 和 active profile。

## Runtime 和 Agent 映射

| Lorume 字段 | Slock 来源 | 规则 |
|---|---|---|
| `Runtime.id` | `deviceId` + profile runtime | `${deviceId}:runtime:${profile.runtime}`。同一设备同一 runtime 只生成一个 Runtime。 |
| `Runtime.kind` | profile `runtime` | 使用 Slock profile 的真实 runtime 值，但该值必须先成为 Lorume 已支持 Runtime kind。 |
| `Runtime.name` | runtime kind | 使用该 runtime kind 的用户可读名称。不要写成 `Slock`，除非 profile runtime 本身就是 `slock` 且已有实现证据。 |
| `Agent.id` | runtime id + Slock profile id | `${runtimeId}:agent:slock:${profile.id}`，避免和同一 Runtime 下其他来源的 Agent 冲突。 |
| `Agent.runtimeId` | Runtime id | 指向 profile runtime 派生出的 Runtime。 |
| `Agent.name` | profile `displayName` / `name` | 优先 displayName，缺失时用 name。 |
| `Agent.collectionStatus` | profile 状态 + 本轮采集结果 | profile active 且本轮采集成功为 `online`；profile 存在但尚未形成可用 Task 时仍可为 `online`，不要用任务忙闲改写。 |

Slock `model`、`computerId`、`computerName`、`computerHostname`、server catalog `description` 等只能进入 diagnostics、日志或 DB raw，不进入产品 API 主模型字段。

## Task 映射

Slock adapter 使用 `adapter.kind="slock"`、`channel.kind="slock"` 和 `raw.slock`。Slock Task 不新增 `runtimeId`、`run`、`execution`、`toolCalls`、`title`、`description` 或 `lastSeenAt`。

| Lorume Task 字段 | Slock 来源 | 规则 |
|---|---|---|
| `id` | `Agent.id` + task message id | `${agentId}:task:${taskMessageId}`。缺少 task message id 时跳过。 |
| `agentId` | `taskAssigneeId` -> 本机 active profile -> Lorume Agent | 必须引用本轮生成的 Agent。 |
| `taskType` | Slock task message | 当前统一为 `conversation`。Slock 定时任务只有出现明确、稳定的 schedule 证据后才能映射为 `scheduled`。 |
| `status` | `taskStatus` | 由 adapter 映射为 Lorume `TaskStatus`，并保留 raw status。 |
| `userMessage` | task message `content` | 必须有非空用户可读内容才生成 Task。 |
| `agentReply` | thread history 中 assigned Agent 的回复 | 取 task message 之后 assigned Agent 的最新非空可读消息；缺失时可为空。 |
| `adapter.kind` | adapter 固定值 | `slock`。 |
| `channel.kind` | Slock channel | `slock`。 |
| `channel.externalId` | channel id 或 channel target | 优先稳定 channel id，缺失时用 channel target。 |
| `conversation.title` | channel name / channel target | 使用可读 channel name；缺失时用不含 token 的 channel target。 |
| `conversation.externalId` | channel id 或 channel target | 与 channel external id 保持一致。 |
| `conversation.lastActivityAt` | task message / thread 最新业务时间 | 优先 thread 最新 `updatedAt`，缺失时用 task message `updatedAt` / `createdAt`。 |
| `creator.name` | task message sender name | 缺失时可省略 name，但不能用 assignee 伪造 creator。 |
| `creator.externalId` | task message sender id | 有则保存。 |
| `assignee.name` | matched profile displayName / name | 必须来自本机 active profile。 |
| `assignee.externalId` | Slock profile id | 与 `taskAssigneeId` 一致。 |
| `raw.slock.status` | task message `taskStatus` | 原样保留。 |
| `raw.slock.taskNumber` | task message `taskNumber` | 仅作排障证据，不作为稳定 id。 |
| `raw.slock.messageId` | task message id | 原样保留。 |
| `raw.slock.channelTarget` | channel target | 原样保留，禁止作为用户可读标题直接展示。 |
| `raw.slock.threadTarget` | 派生 thread target | 原样保留。 |
| `raw.slock.taskClaimedAt` | `taskClaimedAt` | 有则保留。 |
| `raw.slock.taskCompletedAt` | `taskCompletedAt` | 有则保留。 |
| `createdAt` | task message `createdAt` | 源系统业务时间。 |
| `updatedAt` | task message / thread 最新 `updatedAt` | 源系统业务时间，不用 collector 采集时间覆盖。 |

## 状态映射

| Slock raw `taskStatus` | Lorume `TaskStatus` |
|---|---|
| `todo` | `todo` |
| `in_progress` | `in_progress` |
| `in_review` | `review` |
| `done` | `done` |
| `closed` | `cancelled` |
| 其他未知值 | `unknown` |

Adapter 负责生成归一化 `Task.status`，但不得覆盖原始 `taskStatus`。未知值可以生成 Task，但必须写 `slock_unknown_task_status` warning，便于后续补映射。

## Agent Reply 规则

`agentReply` 是可选字段。Slock adapter 不能为了补齐字段伪造内容。

规则：

- `agentReply` 是 cache-aware enrichment。Adapter 先从 channel history 发现核心 Task，再使用本地 reply cache 判断是否在同一 collector run 读取 task thread。新 Task 或 reply 相关字段变化时读取 thread history；未变化时复用缓存的 `agentReply`。
- Reply fingerprint 只覆盖稳定且能表示 thread/reply 变化的源字段：message id、`taskAssigneeId`、raw task status、`replyCount`、thread id、task message `updatedAt`、`taskClaimedAt`、`taskCompletedAt`。collector 采集时间不进入 fingerprint。
- `replyCount === 0` 且没有 cache 时不读取 thread；`replyCount` 缺失时首轮读取一次 thread，因为源数据无法证明没有回复。
- 每个 collector run 默认最多深读 `10` 条 Slock task thread。该限制只影响 `agentReply` 富化，不允许丢弃符合产品标准的 Task。
- 预算耗尽时输出 `slock_agent_reply_deferred` info diagnostic；这些 Task 本轮不写入 reply cache，也不写 `slock_missing_agent_reply` warning。后续 collector run 会继续用相同规则补未缓存的 Task。
- 只有实际成功读取过 task thread 后，才可以写入或刷新 reply cache。不能为预算延期的 Task 写入空 reply cache，避免后续误判为无需富化。
- `done` Task 缺少 assigned Agent 回复时，Task 可以入库，但写 `slock_missing_agent_reply` warning。
- `in_progress`、`review`、`todo` 缺少 `agentReply` 不写 warning。
- 如果 thread history 为空，但 task message 本身字段完整，Task 仍可入库。
- 如果 thread API 读取失败，Task 仍可入库；有旧 cache 时复用旧回复，没有可用回复时保持 `agentReply` 缺失，并写 `slock_agent_reply_fetch_failed` warning。

Reply cache 是 collector 本地状态，不是 Lorume 产品实体。它不能保存 Slock auth token、device token、请求头、原始 thread payload 或完整 profile payload。

## Diagnostics

Slock adapter 只输出结构化聚合 diagnostics，不输出逐条原始 warning 字符串。

| code | severity | 规则 |
|---|---|---|
| `slock_remote_agent_task_ignored` | `info` | Task 指向远端或未知设备 Agent，当前设备不入库。 |
| `slock_unassigned_task_ignored` | `info` | Task 没有 `taskAssigneeId`，无法关联 Lorume Agent。 |
| `slock_unsupported_runtime_ignored` | `info` | active profile 的 runtime 真实存在，但该值尚未进入 Lorume RuntimeKind 实现和 harness，本轮跳过该 Agent 和其 Task。 |
| `slock_inactive_workspace_task_ignored` | `warning` | Task 指向本机 workspace 中存在但没有 active profile 的 Agent，不能证明当前设备正在承载。 |
| `slock_channel_discovery_failed` | `error` | 未配置显式 channel targets 时，server catalog 读取失败，无法发现 joined channel。 |
| `slock_missing_user_message` | `warning` | 本机 active profile task 缺少可读 `userMessage`，跳过。 |
| `slock_agent_reply_deferred` | `info` | 单次 collector run 的 thread 读取预算耗尽；核心 Task 已入库，`agentReply` 等后续 run 补齐。 |
| `slock_agent_reply_fetch_failed` | `warning` | Task thread reply enrichment 失败；adapter 保留核心 Task。 |
| `slock_missing_agent_reply` | `warning` | `done` Task 入库但缺少 assigned Agent 回复。 |
| `slock_unknown_task_status` | `warning` | 出现未映射 raw status。 |
| `slock_history_pagination_incomplete` | `error` | 命中安全页数、API 错误或分页无法确认完整性。 |
| `slock_profile_unreadable` | `error` | active profile 读取失败，无法证明本机 Agent 归属。 |
| `slock_reply_cache_write_failed` | `warning` | 本地 reply cache 写入失败；adapter 仍返回 Task。 |

`info` 和 `warning` 不改变 Device / Runtime / Agent 的 `collectionStatus`。只有 Slock 采集链路失败、结构校验失败或入库失败才把对应采集状态置为 `error`。

## Harness

Slock adapter 必须保持以下最小 harness：

- CLI adapter unit/script test：使用脱敏 fixture 覆盖真实 agent-scoped Slock API 路径、鉴权头、active profile、joined channel 自动发现、remote visible task、workspace-only task、unassigned task、分页 `hasMore=true/hasOlder=false`、thread target 派生、status 映射、临时只读 API 失败重试、reply cache 复用、reply fingerprint 变化刷新、thread 失败不丢 Task、每轮 reply thread 读取预算和预算延期后续 run 继续补齐。
- Collector test：覆盖 Slock Task 仍通过 `/api/device-task-batches` 分批上报，不回到 metadata snapshot。
- Backend/API test：覆盖 `adapter.kind="slock"`、`channel.kind="slock"`、`raw.slock` 和 Task 查询；Task stale/tombstone 行为由共享 runtime task batch harness 覆盖。
- Runtime Fleet / Runs query test：覆盖 Slock Task 不把 `Slock` 当 Runtime 状态，不把远端可见 task 展示为当前设备任务。
- 真实设备观察者验证：只读运行 adapter，确认入库数量只包含 `local_active_task`，并把新增真实缺口转成 spec 或 harness 后再修复。

真实设备 profiling 原始文件、token、个人机器路径、频道消息正文和临时 checklist 不提交。只有规则、脱敏 fixture 和可执行 harness 可以进入仓库。
