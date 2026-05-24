# Runtime Task Acceptance Spec

版本：TinySpec v1.5

本文定义 Lorume 当前 Task 采集与 Runs 展示的验收口径。它不是平台能力承诺；它约束 adapter、collector、backend query 和 Runs 必须围绕 `Device / Runtime / Agent / Task` 一套模型工作。

## 验收目标

Runs 的会话任务页必须让用户看清：

- 哪个 Agent 承接了任务。
- 任务来自哪个用户触达渠道或会话。
- 当前任务状态是什么。
- 任务在源系统中的最近业务时间。
- 失败时是否有用户可读的错误摘要。

页面只消费后端 `GET /api/runtime-tasks?taskType=conversation` 返回的 `Task` 查询模型、summary 和 facets。生产构建不得读取旧 latest snapshot，不得请求旧 work item API，不得由前端解释平台 raw payload。

定时任务当前允许采集和入库，但不在本阶段 Runs 页面展示。新增定时任务页面前，必须先补页面 spec 和 harness。

## 当前范围

| 平台 | 当前状态 | 规则 |
|---|---|---|
| OpenClaw | 默认启用 | 可以生成 Runtime、Agent、Task。 |
| Slock | 默认启用 | 已有 `docs/product/runtime-slock-adapter-spec.md` 约束 daemon credential discovery、ownership proof、分页和 Task 映射；只有本机 Slock workspace 与 daemon 参数可证明当前设备真实承载 Agent 时才生成 Task。 |
| Codex | 默认启用 | 已有 `docs/product/runtime-codex-adapter-spec.md` 约束 Codex 本地数据源、ownership 分类、状态映射和 Task 映射；只采集 Codex native/other 会话。 |
| Multica | 默认禁用 | 不执行命令、不读目录、不生成对象。 |

新增平台前必须先补产品 spec、adapter contract 和 harness。

## 必须满足

- 每个 Task 必须有 `id`、`agentId`、`taskType`、`status`。`conversation` 和 `scheduled` Task 都必须有可解释的 `userMessage`；`agentReply` 可为空。
- Task 不能携带 `runtimeId`；Runtime / Device 通过 Agent 关系查询。
- Task 状态只用 `Task.status` 表达，不拆成 status / executionStatus 两套。
- Adapter 负责把平台原始状态映射为 `Task.status`，但必须在 Task raw/evidence 中保留平台原始状态。
- Task 不保存 `title`、`description`、`toolCalls` 或 `lastSeenAt`。前端/BFF 展示标题从 `userMessage` 派生。
- Task 必须保存 `adapter.kind` 表示采集归一化来源。当前支持 `openclaw`、`slock` 和 `codex`；未实现的 adapter 或 channel kind 不提前进入枚举。
- Runtime 和 Agent 只展示 `collectionStatus`，不保存工作忙闲。
- Runs Channel 筛选只能使用 Task 中实际出现的用户触达渠道，不能把 Runtime kind 或 adapter kind 当作渠道。
- 不能把裸 execution、adapter capability gap、监听缺口或诊断项伪造成任务卡。
- 不能展示 adapter evidence、英文 limitation、原始 command、原始 API 字段或不可读外部 id。

## Runs 查询契约

`GET /api/runtime-tasks` 必须支持 `taskType=conversation`。Runs 会话任务页必须始终传入该参数，不展示“全部 Task”视图。

响应必须包含：

- `items`: 当前页 Task。
- `total`: 当前筛选条件下的 Task 总数。
- `nextCursor`: 下一页 cursor，可为空。
- `summary.byStatus`: 按状态聚合的数量。它应用当前 search/time/channel 过滤，但不被当前选中的 status 再次收窄。
- `facets.channels`: 当前可选 Channel kind 和用户可读 label。它应用当前 search/time/status 过滤，但不被当前选中的 channel 再次收窄。

Runs 页面可以按状态泳道分别分页请求。每个泳道的加载、错误、空态和“加载更多”互相独立。

无 channel/conversation 的会话任务必须使用用户可读兜底：

- Codex：`本地 Codex 会话`。
- Slock：`Slock 会话`。
- 其他 adapter：使用该 adapter spec 中定义的兜底；不能展示 raw id。

## OpenClaw 验收

OpenClaw adapter 只有在外部证据能明确归属到 Agent 时才生成 Task：

- `conversation` Tasks 来自 OpenClaw session JSONL、trajectory JSONL、`model.completed.messagesSnapshot` 和 DingTalk state；DingTalk `userMessage` 必须来自明确用户消息 turn 证据，例如按 `messageId` 精确匹配的 inbound message，或同一 trajectory run 内带 runtime context 的 `messagesSnapshot` user message。
- `scheduled` Tasks 来自 OpenClaw cron session JSONL 和 trajectory JSONL。
- `openclaw tasks list` 不得在当前实现中创建产品 Task；它只能作为 diagnostics/raw 对照。
- 有明确 task id / message id / trajectory id 时生成稳定 `Task.id`。
- 能识别发起人时写入 `creator.name`。
- 能识别群聊或私聊时写入可读 `conversation.title`。
- 能识别 OpenClaw agent 时写入 `agentId`，且该 `agentId` 必须引用本次采集到的 Agent。
- Tool calls 当前不上报、不入库；不新增 first-class ToolCall / Execution / Run 实体。
- Adapter 映射 raw OpenClaw status 到 Lorume `Task.status`，并保留 raw status 到 `raw.openclaw.status`。
- 无法归属 Agent、缺少 `userMessage` 或只有内部运行证据时跳过，并写 diagnostic warning；不能用 assembled prompt、session fallback、日志时间邻近或 LLM 推断伪造 DingTalk `userMessage`。
- `done` conversation 缺少 `agentReply` 可以入库，但必须写 diagnostic warning。
- OpenClaw session / trajectory 历史数据长期累积时，adapter 仍输出所有符合产品标准的 Task；collector 负责分批上报、ACK cache 和 hash-based 重传，不通过 adapter 窗口丢弃数据。

OpenClaw DingTalk 兜底：

- 群聊无名称：`DingTalk 群聊`。
- 私聊无名称：`DingTalk 私聊`。
- 不把 `cid...`、手机号或 open conversation id 展示给用户。

## Codex 验收

Codex adapter 只有在本机 Codex thread 能安全分类为 `codex-native-or-other` 时才生成 Task：

- Runtime 固定为 `Runtime.kind="codex"`，Agent 第一版固定为本地 `Codex` Agent。
- Task 来自 `~/.codex/state_5.sqlite` 的 thread index 和 thread 引用的 session JSONL。
- Slock-owned Codex session 不入库为 Codex Task，由 Slock adapter 负责 Slock 平台 Task。
- Multica-owned Codex session 不入库为 Codex Task。
- `Task.status` 第一版只允许 `done` 和 `unknown`；新状态必须先有 profiling 证据、spec 和失败测试。
- `userMessage` 必须来自 thread index 或 JSONL 用户消息证据；缺失时跳过并写 diagnostic。
- `agentReply` 可为空，不能合成。
- Codex Task 不写 `channel` 和 `conversation`，除非后续有稳定用户触点证据和 harness。
- 当前不上报 JSONL 原文、tool calls、tool arguments、token、凭据或完整 raw payload。

## 维护规则

- Adapter 策略变化时，同步更新本 spec、对应 adapter spec 和对应 harness。
- 真实设备验证结果只能沉淀为当前字段约束、脱敏 fixture 或可执行测试，不保留个人机器路径、原始 token 或临时 checklist。
- 如果验收发现测试金字塔漏掉真实行为，先把缺口归类为 unit、script、backend API、DB integration 或 Playwright E2E，再补最小 harness。
- 后端 WebSocket 只验证连接健康，不作为采集触发器。
