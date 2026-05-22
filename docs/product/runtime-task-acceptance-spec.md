# Runtime Task Acceptance Spec

版本：TinySpec v1.2

本文定义 Lorume 当前 Task 采集与 Runs 展示的验收口径。它不是平台能力承诺；它约束 adapter、collector、backend query 和 Runs / Work Board 必须围绕 `Device / Runtime / Agent / Task` 一套模型工作。

## 验收目标

Runs / Work Board 必须让用户看清：

- 哪个 Agent 承接了任务。
- 任务来自哪个用户触达渠道或会话。
- 当前任务状态是什么。
- 任务在源系统中的最近业务时间。
- 失败时是否有用户可读的错误摘要。

页面只消费后端 `GET /api/runtime-tasks` 返回的 `Task` 查询模型。生产构建不得读取旧 latest snapshot，不得请求旧 work item API，不得由前端解释平台 raw payload。

## 当前范围

| 平台 | 当前状态 | 规则 |
|---|---|---|
| OpenClaw | 默认启用 | 可以生成 Runtime、Agent、Task。 |
| Slock | 默认禁用 | 不执行命令、不读目录、不生成对象。 |
| Multica | 默认禁用 | 不执行命令、不读目录、不生成对象。 |
| Codex | 未来 Runtime kind | 当前默认不采集。 |

新增平台前必须先补产品 spec、adapter contract 和 harness。

## 必须满足

- 每个 Task 必须有 `id`、`agentId`、`taskType`、`status`。`conversation` 和 `scheduled` Task 都必须有可解释的 `userMessage`；`agentReply` 可为空。
- Task 不能携带 `runtimeId`；Runtime / Device 通过 Agent 关系查询。
- Task 状态只用 `Task.status` 表达，不拆成 status / executionStatus 两套。
- Adapter 负责把平台原始状态映射为 `Task.status`，但必须在 Task raw/evidence 中保留平台原始状态。
- Task 不保存 `title`、`description`、`toolCalls` 或 `lastSeenAt`。前端/BFF 展示标题从 `userMessage` 派生。
- Runtime 和 Agent 只展示 `collectionStatus`，不保存工作忙闲。
- Runs Channel 筛选只能使用 Task 中实际出现的用户触达渠道，不能把 OpenClaw、Slock、Multica、Codex 这类 Runtime kind 当作渠道。
- 不能把裸 execution、adapter capability gap、监听缺口或诊断项伪造成任务卡。
- 不能展示 adapter evidence、英文 limitation、原始 command、原始 API 字段或不可读外部 id。

## OpenClaw 验收

OpenClaw adapter 只有在外部证据能明确归属到 Agent 时才生成 Task：

- `conversation` Tasks 来自 OpenClaw session JSONL、trajectory JSONL 和 DingTalk state；DingTalk `userMessage` 必须来自 inbound message context。
- `scheduled` Tasks 来自 OpenClaw cron session JSONL 和 trajectory JSONL。
- `openclaw tasks list` 不得在当前实现中创建产品 Task；它只能作为 diagnostics/raw 对照。
- 有明确 task id / message id / trajectory id 时生成稳定 `Task.id`。
- 能识别发起人时写入 `creator.name`。
- 能识别群聊或私聊时写入可读 `conversation.title`。
- 能识别 OpenClaw agent 时写入 `agentId`，且该 `agentId` 必须引用本次采集到的 Agent。
- Tool calls 当前不上报、不入库；不新增 first-class ToolCall / Execution / Run 实体。
- Adapter 映射 raw OpenClaw status 到 Lorume `Task.status`，并保留 raw status 到 `raw.openclaw.status`。
- 无法归属 Agent、缺少 `userMessage` 或只有内部运行证据时跳过，并写 diagnostic warning。
- `done` conversation 缺少 `agentReply` 可以入库，但必须写 diagnostic warning。
- OpenClaw session / trajectory 历史数据长期累积时，adapter 只输出最近任务有界窗口，collector 再分批上报；不得通过扩大后端请求体上限来掩盖设备侧数据失控。

OpenClaw DingTalk 兜底：

- 群聊无名称：`DingTalk 群聊`。
- 私聊无名称：`DingTalk 私聊`。
- 不把 `cid...`、手机号或 open conversation id 展示给用户。

## 维护规则

- Adapter 策略变化时，同步更新本 spec、`docs/product/runtime-openclaw-adapter-spec.md` 和对应 harness。
- 真实设备验证结果只能沉淀为当前字段约束、脱敏 fixture 或可执行测试，不保留个人机器路径、原始 token 或临时 checklist。
- 如果验收发现测试金字塔漏掉真实行为，先把缺口归类为 unit、script、backend API、DB integration 或 Playwright E2E，再补最小 harness。
- 后端 WebSocket 只验证连接健康，不作为采集触发器。
