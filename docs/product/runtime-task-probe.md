# Runtime Task Probe Spec

版本：TinySpec v1.0

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
  title: string;
  description?: string;
  status: TaskStatus;
  source?: { externalId?: string };
  channel?: {
    kind: "dingtalk" | "telegram" | "slack" | "slock" | "multica" | "openclaw" | "other";
    name?: string;
    externalId?: string;
  };
  conversation?: {
    title?: string;
    externalId?: string;
    lastActivityAt?: string;
  };
  assignee?: { name?: string };
  creator?: { name?: string };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
}
```

不允许在 Task 上保存 `runtimeId`、`run`、`execution` 或 `lastRun`。任务的当前状态只看 `Task.status`。

## 状态映射

| 外部证据 | Lorume `TaskStatus` |
|---|---|
| queued, pending, todo | `todo` |
| running, active, in_progress | `in_progress` |
| review, in_review | `review` |
| succeeded, completed, done | `done` |
| blocked, waiting_on_dependency | `blocked` |
| failed, error | `failed` |
| cancelled, canceled | `cancelled` |
| 不能可靠判断 | `unknown` |

Runtime 和 Agent 不保存 working / idle。页面需要“进行中数量”“失败数量”时，从 Task 聚合。

## OpenClaw Adapter

OpenClaw adapter 输出当前 `DeviceStateSnapshot` 内的 `runtimes`、`agents`、`tasks`。

| Lorume 对象 | OpenClaw 来源 | 规则 |
|---|---|---|
| Runtime | OpenClaw config、health/status 只读结果 | 生成一个 OpenClaw Runtime，kind 为 `openclaw`。 |
| Agent | OpenClaw agent 配置或 health/status 中可识别的 agent | 每个真实 agent 生成一个 Lorume Agent。 |
| Task | OpenClaw task、message、trajectory 或 requester session 证据 | 只生成能明确归属到 Agent 的任务；无法唯一归属时跳过并写 diagnostic warning。 |

稳定 ID：

| 对象 | 规则 |
|---|---|
| Runtime | `${deviceId}:runtime:openclaw` |
| Agent | `${runtimeId}:agent:${openClawAgentId}` |
| Task | `${agentId}:task:${externalTaskId}` |

## 用户可读规则

- DingTalk 群聊缺少可读群名时，显示 `DingTalk 群聊`。
- DingTalk 私聊缺少可读人名时，显示 `DingTalk 私聊`。
- 不展示 `cid...`、手机号、open conversation id 或其他不可读外部 id 作为会话名。
- 没有标题或摘要的外部对象不能伪造成任务卡；保留在 diagnostics 或日志中。
- 未关联 Agent 的 OpenClaw execution、内部 heartbeat、恢复任务、approval followup 等系统事件不进入 Runs。

## Collector 边界

Collector 只调用：

```sh
lorume collect device-state --json
```

Collector 不调用旧 inventory 或旧工作态命令，不直接读取第三方 Runtime 私有目录、内部 token、内部 API 或平台原始字段。Adapter 命令、原始证据和 path 细节只存在于 CLI adapter 内部、diagnostics、结构化日志或 DB raw，不进入产品 API / UI 主模型。

## Harness

- `src/cli/lorume-cli.test.ts` 覆盖 `lorume collect device-state`、旧采集命令 unsupported、JSON 错误码和路径安全。
- `src/runtime/device-collector-script.test.ts` 覆盖 collector 只通过 CLI 获取 `device_state`、上报 `/api/device-state-snapshots`、安装/卸载文件完整性和旧 once mode 拒绝。
- `src/runtime/runtime-work-query-api.test.ts` 覆盖 Runs Task 查询响应解析、筛选和分页。
- `e2e/runtime-work-board.spec.ts` 覆盖浏览器级 Runs / Work Board 展示，不依赖旧 latest snapshot 或旧 work item API。
