# Runtime Codex Adapter Spec

版本：TinySpec v0.1

本文定义 Codex adapter 如何把本机 Codex 只读证据转换为 Lorume 当前 `Device / Runtime / Agent / Task` 模型。Codex adapter 当前默认启用，但只采集 Codex 原生或其他未被平台 adapter 归属的本机会话；没有本机 Codex state 时安静跳过；Slock-owned 和 Multica-owned 的 Codex 会话不作为 Codex Task 入库，避免重复和错误归属。

## 模型边界

Codex 是设备上的执行 Runtime。Codex adapter 的边界是：

- 可以只读读取本机 Codex thread index 和 session JSONL。
- 生成一个 `Runtime.kind="codex"` 的 Runtime。
- 第一版只生成一个本地 Codex Agent。
- 只把 `codex-native-or-other` 线程转成 Task。
- 不把 Slock 或 Multica 编排出来的 Codex 执行会话转成 Codex Task。
- 不用 Codex adapter 替代 Slock adapter；Slock 平台事实仍由 Slock adapter 负责。

关系固定为 `Device -> Runtime -> Agent -> Task`。`Task` 只保存 `agentId`；需要 Runtime 或 Device 信息时通过后端 join 或 BFF composition 查询。

## 数据源

| 用途 | Codex 来源 | 规则 |
|---|---|---|
| Thread index | `~/.codex/state_5.sqlite` 的 `threads` 表 | 用于 thread id、session path、source、model、cwd、first user message、git metadata、token count、created/updated time。 |
| Session evidence | `~/.codex/sessions/**/*.jsonl` | 只读取 thread index 引用的 JSONL，用于 `task_complete`、第一条用户消息 fallback、最新 assistant 回复和 status 观察。 |

第一版不使用：

| 来源 | 原因 |
|---|---|
| `~/.codex/logs_2.sqlite` | 日志流噪声大，不是当前 Task 主事实。 |
| `~/.codex/cache`、`plugins`、`vendor_imports`、`.tmp` | 缓存、插件、vendor 或临时文件，不是 Task 事实。 |
| `~/Library/Application Support/Codex` | Electron / app cache，不作为第一版稳定采集源。 |
| `~/Documents/Codex` | profiling 中为空，不能作为稳定 runtime 来源。 |
| `~/.slock/agents/*` | 只能作为 Slock ownership 对照，不作为 Codex Task 来源。 |

Adapter 必须只读读取本机文件。不得写 Codex 文件，不得调用会修改 Codex 会话、状态、配置或远端服务的接口。`~/.codex/state_5.sqlite` 不存在表示当前设备没有可采集 Codex state，adapter 不生成对象且不报错；文件存在但不可读或无法解析才是采集链路 error。

## 归属分类

Codex adapter 必须先分类，再映射 Task。

| 分类 | 确定性证据 | 处理 |
|---|---|---|
| `slock-owned` | `cwd` 包含 `/.slock/agents/`，或 JSONL 中出现 `mcp__chat__*` / Slock target 证据 | 不生成 Codex Task；输出 `codex_owned_by_slock_ignored`。 |
| `multica-owned` | `cwd` 包含 `/multica_workspaces/` | 不生成 Codex Task；输出 `codex_owned_by_multica_ignored`。 |
| `codex-native-or-other` | 没有 Slock 或 Multica ownership 证据 | 满足必填字段时生成 Codex Task。 |
| `unknown-owned` | thread row 或 JSONL 无法读取到足够信息完成分类 | 不生成 Task；输出 `codex_session_unclassified_ignored`。 |

Codex session 是 Slock-owned 只说明 Codex 执行了来自 Slock 的工作，不说明 Codex 拥有 Slock 的 channel、assignee、status 或 agent reply。Slock adapter 继续拥有 `channel.kind="slock"`、Slock conversation title、assignee、Slock status 和 Slock agent reply 富化。

## Runtime 和 Agent 映射

| Lorume 字段 | Codex 来源 | 规则 |
|---|---|---|
| `Runtime.id` | device id + kind | `${deviceId}:runtime:codex`。 |
| `Runtime.kind` | 固定已实现 runtime | `codex`。 |
| `Runtime.name` | 固定用户可读名称 | `Codex`。 |
| `Runtime.collectionStatus` | adapter 读取结果 | Codex state 可读为 `online`；adapter 级读取或解析失败才为 `error`。 |
| `Agent.id` | runtime id | `${runtimeId}:agent:codex:local`。 |
| `Agent.runtimeId` | Codex runtime id | 指向 `${deviceId}:runtime:codex`。 |
| `Agent.name` | 固定用户可读名称 | `Codex`。 |
| `Agent.collectionStatus` | adapter 读取结果 | 与本轮 Codex state 采集结果一致。 |

Codex adapter 不使用 Slock Agent 名称作为 Codex Agent 名称，例如 PMO、CPO、AjisGTD 等都不是 Codex adapter 的 Agent。

Runtime 不包含 `endpoint`、`capabilities` 或 `sourceRefs`。Agent 不包含 `origin`、`sourceRefs` 或 `load`。

## Task 映射

Codex adapter 使用 `adapter.kind="codex"` 和 `raw.codex`。Codex Task 不新增 `runtimeId`、`run`、`execution`、`toolCalls`、`title`、`description` 或 `lastSeenAt`。

| Lorume Task 字段 | Codex 来源 | 规则 |
|---|---|---|
| `id` | `threads.id` | `${agentId}:task:${sanitizeId(thread.id)}`。 |
| `agentId` | 本地 Codex Agent | `${runtimeId}:agent:codex:local`。 |
| `taskType` | Codex 会话 | 当前统一为 `conversation`。 |
| `status` | JSONL status evidence | 第一版只输出 `done` 或 `unknown`。 |
| `userMessage` | `threads.first_user_message`，fallback 为 JSONL 第一条用户消息 | 必须有非空用户可读内容才生成 Task。 |
| `agentReply` | 最新 assistant/agent 文本或 `task_complete.last_agent_message` | 可为空；不得合成。 |
| `adapter.kind` | adapter 固定值 | `codex`。 |
| `channel` | 无 | 第一版省略；不要把 Runtime、adapter 或 cwd 当成 channel。 |
| `conversation` | 无 | 第一版省略；不要用 thread title 重新引入 Task title。 |
| `raw.codex.threadId` | `threads.id` | 原样保留安全 id 证据。 |
| `raw.codex.rolloutPath` | `threads.rollout_path` | 仅作排障证据，不作为用户标题。 |
| `raw.codex.source` | `threads.source` | 例如 `vscode` 或 `exec`。 |
| `raw.codex.model` | `threads.model` | 例如 `gpt-5.4`。 |
| `raw.codex.cwdKind` | ownership 分类 | 对入库 Task 固定为 `codex-native-or-other`。 |
| `raw.codex.tokensUsed` | `threads.tokens_used` | 数值型用量证据。 |
| `raw.codex.git` | thread git fields | 只保存 thread index 已有的 branch、sha、origin 等安全标量。 |
| `createdAt` | `threads.created_at` | 转成 ISO 时间。 |
| `updatedAt` | `threads.updated_at` 或最新 JSONL 事件时间 | 使用源系统业务时间，不用 collector 采集时间覆盖。 |

如果缺少可读 `userMessage`，Task 不入库，并输出 `codex_missing_user_message` warning。

## 状态映射

第一版只实现确定性状态：

| Codex 证据 | Lorume `TaskStatus` |
|---|---|
| 该 thread 的 JSONL 出现 `task_complete` | `done` |
| 缺少 `task_complete`，且没有已经进入 spec/harness 的终态证据 | `unknown` |

明确不映射：

| 候选状态 | 当前决策 |
|---|---|
| `in_progress` | 本地历史 JSONL 缺少 `task_complete` 不能证明任务当前仍在运行。 |
| `failed` | 等稳定 Codex 错误终态证据经过 profiling、spec 和 harness 后再引入。 |
| `cancelled` | 等稳定取消/中断终态证据经过 profiling、spec 和 harness 后再引入。 |
| `review` / `todo` | 不是 Codex 原生 session 状态。 |

实现过程中可以并行观察 `unknown` 样本是否存在稳定 `turn_aborted`、显式取消、错误终态或进程崩溃证据。观察结果只能先进入 `.lorume/` 临时报告或下一版 spec 草案；不得在没有用户 review、spec 和失败测试前直接扩展状态映射。

## Diagnostics

Codex adapter 只输出结构化聚合 diagnostics，不输出逐条原始 JSONL 或原始错误串。

| code | severity | 规则 |
|---|---|---|
| `codex_owned_by_slock_ignored` | `info` | Thread 为 Slock-owned，被跳过以避免重复 Task。 |
| `codex_owned_by_multica_ignored` | `info` | Thread 为 Multica-owned，被跳过。 |
| `codex_session_unclassified_ignored` | `warning` | Thread 无法安全分类，被跳过。 |
| `codex_missing_user_message` | `warning` | Native candidate 缺少可读 `userMessage`，被跳过。 |
| `codex_unknown_task_status` | `warning` | Native Task 入库但 status 只能判断为 `unknown`。 |
| `codex_session_jsonl_unreadable` | `error` | Thread 指向的 JSONL 不可读。 |
| `codex_state_unreadable` | `error` | 已存在的 `state_5.sqlite` 不可读或无法解析。 |

`info` 和 `warning` 不改变 Device / Runtime / Agent 的 `collectionStatus`。只有 Codex 采集链路失败、结构校验失败或入库失败才把对应采集状态置为 `error`。

## 数据量与上报

Codex adapter 不上传完整 JSONL，不上传 tool calls，不上传 tool arguments，不上传 token、凭据、完整 process args 或完整原始 payload。

上报范围：

- 一个 Codex Runtime。
- 一个本地 Codex Agent。
- 所有符合产品标准的 `codex-native-or-other` Task。
- `raw.codex` 安全标量证据。

Adapter 不按固定数量或固定字节数静默截断符合标准的 Task。体积控制由 collector Task batch、Task hash 和本地 ACK cache 负责。

## Harness

Codex adapter 必须保持以下最小 harness：

- CLI adapter test：使用脱敏 fixture 覆盖 Runtime/Agent 生成、native done Task、native unknown Task、Slock-owned 跳过、Multica-owned 跳过、missing user message 跳过、diagnostics 和 `raw.codex`。
- Collector test：覆盖 Codex Task 通过 `/api/device-task-batches` 分批上报，metadata snapshot 不携带 Task payload。
- Backend/API test：覆盖 `adapter.kind="codex"`、`raw.codex` 安全标量持久化和 Task 查询响应中没有 `runtimeId`、`toolCalls`、`title`、`description`。
- Repo check：要求本文档和 device registration spec 同步存在。
- 真实设备观察者验证：只读运行 Codex adapter，确认 native / Slock-owned / Multica-owned 分类数量，并把 `unknown` status 的潜在改善点先记录为观察证据。

真实设备 profiling 原始文件、个人机器路径、JSONL 原文、token、消息正文和临时 checklist 不提交。只有规则、脱敏 fixture 和可执行 harness 可以进入仓库。
