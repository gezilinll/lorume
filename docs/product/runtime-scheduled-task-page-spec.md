# Runtime Scheduled Task Page Spec

版本：TinySpec v0.1

本文定义 Lorume 定时任务页面、定时定义采集、执行历史聚合和验收边界。它延续当前 `Device / Runtime / Agent / Task` 模型，不新增面向用户的一等 ScheduledTask 对象；页面展示的是后端从 Runtime 定时定义 snapshot 和 `Task(taskType="scheduled")` 执行记录聚合出的查询视图。

## 当前数据筛查结论

真实设备 `gezilinll-claw` 与生产库只读筛查得到当前事实：

| Runtime | 定时任务证据 | 当前结论 |
|---|---|---|
| OpenClaw | `openclaw cron list --json --all`、`openclaw cron runs --id <id>`、cron session / trajectory Task | 可以识别定时定义、启用状态、cron 表达式、时区、下次运行、最近运行和多次执行结果。 |
| Codex | 当前 adapter 只产出 `conversation` Task | 当前没有可采集的 Codex scheduled Task。 |
| Slock | 当前 adapter 只产出 channel / task history；spec 要求只有稳定 schedule 证据后才能映射 `scheduled` | 当前不能把 Slock 会话或工作区文件名推断为定时任务。 |

生产库当前已有 OpenClaw `scheduled` Task 执行记录，但 Task raw 只包含 run 级证据，例如 `sessionId`、`sessionKey`、`status`、`statusSource` 和 `trajectoryRunId`。这些记录足够按 cron id 聚合历史执行结果，但不足以稳定展示 cron 表达式、启用状态或下次运行时间。定时定义必须通过 Runtime adapter 额外只读探测。

OpenClaw 真实 cron 定义可提供的字段包括：

- `id`
- `agentId`
- `name`
- `description`
- `enabled`
- `schedule.kind`
- `schedule.expr`
- `schedule.tz`
- `schedule.staggerMs`
- `state.nextRunAtMs`
- `state.lastRunAtMs`
- `state.lastRunStatus`
- `state.lastDurationMs`
- `state.consecutiveErrors`
- `state.consecutiveSkipped`
- `delivery.mode`
- `delivery.channel`

## 产品目标

定时任务页面必须让用户看清：

- 当前组织内有哪些已知定时任务。
- 每个定时任务属于哪个 Runtime 和 Agent。
- 定时规则是什么，是否启用，下次运行时间是否可知。
- 最近一次执行是什么状态，最近执行时间和耗时是多少。
- 同一个定时任务的多次执行结果如何分布，失败时是否有用户可读摘要。

页面入口应是 Console 左侧独立导航项，建议路由为 `/scheduled-tasks`，导航文案为 `定时任务`。Runs 继续只展示 `taskType=conversation` 会话任务，不混入 scheduled Task。

## 非目标

- 不创建、编辑、启用、禁用、删除定时任务。
- 不通过 backend 触发 Runtime 命令，也不通过 WebSocket 主动要求设备执行探测。
- 不把 Slock/Codex 的非稳定线索推断成定时任务。
- 不新增 first-class Conversation、Execution、Schedule、Run 或 SourceRef 产品对象。
- 不展示 raw session id、trajectory id、外部 open conversation id、平台命令、token、payload 原文或私有路径。
- 不把历史执行记录自行改写成当前状态；所有展示必须来自 collector 上报和后端聚合。

## 前置准备

落地前需要先完成这些准备，避免 UI 先行后返工：

1. **定时定义 snapshot 契约**：新增内部 Runtime schedule probe snapshot，保存 Runtime 上报的定时定义。它是 backend 存储和 BFF 聚合输入，不是产品一等对象。
2. **OpenClaw 命令契约**：OpenClaw adapter 只读调用 `openclaw cron list --json --all`。`openclaw cron runs --id <id>` 可用于真实数据分析和后续增强，但第一版执行历史优先使用已经入库的 `Task(taskType="scheduled")`，避免重复采集 run 结果。
3. **稳定聚合 key**：优先使用 OpenClaw cron id。现有历史执行可从 `raw.openclaw.sessionKey` 的 `agent:<agentId>:cron:<cronId>:run:<runId>` 解析出 `cronId`；新数据应直接在 raw 中保留 `scheduleId`。
4. **脱敏 fixture**：从真实 OpenClaw 数据抽取脱敏 fixture，覆盖启用、禁用、下次运行未知、最近失败、历史定义缺失但执行存在、多次执行混合状态等场景。
5. **组织隔离**：所有定时定义 snapshot、聚合 API 和执行历史查询必须和 Runtime Fleet / Runs 一样按 `devices.organization_id` 过滤。
6. **验收 harness**：先补 normalization、adapter、store/API、组件和 Playwright 的最小测试，再实现页面。

## 数据模型边界

### 继续使用 Task 表示一次执行

每次定时任务运行结果仍然是一个 Lorume `Task`：

```ts
interface Task {
  id: string;
  agentId: string;
  taskType: "scheduled";
  status: TaskStatus;
  userMessage?: string;
  agentReply?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  raw?: {
    openclaw?: {
      scheduleId?: string;
      scheduleName?: string;
      sessionId?: string;
      sessionKey?: string;
      trajectoryRunId?: string;
      status?: string;
      statusSource?: "session" | "trajectory" | "tasks_list";
    };
  };
}
```

`scheduleId` 和 `scheduleName` 是 adapter 归一化后的 raw evidence，方便后端聚合；它们不改变 Task 产品模型，也不引入 `task.runtimeId`。

### 新增内部 Runtime Schedule Probe Snapshot

建议新增与 Runtime Skill probe 类似的内部 snapshot：

```ts
interface RuntimeScheduleProbeSnapshot {
  deviceId: string;
  runtimeId: string;
  runtimeKind: string;
  status: "unknown" | "succeeded" | "unsupported" | "failed";
  observedAt?: string | null;
  schedules: RuntimeScheduleDefinition[];
  summary: {
    total: number;
    enabledCount: number;
    disabledCount: number;
    agentCount: number;
  };
  errorSummary?: string;
}

interface RuntimeScheduleDefinition {
  key: string;
  sourceId: string;
  name: string;
  agentIds: string[];
  enabled: boolean;
  expression?: string;
  timezone?: string;
  nextRunAt?: string;
  lastRunAt?: string;
}
```

这是第一阶段的最小抽象：只保留页面判断和执行历史聚合确实需要的字段。OpenClaw 的 `description`、`schedule.kind`、`staggerMs`、`lastRunStatus`、`lastDurationMs`、`consecutiveErrors`、`consecutiveSkipped` 和 `delivery` 当前保留在 adapter 原始证据和未来增强空间里，不进入抽象层和第一版 API。

## Backend 查询视图

后端对前端暴露的是聚合后的定时任务视图：

```ts
interface ScheduledTaskGroup {
  scheduleKey: string;
  sourceId: string;
  name: string;
  deviceId: string;
  runtimeId: string;
  runtimeKind: string;
  runtimeName: string;
  agentIds: string[];
  agentNames: string[];
  enabled: boolean;
  expression?: string;
  timezone?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  executionCount: number;
  latestExecutionAt?: string;
  latestStatus?: TaskStatus;
  summary: {
    byStatus: TaskStatusCounts;
  };
}
```

如果历史执行存在但当前 Runtime schedule probe 找不到对应定时定义，后端仍按执行记录生成 group：`expression`、`timezone`、`nextRunAt` 缺省，`enabled` 当前按历史可见任务保守设为 `true`。前端页面阶段可在不改变 Task 模型的前提下再增加 `definitionStatus`，但必须配套 spec 和 harness。

## API 契约

建议新增：

- `POST /api/runtime-schedule-probe-snapshots`
  - collector 使用 device token 上报 Runtime 定时定义 snapshot。
  - 后端只存储归一化 schedules、summary、status 和 observedAt。
- `GET /api/runtime-scheduled-tasks`
  - 返回当前组织可见的 `ScheduledTaskGroup` 列表。
  - 第一阶段返回完整组织列表和 summary，不做分页。
  - 前端页面阶段如需 `search`、`runtimeId`、`agentId`、`enabled`、`status`、`startAt`、`endAt`、`limit`、`cursor`，必须先补 store/API/component harness。
- `GET /api/runtime-scheduled-tasks/:scheduleKey/executions`
  - 返回同一 `scheduleKey` 下最近执行记录。
  - 第一阶段支持 `limit`，默认最多返回最近 200 条，硬上限 500。
  - `status`、时间范围和 cursor 分页留到前端页面阶段实现。

后端聚合顺序：

1. 读取组织内 Runtime / Agent。
2. 读取最新 Runtime schedule probe snapshot。
3. 查询组织内 `taskType="scheduled"` 且未 tombstone 的 Task。
4. 用 `scheduleId` 或解析后的 cron id 聚合同一组执行。
5. 将 schedule definition 与 execution group 合并，生成 `ScheduledTaskGroup`。
6. 对只有 definition、暂时没有执行记录的定时任务也展示；`totalExecutions=0`。
7. 对只有历史执行、当前没有 definition 的定时任务也展示；`definitionStatus="missing"`。

## OpenClaw 映射规则

OpenClaw adapter 第一版新增定时定义探测：

```sh
openclaw cron list --json --all
```

字段映射：

| OpenClaw 字段 | Lorume 字段 |
|---|---|
| `id` | `sourceId` / `raw.openclaw.scheduleId` |
| `agentId` | Lorume Agent id 的 suffix 来源 |
| `name` | `name` |
| `enabled` | `enabled` |
| `schedule.expr` / `cron` / `expression` | `expression` |
| `schedule.tz` / `timezone` | `timezone` |
| `state.nextRunAtMs` | `nextRunAt` |
| `state.lastRunAtMs` | `lastRunAt` |

Task 执行映射保持在 OpenClaw Task adapter 中：

- `sessionKey` 包含 `:cron:` 或 prompt 以 `[cron:` 开头时，`taskType="scheduled"`。
- 解析 `sessionKey` 得到 `scheduleId` 和 `agentId`。
- 运行 prompt 作为 `userMessage`。
- `agentReply` 使用现有 trajectory assistant text / summary 规则。
- `error` 使用现有 failed task/tool/trajectory 的用户可读摘要。
- stale running trajectory 仍按 OpenClaw adapter spec 映射为 `unknown`。

## Codex 和 Slock 规则

Codex 当前不产出 scheduled Task。只有出现稳定、可复现的 Codex 本地 schedule 数据源后，才能新增 Codex scheduled 映射、fixture 和 harness。

Slock 当前不产出 scheduled Task。Slock 是 channel / orchestration / Agent profile source；不能从频道消息、workspace 文件名、报告文件或 Codex session 归属推断定时任务。只有 Slock daemon/API 明确提供 schedule definition、agent ownership 和 execution history 时，才能新增 Slock scheduled 映射。

## 页面设计

### 列表页

定时任务页面第一屏使用 Console 现有信息密度和 Taskflow 设计语言：

- 顶部标题：`定时任务`，副信息展示总数、启用数、失败/需关注数。
- 工具栏：搜索、筛选、刷新时间。筛选交互复用 Runs / Skill 仓库的级联筛选菜单。
- 主区域：表格或列表，不使用 Kanban 泳道。

推荐列：

| 列 | 内容 |
|---|---|
| 定时任务 | 名称、短描述、启用/禁用/需关注 pill。 |
| Runtime | 归属 Runtime。 |
| Agent | 归属 Agent；多 Agent 时显示摘要。 |
| 计划 | cron 表达式、时区、用户可读周期摘要。 |
| 下次运行 | `nextRunAt`；未知时显示 `暂无下次运行`。 |
| 最近状态 | 最近一次 scheduled Task 执行状态。 |
| 最近时间 | 最近一次 scheduled Task 执行时间，可用相对时间展示。 |
| 执行次数 | 当前聚合组内已采集到的执行记录数量。 |

筛选项：

- Runtime
- Agent
- 启用状态：启用、停用、未知
- 最近状态：正常、失败、运行中、未知
- 时间范围：按最近执行时间过滤

### 详情卡片

点击定时任务打开右侧详情卡片：

1. 标题区：定时任务名、启用状态、最近状态。
2. 计划信息：cron 表达式、时区、下次运行、投递方式。
3. 归属关系：Runtime、Agent。
4. 最近状态：最近执行时间、耗时、连续失败数、连续跳过数。
5. 执行历史：按时间倒序展示多次执行结果。

执行历史每行展示：

- 执行时间
- 状态
- 耗时
- 结果摘要：优先 `agentReply`，失败时优先 `error`
- 可展开查看该次 Task 的用户消息和 Agent 回复

## 状态展示规则

页面级状态从 definition 和 executions 共同派生：

| UI 状态 | 规则 |
|---|---|
| `启用` | definition 存在且 `enabled=true`。 |
| `停用` | definition 存在且 `enabled=false`。 |
| `运行中` | 最新 execution `Task.status="in_progress"`。 |
| `需关注` | 最新 execution 为 `failed` / `unknown`，或 definition `consecutiveErrors > 0`。 |
| `正常` | definition 启用且最近执行成功，或有下次运行且无失败证据。 |
| `历史` | 有 execution group，但 `definitionStatus="missing"`。 |

`cancelled` 执行保留在详情历史里，不作为列表默认隐藏条件。定时任务页面不是 Runs 看板，不套用 Runs 的 `statusScope=board-visible`。

## 验收规则

- Runs 页面仍只请求和展示 `taskType=conversation`。
- 定时任务页面只消费 schedule 聚合 API，不直接读 latest snapshot。
- OpenClaw schedule definition 采集失败时，已有 scheduled Task 执行历史仍可展示为历史任务。
- 有 definition 但还没有 execution 的定时任务必须可见。
- 有 execution 但 definition 已缺失的定时任务必须可见，并显示计划未知。
- Slock/Codex 不能因为存在频道消息、报告文件或本地 session 就显示为定时任务。
- 多次执行历史必须来自真实 Task rows 或明确的 Runtime cron run history；不得合成执行结果。
- 页面不得展示 raw external id、命令、token、payload 原文或私有 adapter evidence。

## Harness

阶段 1 后端/collector 链路必须覆盖：

- `src/runtime/runtime-schedule-probe.test.ts`
  - 归一化 OpenClaw schedule definition、启用/停用、Agent 归属、cron 表达式、时区、nextRunAt / lastRunAt 缺省。
- `src/server/postgres-store.test.ts`
  - Runtime schedule probe snapshot 持久化、最新 snapshot 读取、scheduled Task 聚合、执行历史查询。
- `src/server/runtime-http-api-postgres.test.ts`
  - `POST /api/runtime-schedule-probe-snapshots`、`GET /api/runtime-scheduled-tasks` 和 executions 查询。
- `src/cli/lorume-cli.test.ts`
  - OpenClaw cron list fixture 归一化，Slock/Codex 不产出 scheduled definition。
- `src/runtime/device-collector-script.test.ts`
  - collector 将 Runtime schedule probe snapshot 与 metadata snapshot、Task batch 分流上报。

完整前端页面落地时再补：

- `src/runtime/runtime-scheduled-task-query.test.ts`
  - 解析 scheduled API 响应、分页、空态和字段缺省。
- `src/runtime/RuntimeScheduledTasksPage.test.tsx`
  - 列表、筛选、详情卡片和执行历史。
- `e2e/runtime-scheduled-tasks.spec.ts`
  - 浏览器级路由、筛选、详情打开、响应式布局。

实现后再把该页面加入 `npm run check:e2e` 覆盖范围。生产 smoke 只在提供认证 cookie/bearer 时检查已鉴权 read path，不写生产数据。

## 落地步骤

### 阶段 1：后端和 collector 数据链路

1. 新增 Runtime schedule probe normalization 类型和测试。
2. OpenClaw adapter 接入 `openclaw cron list --json --all`，只输出归一化 schedule definition。
3. Task adapter 给 OpenClaw scheduled Task raw 补 `scheduleId` / `scheduleName`。
4. 新增 schedule probe snapshot 存储表和 store 方法。
5. 新增 collector 上报接口 `POST /api/runtime-schedule-probe-snapshots`。
6. 新增 scheduled group 聚合查询和 executions 查询。
7. 本地 harness 通过后，部署到服务端，验证真实设备上报 schedule definitions 和已有执行历史能合并。

### 阶段 2：前端页面

1. 新增 frontend API adapter。
2. 新增 `/scheduled-tasks` protected route 和左侧导航入口。
3. 实现列表、筛选、空态、错误态和加载态。
4. 实现详情卡片与执行历史。
5. Playwright 验证桌面和窄屏布局。

### 阶段 3：真实链路验收

1. 远端部署 backend / frontend / collector。
2. 等待 collector 完成一轮 device-state、schedule probe 和 task batch 上报。
3. 只读查询生产库，确认 schedule definitions、scheduled Task groups、execution counts 和页面展示一致。
4. 对 OpenClaw 5 分钟巡检、每日任务、禁用历史任务、失败任务各抽检一条。
5. 确认 Slock/Codex 没有无证据 scheduled rows。
