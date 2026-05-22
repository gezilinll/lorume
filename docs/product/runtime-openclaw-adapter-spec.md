# Runtime OpenClaw Adapter Spec

版本：TinySpec v1.2

本文定义当前 OpenClaw adapter 如何把平台侧只读证据转换成 Lorume 正式模型中的 `Runtime`、`Agent` 和 `Task`。当前默认 runtime adapter allowlist 只启用 OpenClaw；其他 adapter 是否启用由各自 spec 和 harness 决定。

## 模型边界

Lorume 当前只有四个 Runtime 资产对象：

- `Device`：机器事实、collector 元信息和采集状态。
- `Runtime`：设备上的运行环境，例如 OpenClaw。
- `Agent`：Runtime 下的工作主体。
- `Task`：Agent 承接的工作。

关系固定为 `Device -> Runtime -> Agent -> Task`。`Task` 只保存 `agentId`；需要 Runtime 或 Device 信息时由后端 join 或 BFF composition 得到。不要新增 Conversation、Execution、Capability、SourceRef、Channel 或 Run 一等实体。

## Task 字段

Task 是 Runs / Work Board 的唯一业务工作单元。

```ts
export interface Task {
  id: string;
  agentId: string;
  taskType: "conversation" | "scheduled";
  status: TaskStatus;
  userMessage?: string;
  agentReply?: string;
  source?: { kind?: "openclaw"; externalId?: string };
  channel?: {
    kind: "dingtalk" | "webchat" | "telegram" | "slack" | "other";
    name?: string;
    externalId?: string;
  };
  conversation?: {
    title?: string;
    externalId?: string;
    lastActivityAt?: string;
  };
  assignee?: { name: string; externalId?: string };
  creator?: { name?: string; externalId?: string };
  raw?: {
    openclaw?: {
      status?: string;
      statusSource?: "session" | "trajectory" | "tasks_list";
      sessionId?: string;
      sessionKey?: string;
      messageId?: string;
      trajectoryRunId?: string;
    };
  };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}
```

不允许在 Task 上保存 `runtimeId`、`run`、`execution` 或 `lastRun`。任务的当前状态只看 `Task.status`。
当前模型不上传 `title`、`description`、`toolCalls` 或 Task `lastSeenAt`。`userMessage` 保存用户原始消息或定时任务 prompt，`agentReply` 保存 Agent 给用户的最终答复摘要。页面标题由查询层从 `userMessage` 派生，不重复落库。

## 状态映射

| 外部证据 | Lorume `TaskStatus` |
|---|---|
| queued, pending, todo | `todo` |
| running, active, in_progress | `in_progress` |
| review, in_review | `review` |
| succeeded, completed, done | `done` |
| blocked, waiting_on_dependency | `blocked` |
| failed, error | `failed` |
| cancelled, canceled, interrupted | `cancelled` |
| timed_out, timeout, lost | `failed` |
| 不能可靠判断 | `unknown` |

Runtime 和 Agent 不保存 working / idle。页面需要“进行中数量”“失败数量”时，从 Task 聚合。

Adapter 负责生成归一化 `Task.status`，但不得覆盖 OpenClaw 原始状态。原始状态保存在 `Task.raw.openclaw.status`，并通过 `Task.raw.openclaw.statusSource` 标注状态来自 session、trajectory 或 tasks_list diagnostics。

## OpenClaw Adapter

OpenClaw adapter 输出当前本地 `DeviceStateSnapshot` 内的 `runtimes`、`agents`、`tasks`；collector 再拆分为 metadata snapshot 和 Task batch 上报。

| Lorume 对象 | OpenClaw 来源 | 规则 |
|---|---|---|
| Runtime | OpenClaw config、health/status 只读结果 | 生成一个 OpenClaw Runtime，kind 为 `openclaw`。 |
| Agent | OpenClaw agent 配置或 health/status 中可识别的 agent | 每个真实 agent 生成一个 Lorume Agent。 |
| Task | OpenClaw session JSONL、trajectory JSONL、DingTalk state | 只生成能明确归属到 Agent 的 `conversation` 或 `scheduled` 任务；无法唯一归属时跳过并写 diagnostic warning。 |

稳定 ID：

| 对象 | 规则 |
|---|---|
| Runtime | `${deviceId}:runtime:openclaw` |
| Agent | `${runtimeId}:agent:${openClawAgentId}` |
| Task | `${agentId}:task:${externalTaskId}` |

### OpenClaw 数据源优先级

真实设备 profiling 显示，`openclaw tasks list` 主要是内部任务注册/近期状态视角，且其 `runId` 与 session/trajectory 的运行实例 id 不稳定重合。当前实现不从 `openclaw tasks list` 生成产品 Task。

| 用途 | 首选来源 | 说明 |
|---|---|---|
| Runtime | `openclaw health --json`、`openclaw status --json`、`~/.openclaw/openclaw.json` | 只读探测 OpenClaw 是否存在、版本和 agent 列表。 |
| Agent | health/status/config 中的 agent id | 生成 Lorume Agent，当前真实样本主要是 `main`。 |
| 会话任务 | session `*.jsonl`、`*.trajectory.jsonl`、`dingtalk-state/*.json` | 一条可识别用户消息 turn 生成一个 `taskType="conversation"` 的 Task。 |
| 定时任务 | cron session JSONL 和 trajectory JSONL | 一次 cron 执行生成一个 `taskType="scheduled"` 的 Task。 |
| ToolCall | session JSONL 中 assistant `toolCall` 和后续 `toolResult` | 当前不入库、不上报；仅允许 adapter 内部用于失败摘要判断。 |
| Diagnostics | `openclaw tasks list --json` | 可保存为 warning/raw diagnostics，不作为产品 Task 来源。 |

### OpenClaw Task Snapshot 窗口

OpenClaw adapter 不按数量或字节窗口裁剪符合产品标准的 Task。Adapter 在生成产品 Task 后只按最近活动时间排序，排序时间使用 `updatedAt`，缺失时使用 `createdAt`；所有符合标准的 Task 交给 collector 的 Task batch/hash ACK 机制分批上报。体积控制属于 collector 传输层分批问题，不允许 adapter 静默丢弃已识别的产品 Task。

### OpenClaw Task 类型

| `taskType` | 识别规则 | 入库规则 |
|---|---|---|
| `conversation` | `sessionKey` 包含 `:dingtalk:` / `:webchat:`，或存在用户触达渠道 + conversation 证据 | 必须有可识别 `userMessage` 才入库。 |
| `scheduled` | `sessionKey` 包含 `:cron:`，或用户 prompt 以 `[cron:` 开头 | 用 cron prompt 作为 `userMessage`。 |
| manual / background / unknown | explicit、announce、subagent、system、background、Multica workspace prompt、无法稳定分类 | 当前不入产品 Task，写 diagnostics。 |

### OpenClaw Agent 映射

Task 必须映射到本次采集到的 Agent。

1. Runtime id 固定为 `${deviceId}:runtime:openclaw`。
2. Agent id 固定为 `${runtimeId}:agent:${openClawAgentId}`。
3. Task 从 `sessionKey` 解析 `agent:<openClawAgentId>:`，例如 `agent:main:dingtalk:group:...` 解析为 `main`。
4. 如果 `sessionKey` 解析不到 agent，且 health/status/config 无法唯一确定 agent，这条 Task 不入库。
5. 如果解析出的 agent 不在本次采集的 agents 集合中，这条 Task 不入库，并写 diagnostic warning。

### OpenClaw 字段映射

| Task 字段 | OpenClaw 来源 | 示例 |
|---|---|---|
| `taskType` | adapter 分类 | `conversation` |
| `id` | `${agentId}:task:${messageId 或 trajectoryRunId}` | `...:task:581a02f8-5fa2-4eb2-bf9d-ae4e68d2ac7a` |
| `agentId` | `sessionKey` + 本次采集到的 Agent | `...:runtime:openclaw:agent:main` |
| `status` | adapter 映射后的 Lorume 状态 | `done` |
| `userMessage` | DingTalk inbound message text；scheduled task 使用 cron prompt | `帮我查询示例模型的调用次数、成功次数和失败原因...` |
| `agentReply` | trajectory `assistantTexts` | `已查询，调用 42 次，失败 3 次。` |
| `source.kind` | adapter 固定值 | `openclaw` |
| `source.externalId` | message id 或 trajectory run id | `581a02f8-5fa2-4eb2-bf9d-ae4e68d2ac7a` |
| `channel.kind` | `sessionKey` 或 DingTalk state | `dingtalk` |
| `conversation.title` | sessions index、runtime context、DingTalk target | `示例工作群` |
| `conversation.externalId` | DingTalk conversation id | `cid+example` |
| `creator.name` | runtime context、origin label | `示例用户` |
| `creator.externalId` | runtime context sender id | `user-example-001` |
| `assignee.name` | OpenClaw agent id，缺失时默认 `main` | `main` |
| `assignee.externalId` | OpenClaw agent id，缺失时默认 `main` | `main` |
| `raw.openclaw.status` | session/trajectory 原始状态 | `done` / `success` / `error` |
| `raw.openclaw.sessionId` | session file name 或 sessions index | `09fe1f68-d410-4dd6-a79c-14dc33c92ad9` |
| `raw.openclaw.sessionKey` | sessions index / trajectory | `agent:main:dingtalk:group:cid+...` |
| `raw.openclaw.messageId` | user message record id | `581a02f8-5fa2-4eb2-bf9d-ae4e68d2ac7a` |
| `raw.openclaw.trajectoryRunId` | matched trajectory run id | `6602d2a1-7e4a-4c9d-bef0-050b6b2af6d5` |
| `createdAt` | user message timestamp / cron run start | `2026-05-21T09:10:33.514Z` |
| `updatedAt` | session/trajectory last event | `2026-05-21T09:10:33.577Z` |
| `error` | failed task/tool/trajectory 的用户可读摘要 | `Column 'event_code' cannot be resolved` |

DingTalk `conversation` 的 `userMessage` 必须来自 inbound message context，不能用 assembled prompt 或 session fallback 伪造。缺少 inbound message context 的 conversation run 不入库，并写 diagnostic warning。`done` conversation 缺少 `agentReply` 可以入库，但必须写 diagnostic warning。

## 用户可读规则

- DingTalk 群聊缺少可读群名时，显示 `DingTalk 群聊`。
- DingTalk 私聊缺少可读人名时，显示 `DingTalk 私聊`。
- OpenClaw、Slock、Multica、Codex 是 Runtime 来源，不是用户触点渠道；没有用户触点证据的任务省略 `channel` 和 `conversation`。
- 不展示 `cid...`、手机号、open conversation id 或其他不可读外部 id 作为会话名。
- 没有 `userMessage` 或可解释用户上下文的外部对象不能伪造成任务卡；保留在 diagnostics 或日志中。
- 未关联 Agent 的 OpenClaw execution、内部 heartbeat、恢复任务、approval followup 等系统事件不进入 Runs。
- 当前不上报 tool call 明细；后续如要支持，必须先补跨平台数据结构、权限边界和 harness。

## Collector 边界

Collector 只调用：

```sh
lorume collect device-state --json
```

Collector 不调用旧 inventory 或旧工作态命令，不直接读取第三方 Runtime 私有目录、内部 token、内部 API 或平台原始字段。OpenClaw 私有目录读取只能存在于 `lorume` CLI adapter 内部。Adapter 命令、原始证据和 path 细节只存在于 CLI adapter 内部、diagnostics、结构化日志或 DB raw，不进入产品 API / UI 主模型。

## Harness

- `src/cli/lorume-cli.test.ts` 覆盖 `lorume collect device-state`、JSON 错误码和路径安全。
- `src/runtime/device-collector-script.test.ts` 覆盖 collector 只通过 CLI 获取 `device_state`、拆分上报 `/api/device-state-snapshots` 与 `/api/device-task-batches`、安装/卸载文件完整性。
- `src/runtime/runtime-work-query-api.test.ts` 覆盖 Runs Task 查询响应解析、筛选和分页。
- `e2e/runtime-work-board.spec.ts` 覆盖浏览器级 Runs / Work Board 展示，不依赖旧 latest snapshot 或旧 work item API。
