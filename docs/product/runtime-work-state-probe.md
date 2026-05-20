# Agent Work State Probe

版本：TinySpec 2026-05-11

本文记录 Lorume 对 OpenClaw、Multica、Slock 在工作项、会话和执行态上的当前采集规则。它用于指导 Runs / Work Board、Agent 工作管理和调度能力，不代表已经开始接管聊天入口或任务调度。

工作态归属于 Agent，而不是 Device 或 Runtime。Runtime adapter 可以是采集入口，但采集到的 WorkItem、Conversation、Execution 必须在 adapter / query 层关联回 Agent；Device 只负责连接与承载，Runtime 只负责执行环境可用性和粗粒度忙闲。

## 目标数据

Lorume 需要把外部平台数据先转成自己的工作态模型，再交给页面、Catalog 或后续调度能力消费。当前 TypeScript source of truth 是 `src/runtime/runtime-work-state.ts`。

目标对象：

- `RuntimeWorkItem`：业务工作项，例如 Slock board card、Multica issue、外部任务或需求卡片。
- `RuntimeConversation`：会话或线程，例如 channel thread、DM、OpenClaw session、Multica chat session。
- `RuntimeExecution`：一次具体运行，例如 OpenClaw run、Multica task/run、Slock agent activity。
- `RuntimeObservationCapability`：平台能力声明，用于说明某个平台通过什么策略满足哪些字段，以及还有什么限制。

前端看板必须服务“用户能找到自己发给 Agent 的那条任务”这个目标。能够进入 Runs / Work Board 任务卡的对象必须有业务上下文，至少来自 `RuntimeWorkItem` 或等价上游任务对象。裸 `RuntimeExecution`、平台在线状态、监听缺口、capability evidence 只能作为后台诊断或能力说明，不能单独生成用户可见任务卡。

目标状态：

- WorkItem：`todo`、`in_progress`、`in_review`、`done`、`blocked`、`cancelled`、`unknown`。
- Conversation：`open`、`active`、`idle`、`closed`、`unknown`。
- Execution：`queued`、`running`、`succeeded`、`failed`、`cancelled`、`unknown`。
- WorkStage：`pending`、`processing`、`review`、`closed`、`attention`。

## 统一阶段规则

WorkStage 是 Lorume 用于统一任务队列或看板的阶段，不等于任一平台的原始状态。当前 source of truth 是 `deriveRuntimeWorkStage`，harness 在 `src/runtime/runtime-work-state.test.ts` 中覆盖。

| WorkStage | 中文含义 | 进入规则 | 说明 |
|---|---|---|---|
| `pending` | 待处理 | 有业务 WorkItem，状态是待办或 backlog 映射到待办 | 表示任务已进入系统，但尚未进入 Agent 处理 |
| `processing` | 处理中 | WorkItem 处于处理中，或 Execution 是 `queued/running` | Slock 的 `in_progress` 是 Runs 的直接阶段证据，但不生成 `RuntimeExecution.running` |
| `review` | 待验收 | WorkItem 处于 review / in_review | 表示等待人审、结果确认或下游验收 |
| `closed` | 已关闭 | WorkItem 已 done/cancelled，或无 review 概念的平台 execution succeeded | 表示无需继续推进，包含完成或取消 |
| `attention` | 需关注 | blocked、failed、lost、timed out、cancelled execution、unknown 或平台不支持的阶段 | 表示失败、阻塞、状态不可信或需要补观测 |

阶段和执行态的基本约束：

- WorkStage 优先表达“项目管理阶段”，Execution.status 表达“真实运行状态”。
- 看板 `in_progress` 不能直接证明 execution `running`，但可以作为 Agent 正在承接工作和 Runtime 粗粒度 `working` 的业务证据。
- 如果平台没有 review 概念，不允许为了统一 UI 伪造 review 阶段。
- 如果平台没有业务 WorkItem，不允许为了填满看板伪造 pending 阶段。
- Adapter 必须给出 `confidence`：`direct`、`partial` 或 `unsupported`。

## 平台阶段映射

| 平台 | pending | processing | review | closed | attention |
|---|---|---|---|---|---|
| OpenClaw | 已关联 task / trajectory / requester session 的 DingTalk message-backed WorkItem 可进入 pending | execution `queued/running`，或消息/trajectory 关联执行中 | 不支持 | execution `succeeded`，或消息/trajectory 关联执行成功 | execution `failed/cancelled/unknown/lost/timed_out`，或执行成功但缺少可靠投递证据 |
| Multica | issue `todo/backlog` | issue `in_progress` 或 execution `queued/running` | issue `in_review`，若平台暴露 | issue `done/cancelled` 或 execution `succeeded` | issue `blocked/unknown` 或 execution `failed/cancelled` |
| Slock | task `todo` | task `in_progress` | task `in_review` | task `done/cancelled` | task `blocked/unknown` 或 execution `failed/cancelled` |

OpenClaw 特别规则：

- OpenClaw 是 runtime / execution 强来源；当本地 DingTalk message context、target directory、task origin 或 trajectory `prompt.submitted` 能和真实 task / execution 关联时，也可以生成 message-backed WorkItem。
- OpenClaw 没有 review 概念，execution 成功后直接进入 `closed`。
- OpenClaw 的待处理必须来自 DingTalk、Slock、Multica 或其他上游 WorkItem，不能由裸 execution 推断。
- OpenClaw `lost`、`timed_out` 归一到 execution failed 后进入 `attention`。

Slock 特别规则：

- Slock task board 可以可靠提供 WorkItem 阶段。
- Slock server info 中的 agent `active` 只能表示在线或可用，不能作为 execution running 证据。
- 在没有 activity/event/proxy 证据前，Slock task `in_progress` 的 WorkStage 仍是 `processing` 且 `confidence=direct`，因为 Runs 以 task board 为准。
- Slock task `in_progress` 可用于 Runtime 粗粒度运行状态 `working`；实时 activity 只作为更精细忙闲或 execution 证据。
- Slock task board 的 assignee 可以用于推导 ManagedAgent 展示状态；如果 task API 中的 agent id 只是 workspace / token 归属，不能把它当作任务承接 Agent。

Multica 特别规则：

- Multica issue 是 WorkItem 强来源。
- Multica task/run 是 Execution 强来源。
- 如果 issue status 和 execution status 冲突，失败类 execution 优先进入 `attention`，运行中 execution 优先进入 `processing`，其余再使用 issue 阶段。

## 探测摘要

| 平台 | WorkItem | Conversation | Execution | 建议策略 |
|---|---|---|---|---|
| OpenClaw | 部分支持，通过 DingTalk 本地消息状态、requester session、task origin 或 trajectory prompt 关联 | 可通过 session/channel health、trajectory sessionKey 和 DingTalk target directory 做部分会话态 | 支持，通过 `tasks list`、trajectory `trace.artifacts`、`status`、`health` | `local_state` + `cli` + `native_api` |
| Multica | 支持，通过 `issue list/get/status` | 部分支持，通过 `chat_session_id`、issue runs/messages | 支持，通过 `agent tasks`、`issue runs`、daemon `active_task_count` | `cli` + `native_api` |
| Slock | 支持，通过本地 agent token 调 internal task API，channel 可从 `/server` 自动发现 | 支持 channel/thread history，DM 依赖 agent context | 暂不完整；server `active` 不是执行中 | `native_api` + `local_state`，执行态再评估 observer/proxy/launcher |

## OpenClaw

只读探测命令：

- `openclaw status --json --timeout 5000`
- `openclaw health --json --timeout 5000`
- `openclaw tasks list --json`
- `~/.openclaw/agents/<agentId>/sessions/*.trajectory.jsonl` 只读扫描

已确认字段：

- Runtime：`runtimeVersion`、gateway reachability、gateway URL、agent list、channel health。
- Conversation：agent session count、recent session keys、recent session updated time。
- Execution：`taskId`、`runId`、`status`、`runtime`、`agentId`、`ownerKey`、`requesterSessionKey`、`createdAt`、`startedAt`、`endedAt`、`lastEventAt`、`deliveryStatus`。
- Channel：DingTalk `running`、`connected`、`lastConnectedAt`、`lastInboundAt`、`lastEventAt`、`lastError`。
- DingTalk local state：`messages.context*.json` 暴露 `msgId`、`direction`、`conversationId`、`text`、`senderId`、`senderName`、`createdAt`、`updatedAt`；真实文件中的 `records` 可能是数组，也可能是以 msgId 为 key 的对象 map，adapter 必须统一转成记录数组后再映射；`targets.directory*.json` 暴露群/人可读名称。
- Task / delivery state：`requesterSessionKey` 暴露 `agent:<id>:dingtalk:<group|direct>:<conversationId>` 形式的上游入口；`requesterOriginJson` / `task_delivery_state.requester_origin_json` 暴露 `channel`、`to`、`accountId` 等上游入口；`task` / `label` 暴露请求摘要。
- Trajectory：`session.started` 暴露 `sessionKey`、`runId`、`sessionFile`；`prompt.submitted` 暴露本次用户请求摘要；`trace.artifacts` 暴露 `finalStatus`、`assistantTexts`、`didSendViaMessagingTool`、超时/中断字段；`session.ended` 暴露结束状态。

探测样本摘要：

- `tasks list` 可返回上千个历史和当前 task。
- 状态包括 `succeeded`、`lost`、`timed_out`、`failed`、`cancelled`。
- `tasks list` 与 trajectory 扫描都会包含历史和当前记录；trajectory 文件必须按 `runId` 分组，因为同一个 trajectory 文件可能包含多次 run。collector 必须按当前用户任务卡规则分组，并过滤 heartbeat、async approval followup、system recovery 等内部任务。这批数据包含历史执行账本，不等于“当前活跃任务”。
- `health` 返回 main agent 的 session count 和 recent session keys。
- DingTalk channel 当前可观测连接态和最近事件时间。
- 本地 DingTalk message context 能定位群组、发起人和消息摘要；task 的 requester origin / message id 可把 execution 关联回消息。
- 本地 DingTalk message context 可能只提供不可读 `cid...` 兜底；如果 trajectory/session runtime-context 通过同一 `message_id` 证明这是 `direct` 私聊，adapter / collector 必须把原 message-backed WorkItem 的 channel 和 conversation 修正为私聊。
- 老 trajectory 缺少 `message_id` 时，若是 `direct` session，且 sender、文本和时间窗口能匹配 DingTalk message context，也必须回连原 message-backed WorkItem，避免同一条私聊请求同时生成一张群聊兜底卡和一张 trajectory 卡。
- OpenClaw 的 channel 不能在产品层硬编码为 DingTalk。当前已验证 DingTalk 的本地 state 与 session key；Telegram、Slack 等 OpenClaw channel 也要在 OpenClaw adapter 内转成 Lorume 的 `Channel` 与 `会话/群组`，前端只消费归一化字段。
- 部分 trajectory 没有对应 session JSONL 文件，但 `prompt.submitted.data.prompt` 仍能提供本次用户请求摘要；adapter 必须优先按 runId 分组读取 trajectory，而不是把 trajectory 文件或 Session 当成一张卡。
- 真实远端曾出现 `messages.context*.json` 存在但 `records=[]`，且 `openclaw tasks list --json` 不返回 `requesterOriginJson` 的情况；此时仍可用 `requesterSessionKey` + target directory 补出群组和请求摘要，但 creator 只能标记为“不支持采集”。
- `requesterSessionKey` 中的 DingTalk cid 可能被小写化，而 target directory 保留大小写；adapter 必须按大小写不敏感方式匹配群组。
- Gateway restart recovery、heartbeat、async approval followup 等 OpenClaw 内部/system 任务不能进入 Runs 卡片。

映射建议：

- `RuntimeExecution.status`：task `succeeded` 或 trajectory `finalStatus/session.ended.status=success` -> `succeeded`；`failed`、`timed_out`、`lost`、trajectory `error/aborted/timedOut` -> `failed`；`cancelled` -> `cancelled`；运行中状态出现时映射为 `running`；排队态出现时映射为 `queued`。
- `RuntimeWorkStage`：已关联 task / trajectory / requester session 的 DingTalk message-backed WorkItem 的 `todo` -> `pending`；`queued/running` -> `processing`；`succeeded` 且有 message tool 或 assistant text 投递证据 -> `closed`；`failed/cancelled/unknown/lost/timed_out` 或成功但缺少回复/投递证据 -> `attention`。OpenClaw 裸 execution 和未关联入站消息不产生 `pending` 或 `review`。
- `RuntimeConversation`：用 OpenClaw session key 生成会话对象，DingTalk target directory 补可读群名/人名，`updatedAt` 映射为 `lastActivityAt` / `lastSeenAt`。
- `RuntimeWorkItem`：只从已关联 task / trajectory 的 DingTalk inbound message、DingTalk requester session、task origin、trajectory `prompt.submitted` 或其他明确上游任务对象生成；未关联入站消息只作为 Conversation 证据。标题来自消息首句、task 摘要或 trajectory prompt，描述保留请求摘要，channel 必须来自 local state、session key 或 origin。creator 缺失时只能标记为“不支持采集”，不能猜。
- `conversationLabel`：前端不能展示 DingTalk `cid...`、手机号或 open conversation id。群聊缺名称时展示 `DingTalk 群聊`；私聊缺人名时展示 `DingTalk 私聊`。

结论：

- OpenClaw 能满足执行态和会话态的当前需求。
- 当 DingTalk local state、requester session、task origin 或 trajectory prompt 能关联时，OpenClaw 也能满足“当前工作视图”的卡片需求；没有消息关联或 prompt 的裸 execution 仍不能进入 Runs 卡片。

## Multica

只读探测命令：

- `multica daemon status --output json`
- `multica runtime list --output json`
- `multica agent list --output json`
- `multica agent tasks <agent-id> --output json`
- `multica issue list --output json`
- `multica issue runs <issue-id> --output json`

已确认字段：

- Runtime：`id`、`provider`、`name`、`status`、`runtime_mode`、`daemon_id`、`last_seen_at`、`metadata`、`launch_header`。
- Agent：`id`、`name`、`runtime_id`、`status`、`max_concurrent_tasks`、`model`、`visibility`、`updated_at`。
- WorkItem：issue `id`、`identifier`、`number`、`title`、`description`、`status`、`assignee_id`、`assignee_type`、`creator_id`、`creator_type`、`priority`、`labels`、`created_at`、`updated_at`。
- Execution：task/run `id`、`issue_id`、`agent_id`、`runtime_id`、`chat_session_id`、`kind`、`status`、`attempt`、`max_attempts`、`priority`、`created_at`、`dispatched_at`、`started_at`、`completed_at`、`error`、`work_dir`。

探测样本摘要：

- daemon 当前 `status=running`，`active_task_count=0`。
- runtime list 返回 3 个 runtime。
- agent list 返回 8 个 agent，其中 7 个 `idle`，1 个 `offline`。
- issue list 返回 50 个 issue，状态包括 `todo`、`backlog`、`cancelled`、`done`、`blocked`。
- issue runs 和 agent tasks 都能返回执行历史与运行时间字段。
- 主动探测曾确认任务会从 `queued` 进入 `running`，daemon `active_task_count` 会从 0 变 1，完成后回到 0。

映射建议：

- `RuntimeWorkItem.status`：`todo` -> `todo`；`backlog` 可先映射为 `todo`；`blocked` -> `blocked`；`done` -> `done`；`cancelled` -> `cancelled`。若 Multica 后续暴露 review 状态，再映射 `in_review`。
- `RuntimeWorkStage`：issue `todo/backlog` -> `pending`；issue `in_review` -> `review`；issue `done/cancelled` -> `closed`；issue `blocked/unknown` -> `attention`；execution `queued/running` 优先 -> `processing`；execution `failed/cancelled` 优先 -> `attention`。
- `RuntimeConversation`：优先用 `chat_session_id`；issue 维度的对话可通过 `issue run-messages` 补。
- `RuntimeExecution.status`：Multica task status 可直接映射到 `queued`、`running`、`succeeded` / `failed` / `cancelled`。当前 `completed` 映射为 `succeeded`。

结论：

- Multica 能满足 WorkItem、Conversation、Execution 三层的大部分当前需求。
- 需要在 adapter 内处理 `backlog/completed` 等平台状态到 Lorume 状态的映射。

## Slock

只读探测方式：

- `slock server info`
- `slock task list --channel <channel>`
- `GET /internal/agent/:agentId/server`
- `GET /internal/agent/:agentId/tasks?channel=<channel>`
- `GET /internal/agent/:agentId/history?channel=<target>&limit=<n>`
- Slock daemon 源码中确认内部存在 `agent:activity`，但当前 CLI 没有直接暴露可查询 activity state。

已确认字段：

- Server info：channel list、joined state、agent list、agent `active/inactive`。真实 API 中 task board channel 参数使用 `#${channel.name}`。
- Slock `channel` 是 Slock 任务/会话的路由上下文，例如 workspace channel、team channel、群组或 task-board 标识；它不是 OpenClaw 的 DingTalk / Telegram / Slack 用户触达 Channel，也不能跨 Runtime 混用语义。
- Task board：`id`、`taskNumber`、`status`、`taskStatus`、`title`、`content`、`channelName`、`channelType`、`messageId`、`threadId`、`createdByName`、`claimedByName`、`createdAt`、`updatedAt`、`completedAt`。
- History：message `id`、`seq`、`channelId`、`senderType`、`senderId`、`messageType`、`content`、`threadId`、`taskStatus`、`taskNumber`、`createdAt`、`updatedAt`、`replyCount`。

探测样本摘要：

- Slock task board 按 server / channel 返回任务列表和平台阶段；collector 必须把这些阶段转成 Lorume WorkStage，不把 Slock 自身 UI 状态直接暴露给 Runs 页面。
- task API 的完整列表需要不带 `status=all`；状态过滤使用 `status=in_progress`、`status=in_review`、`status=done` 等。
- `/server` 可返回 joined channel 列表，collector 应排除 archived/deleted/unjoined channel，再用 `#频道名` 拉 task board，避免要求用户手工维护 channel 配置。
- channel/thread history 能返回消息结构；DM history 是否可读依赖当前 agent context。
- `server info` 中的 agent `active` 表示 Slock 侧可用或在线，不等于 Lorume 的 `RuntimeExecution.status=running`。
- 2026-05-11 在 `gezilinll-claw` 上复核：7 个本地 Slock agent token 能正常读取 `/server` 与 `#all`、`#zy-GD`、`#AjisGTD`、`#AjisFarm` task board；1 个本地 token 返回 `401 Invalid machine API key`，应视为 stale/invalid agent context，不能影响其他 agent/channel 的采集结论。部分 channel warning 来自 internal API 瞬时失败或过期 token 场景，collector 需要重试后再记录 warning；同一个 channel 被多个本地 agent context 探测时，只要任一 context 成功采到该 channel，就不保留该 channel 的失败 warning。

映射建议：

- `RuntimeWorkItem`：Slock task board 是首选来源。`status` 可直接映射 `in_progress`、`in_review`、`done`；若出现未覆盖状态，映射为 `unknown` 并记录 adapter warning。
- `RuntimeWorkStage`：task `todo` -> `pending`；task `in_progress` -> `processing` 且 `confidence=direct`；task `in_review` -> `review`；task `done/cancelled` -> `closed`；task `blocked/unknown` -> `attention`。
- `RuntimeConversation`：channel target 和 thread target 可生成 conversation；`threadId` / `messageId` 用作外部引用。
- `RuntimeExecution`：不应从 Slock task status 或 server `active` 推断 execution running。执行态需要额外路径：
  - 优先继续探测 Slock 是否有可用 activity/event API。
  - 可选使用 Lorume-managed launcher 或进程内 observer 读取 daemon `agent:activity`。
  - 可选使用网络 proxy 观察 WSS/HTTPS 事件，但若要读明文需要证书/进程代理配合，成本和安全边界更重。

结论：

- Slock 能满足业务看板态和部分会话态。
- Slock 当前能通过本地 agent token 调 internal task API 满足 task board / conversation linkage；真实执行态仍不能仅靠 CLI/server info 满足，需要 activity API、observer 或 proxy 方案补齐。

## 设计规则

- Adapter 可以选择不同采集策略，但必须归属 `lorume` CLI 内部实现，并输出 Lorume 统一模型。collector / daemon 只能调用 `lorume collect work-state --json`，不能直接读取第三方私有目录、内部 token、内部 API 或平台原始字段。
- WorkItem 状态和 Execution 状态必须分开：看板 `in_progress` 代表 Agent 正在承接工作，但不代表已经有一条 `RuntimeExecution.running` 记录。
- OpenClaw 先作为 execution/session 强来源；DingTalk message context 只有被 task、task origin、requester session 或 trajectory prompt 关联时才作为 message-backed work item 来源。
- Multica 作为 work item + execution 的强来源。
- Slock 作为 task board 强来源，优先由 `lorume` CLI adapter 在授权上下文内读取本地 agent context 并调用稳定 task-board API；execution state 需要单独方案。
- 网络 proxy 可以作为增强策略，但当前不默认要求 TLS 明文拦截；优先使用平台 API/CLI 和低侵入 observer。

## Collector 落地规则

`scripts/lorume-device-collector.mjs --work-state-once` 必须是 live-first。它不再生成内置 work-state fixture，也不允许在探测失败时伪造工作项、会话或执行态。设备侧只安装 Lorume device package，collector 必须通过 `lorume collect work-state --json` 获取工作态。

Collector 常驻模式必须刷新 work-state。`--once` 只适合一次性 inventory smoke；正式 daemon 启动和周期刷新都要同时上报 `POST /api/device-snapshots` 与 `POST /api/runtime-work-state-snapshots`，避免 Runtime Fleet 已更新但 Runs 仍停留在旧工作态。后端 WebSocket 只维护连接健康，不请求设备执行 work-state 采集。

CLI Adapter 实现：

- OpenClaw：读取 `openclaw health --json --timeout 5000`、`openclaw status --json --timeout 5000`、`openclaw tasks list --json`，并在 `lorume` CLI adapter 边界内读取 OpenClaw 已公开或已约定的本地状态摘要。有 message id、DingTalk requester session、task origin 或 trajectory prompt 关联时生成 `RuntimeWorkItem`、`RuntimeConversation` 和 `RuntimeExecution`；无关联的裸 execution 和未关联入站消息只保留为执行或会话证据，不进入 Runs 工作项。OpenClaw `health/status/tasks` 输出可能较大，`lorume` CLI 必须用受控的大 buffer 读取 JSON，避免 stdout 截断后误报 `failed or returned non-JSON`。OpenClaw CLI 可能是 `#!/usr/bin/env node` shim，CLI 的 probe 环境必须把 shim 所在目录、当前 Node 安装目录和常见用户 bin 目录加入 `PATH`，否则 launchd / ssh 的最小环境会导致 `env: node: No such file or directory`。
- Multica：读取 `multica runtime list --output json`、`multica agent list --output json`、`multica issue list --output json`、`multica agent tasks <agent-id> --output json`。issue 生成 `RuntimeWorkItem`，agent task 生成 `RuntimeExecution`，`chat_session_id` 生成 `RuntimeConversation`。
- Slock：优先使用 `slockServerUrl` / `SLOCK_SERVER_URL`，未配置时默认使用 `https://api.slock.ai`，并由 `lorume` CLI adapter 在授权上下文内读取本地 Slock agent context；先从 `/server` 自动发现 joined channel，再用 `tasks?channel=#频道名` 拉 task board。如用户显式配置 `slockTaskChannels`，则只采集配置范围。task-board internal API 遇到临时 5xx、网络抖动或超时时做小次数重试；重试成功不记录 channel probe warning；同 channel 被其他 agent context 成功采集时不保留失败 warning。失败后再尝试本机 `slock task list` CLI。仅有 Slock workspace 目录只能证明本机存在 Slock agent workspace，不能证明 task board、会话或执行态。

Collector 实现：

- `--once` 调用 `lorume collect inventory --json` 后上报 inventory snapshot。
- `--work-state-once` 调用 `lorume collect work-state --json` 后上报 work-state snapshot。
- 后端不通过控制面编排 CLI 命令。collector 自己负责在启动、周期刷新或本机显式命令中调用两条 CLI 命令、POST snapshot 和记录用户可读错误。
- 新增平台探测能力时，先扩展 `lorume` CLI adapter 与 CLI harness，再让 collector 消费 CLI 输出。

失败规则：

- 某个平台命令不存在、返回非 JSON 或缺少目标数据时，对应对象数组保持为空。
- `RuntimeObservationCapability` 要把缺口标成 `unknown` 或 `unsupported`，并用 `warnings` 说明失败原因。
- Slock `server active`、daemon 进程存在、workspace 文件存在，都不能映射为 Lorume `RuntimeExecution.status=running`。
- 前端和 query model 只能消费归一化后的 Lorume 模型，不能读取平台原始字段自行推断状态。
- 前端不能展示 adapter 调试证据、英文 limitation、原始 command、原始 API 字段或“直接证据”这类采集内部话术。采集缺口不能包装成任务卡；详细证据留在 spec、测试和日志中。

Harness：

- `src/runtime/device-collector-script.test.ts` 覆盖 live probe contract：无探测来源时不伪造数据、OpenClaw fake CLI + DingTalk local state 映射已关联的 message-backed WorkItem/execution、OpenClaw 未关联入站消息只生成会话证据、OpenClaw DingTalk requester session 在 message context 为空时映射 WorkItem、OpenClaw trajectory 在 session JSONL 缺失时仍能用 prompt 生成 WorkItem、OpenClaw shim 在最小 `PATH` 下仍可运行、OpenClaw 大 JSON 输出不会被截断成不可用、Multica fake CLI 映射 issue/task、Slock internal API 自动发现 channel 并映射 task board、Slock CLI fallback 在空任务 channel 下仍返回 capability、不引用未定义状态、Slock transient task-board failure 会重试、Slock workspace-only 不生成 board state。
- `src/runtime/runtime-work-state-adapters.test.ts` 覆盖 TypeScript adapter 语义：OpenClaw 已关联 DingTalk message / requester session / trajectory 与 execution 分层、未关联 DingTalk message 只作为会话上下文、Multica issue/task 分层、Slock task board 与 activity evidence 分层。

## 前端闭环范围

Runs / Work Board 是只读 Agent 工作视图，用于验证统一工作态模型是否能被用户理解和验收。

- 页面读取 `GET /api/runtime-work-items`，由后端执行搜索、来源 Runtime、Channel、阶段、时间范围、排序和 cursor 分页；正式查询不可用时保留当前页面状态并展示错误，生产构建不得回退 fixture，开发期离线预览只使用明确标识的 fixture，不再读取 latest snapshot API。
- 后端返回的 `stage` 是已经物化的 Lorume WorkStage，前端以它作为分栏和阶段筛选依据；前端不得在查询结果路径里再按 `status` 覆盖成另一套阶段。
- 后端搜索语义必须覆盖用户在 Runs 页面看到的主要识别信息：任务标题、消息摘要、发起人、承接 Agent、Runtime、Channel、会话/群组。前端不再本地重放一套不同的搜索规则。
- 页面以 `total` 和 `nextCursor` 展示已加载数量，并通过 `加载更多` 继续请求后端下一页；加载更多只能追加当前筛选条件下的同一查询结果。筛选条件变化后，旧查询的 cursor 不能继续用于新筛选条件；结果摘要不能出现 `已显示` 大于 `total` 的状态。`加载更多` 必须和已显示数量放在同一结果摘要区域，不能藏在数百张卡片之后。
- 页面只消费 `runtime-work-state-query.ts` 生成的 lane、summary 和 detail。
- 页面不直接判断 OpenClaw、Multica、Slock 原始状态含义。
- 页面不提供拖拽、写回、指派、接管聊天或代理流量入口。
- 页面必须展示发起人、承接 Agent、Runtime、Channel、会话/群组、消息摘要、工作项状态和最近同步时间。Runtime 表示 OpenClaw / Multica / Slock / Codex 等承载侧，Channel 表示 DingTalk / Telegram / Slack 等用户触达侧；Slock、Multica、OpenClaw、Codex 不能作为 Runs 的 Channel 选项。会话/群组表示用户实际发起任务的可读上下文。
- Runs 的 Channel 筛选默认展示为 `全部`，候选项必须从当前快照中实际出现的用户触达渠道动态生成；当前只出现 DingTalk 时，只展示 `全部` 和 `DingTalk`，后续检测到 Telegram、Slack 等再自动追加。
- Runs 支持按时间范围过滤卡片。时间范围使用工作项的 `lastSeenAt` 做包含式过滤；启用时间范围后，没有 `lastSeenAt` 的卡片不进入结果。筛选条件变化后应请求后端查询 API，前端仅保留当前结果作为页面状态。页面使用阶段筛选后的单个时间范围控件，不把开始/结束时间输入框直接铺在工具栏里。展开控件后必须支持手动选择开始时间、结束时间、清除时间，并提供 `今天`、`昨天`、`七天内`、`本星期`、`上星期` 等快捷项；除进入日历选择/自定义面板外，点击快捷时间、清除、确认或弹窗外区域都必须关闭弹窗。
- Runs 的时间范围摘要在常规桌面宽度下使用紧凑格式保持可读，完整时间保留在控件 title 和展开面板里；搜索框是主要输入入口，来源 Runtime、渠道、阶段筛选不应挤占搜索与时间范围的主要展示空间。
- 任务卡顶部只展示 Runtime 和真实 Channel，不重复展示所在泳道阶段；阶段已经由泳道标题和详情概览承载。
- 任务卡和详情面板必须处理长 URL、长 MR 标题、长消息摘要等内容，使用截断或换行约束在当前容器内展示，不允许产生卡片内或详情面板内的横向滚动。
- 详情面板标题最多展示有限行数，完整标题保留在元素 `title` 上；消息正文或长摘要放在 `消息摘要` 区块，避免一个长任务标题挤占整个详情首屏。
- 页面不得把 OpenClaw DingTalk `cid...`、手机号、open conversation id 或其他不可读外部 id 当作会话/群组名称展示；缺少群名映射时展示 `DingTalk 群聊`，缺少私聊人名时展示 `DingTalk 私聊`。
- 页面详情没有关联 execution 时可以不展示执行状态；不能把无 execution 的真实工作项显示成“不支持采集”。
- 页面不得把未关联上游任务的 OpenClaw / Multica / Slock execution 渲染为任务卡；这类 execution 可以参与关联工作项的执行状态，也可以进入后续运行记录视图，但不能污染任务看板。
- 页面不得把 OpenClaw `execution_only`、Slock `not_ready`、capability gap 或监听状态渲染成任务卡，也不得在当前 Runs 页面展示平台能力缺口指标。平台能力缺口只进入后续诊断区、harness 或运维日志，不污染用户任务视图。
- 页面不得展示 `confidence`、`evidence`、`limitations`、stage derivation reason、adapter warning 等调试字段。
- 页面在常见 laptop / desktop / mobile 宽度下不能产生文档级横向溢出；泳道列数应按容器自适应。
