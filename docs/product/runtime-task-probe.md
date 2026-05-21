# Runtime Task Probe Spec

版本：TinySpec v1.1

本文定义 Runtime adapter 如何把平台侧只读证据转换成 Lorume 当前正式模型中的 `Task`。当前阶段是 OpenClaw-first：默认只启用 OpenClaw adapter，Slock、Multica、Codex 不执行命令、不读目录、不生成对象。

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
  title: string;
  description?: string;
  status: TaskStatus;
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
  assignee?: { name?: string };
  creator?: { name?: string; externalId?: string };
  toolCalls?: Array<{
    id: string;
    name: string;
    status: "done" | "failed" | "unknown";
    arguments?: unknown;
    resultPreview?: string;
    error?: string;
  }>;
  raw?: {
    openclaw?: {
      status?: string;
      statusSource?: "session" | "trajectory" | "tool" | "tasks_list";
      sessionId?: string;
      sessionKey?: string;
      messageId?: string;
      trajectoryRunId?: string;
    };
  };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
}
```

不允许在 Task 上保存 `runtimeId`、`run`、`execution` 或 `lastRun`。任务的当前状态只看 `Task.status`。

`toolCalls` 是 Task 内嵌证据，不是独立产品实体。P0 不新增 first-class `ToolCall`、`Conversation`、`Execution`、`Evidence` 或 `Run` 表。后端可以把完整 Task JSON 存入 `tasks.raw`，但产品查询只应暴露经过权限和字段策略确认的字段。

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

Adapter 负责生成归一化 `Task.status`，但不得覆盖 OpenClaw 原始状态。原始状态保存在 `Task.raw.openclaw.status`，并通过 `Task.raw.openclaw.statusSource` 标注状态来自 session、trajectory、tool 或 diagnostics。

## OpenClaw Adapter

OpenClaw adapter 输出当前 `DeviceStateSnapshot` 内的 `runtimes`、`agents`、`tasks`。

| Lorume 对象 | OpenClaw 来源 | 规则 |
|---|---|---|
| Runtime | OpenClaw config、health/status 只读结果 | 生成一个 OpenClaw Runtime，kind 为 `openclaw`。 |
| Agent | OpenClaw agent 配置或 health/status 中可识别的 agent | 每个真实 agent 生成一个 Lorume Agent。 |
| Task | OpenClaw session JSONL、trajectory JSONL、sessions index、DingTalk state | 只生成能明确归属到 Agent 的 `conversation` 或 `scheduled` 任务；无法唯一归属时跳过并写 diagnostic warning。 |

稳定 ID：

| 对象 | 规则 |
|---|---|
| Runtime | `${deviceId}:runtime:openclaw` |
| Agent | `${runtimeId}:agent:${openClawAgentId}` |
| Task | `${agentId}:task:${externalTaskId}` |

### OpenClaw 数据源优先级

真实设备 profiling 显示，`openclaw tasks list` 主要是内部任务注册/近期状态视角，且其 `runId` 与 session/trajectory 的运行实例 id 不稳定重合。P0 不从 `openclaw tasks list` 生成产品 Task。

| 用途 | 首选来源 | 说明 |
|---|---|---|
| Runtime | `openclaw health --json`、`openclaw status --json`、`~/.openclaw/openclaw.json` | 只读探测 OpenClaw 是否存在、版本和 agent 列表。 |
| Agent | health/status/config 中的 agent id | 生成 Lorume Agent，当前真实样本主要是 `main`。 |
| 会话任务 | `~/.openclaw/agents/*/sessions/sessions.json`、对应 session `*.jsonl`、`*.trajectory.jsonl`、`dingtalk-state/*.json` | 一条用户消息 turn 生成一个 `taskType="conversation"` 的 Task。 |
| 定时任务 | cron session JSONL 和 trajectory JSONL | 一次 cron 执行生成一个 `taskType="scheduled"` 的 Task。 |
| ToolCall | session JSONL 中 assistant `toolCall` 和后续 `toolResult` | 内嵌到 `Task.toolCalls[]`。 |
| Diagnostics | `openclaw tasks list --json` | 可保存为 warning/raw diagnostics，不作为产品 Task 来源。 |

### OpenClaw Task Snapshot 窗口

OpenClaw session / trajectory 是本机历史日志，不能无限制塞进每分钟上报。Adapter 在生成产品 Task 后必须先按最近活动时间排序，再应用当前窗口：

| 约束 | 默认值 | 说明 |
|---|---:|---|
| 最大 Task 数 | `200` | 保留最近 Task，丢弃更旧 Task。 |
| Task 数组最大 JSON 字节 | `8MiB` | 为后端 `10MB` 请求体上限预留 Device / Runtime / Agent / diagnostics envelope 空间。 |

排序时间使用 `updatedAt`，缺失时依次使用 `lastSeenAt`、`createdAt`。被窗口裁掉的 Task 不进入本次 snapshot，并写 diagnostics warning。已保留 Task 的 `toolCalls.arguments` 保持原样，便于后端排障；需要降低体积时优先丢弃更旧 Task，不改写被保留 Task。

### OpenClaw Task 类型

| `taskType` | 识别规则 | 入库规则 |
|---|---|---|
| `conversation` | `sessionKey` 包含 `:dingtalk:` / `:webchat:`，或存在用户触达渠道 + conversation 证据 | 入库。 |
| `scheduled` | `sessionKey` 包含 `:cron:`，或用户 prompt 以 `[cron:` 开头 | 入库。 |
| manual / background / unknown | explicit、subagent、Multica workspace prompt、无法稳定分类 | P0 不入产品 Task，写 diagnostics。 |

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
| `title` | 用户消息或 cron 标题摘要 | `帮我查一下如果我要查 Seedance...` |
| `description` | 用户消息全文或 cron prompt | `帮我查一下如果我要查 Seedance 模型的调用次数...` |
| `status` | adapter 映射后的 Lorume 状态 | `done` |
| `source.kind` | adapter 固定值 | `openclaw` |
| `source.externalId` | message id 或 trajectory run id | `581a02f8-5fa2-4eb2-bf9d-ae4e68d2ac7a` |
| `channel.kind` | `sessionKey` 或 DingTalk state | `dingtalk` |
| `conversation.title` | sessions index、runtime context、DingTalk target | `日常工作提醒助手` |
| `conversation.externalId` | DingTalk conversation id | `cid+hovty24irglegwfww0kjw==` |
| `creator.name` | runtime context、origin label | `张良` |
| `creator.externalId` | runtime context sender id | `100854680226406967` |
| `toolCalls[]` | session JSONL toolCall/toolResult pair | 见下表。 |
| `raw.openclaw.status` | session/trajectory/tool 原始状态 | `done` / `success` / `error` |
| `raw.openclaw.sessionId` | session file name 或 sessions index | `09fe1f68-d410-4dd6-a79c-14dc33c92ad9` |
| `raw.openclaw.sessionKey` | sessions index / trajectory | `agent:main:dingtalk:group:cid+...` |
| `raw.openclaw.messageId` | user message record id | `581a02f8-5fa2-4eb2-bf9d-ae4e68d2ac7a` |
| `raw.openclaw.trajectoryRunId` | matched trajectory run id | `6602d2a1-7e4a-4c9d-bef0-050b6b2af6d5` |
| `createdAt` | user message timestamp / cron run start | `2026-05-21T09:10:33.514Z` |
| `updatedAt`、`lastSeenAt` | session/trajectory last event | `2026-05-21T09:10:33.577Z` |
| `error` | failed task/tool/trajectory 的用户可读摘要 | `Column 'event_code' cannot be resolved` |

ToolCall 内嵌字段：

| ToolCall 字段 | OpenClaw 来源 | 示例 |
|---|---|---|
| `id` | `toolCall.id` | `exec-c9df226a-a7ab-4f06-bb9d-e36b50ef44ce` |
| `name` | `toolCall.name` | `bash` |
| `status` | 对应 `toolResult.isError` | `failed` |
| `arguments` | `toolCall.arguments` 原样保存 | `{ "command": "python3 scripts/query_logs.py ..." }` |
| `resultPreview` | `toolResult.content` 摘要 | `partial failures: ...` |
| `error` | `isError=true` 时提取 | `Column 'event_code' cannot be resolved` |

`toolCall.arguments` 在数据库 raw/evidence 中原样保存以便排查；后端日志、测试 fixture、文档样例和未来前端 API 展示必须另行处理敏感信息边界。

## 用户可读规则

- DingTalk 群聊缺少可读群名时，显示 `DingTalk 群聊`。
- DingTalk 私聊缺少可读人名时，显示 `DingTalk 私聊`。
- OpenClaw、Slock、Multica、Codex 是 Runtime 来源，不是用户触点渠道；没有用户触点证据的任务省略 `channel` 和 `conversation`。
- 不展示 `cid...`、手机号、open conversation id 或其他不可读外部 id 作为会话名。
- 没有标题或摘要的外部对象不能伪造成任务卡；保留在 diagnostics 或日志中。
- 未关联 Agent 的 OpenClaw execution、内部 heartbeat、恢复任务、approval followup 等系统事件不进入 Runs。
- P0 不展示 tool call 明细；后端可先入库，前端展示另行设计。

## Collector 边界

Collector 只调用：

```sh
lorume collect device-state --json
```

Collector 不调用旧 inventory 或旧工作态命令，不直接读取第三方 Runtime 私有目录、内部 token、内部 API 或平台原始字段。OpenClaw 私有目录读取只能存在于 `lorume` CLI adapter 内部。Adapter 命令、原始证据和 path 细节只存在于 CLI adapter 内部、diagnostics、结构化日志或 DB raw，不进入产品 API / UI 主模型。

## Harness

- `src/cli/lorume-cli.test.ts` 覆盖 `lorume collect device-state`、JSON 错误码和路径安全。
- `src/runtime/device-collector-script.test.ts` 覆盖 collector 只通过 CLI 获取 `device_state`、上报 `/api/device-state-snapshots`、安装/卸载文件完整性。
- `src/runtime/runtime-work-query-api.test.ts` 覆盖 Runs Task 查询响应解析、筛选和分页。
- `e2e/runtime-work-board.spec.ts` 覆盖浏览器级 Runs / Work Board 展示，不依赖旧 latest snapshot 或旧 work item API。
