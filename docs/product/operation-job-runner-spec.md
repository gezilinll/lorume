# Operation And Job Runner Spec

状态：当前规则

本规格定义 Lorume 后端处理异步工作的最小公共底座。Operation 面向用户和产品状态，Job 面向后端执行。当前实现使用 Postgres 驱动的状态机，不引入 Redis、BullMQ、Kafka、Temporal 或独立 worker 服务。

## 目标

- 为通知投递和后续已规格化的长耗时动作提供统一异步状态。
- 用户能在页面内看到异步动作的当前状态、失败原因和需要人工处理的提示。
- 后端能安全 claim、执行、重试和完成 Job，避免重复执行和长时间卡死。
- 业务模块只暴露 Lorume 自己的 Operation 语义，不把某个平台的任务状态直接泄漏给 UI。
- 每次 Operation 状态变化都可以产生通知事件，由 Notification 模块聚合、限流和投递。

## 非目标

- 不做通用工作流引擎。
- 不做跨机器任务调度。
- 不保证长任务一定在一个请求内完成。
- 不把 Operation 当成审计日志；审计仍由业务对象、Approval Request、Collector Ingestion 和 Notification Event 保存。
- 不通过 Job Runner 执行任意命令、聊天消息或外部平台协议模拟。

## 对象模型

### Operation

Operation 是用户可见的一次异步动作。

字段：

- `id`：内部 ID。
- `organizationId`：所属组织。
- `type`：动作类型。当前实现只支持 `notification_delivery`。
- `status`：`queued`、`running`、`succeeded`、`failed`、`unsupported`、`requires_manual_step`、`cancelled`。
- `resourceType` / `resourceId`：主要资源，可为空。
- `targetType` / `targetId`：目标资源，可为空。
- `requestedByUserId`：发起人，可为空。
- `summary`：面向用户的短摘要。
- `errorSummary`：失败摘要，不包含密钥、完整日志或外部平台原始响应。
- `manualInstruction`：需要人工处理时的说明。
- `metadata`：少量结构化上下文，不存储密钥和大文本。
- `createdAt` / `startedAt` / `finishedAt` / `updatedAt`：状态时间。

### Operation Job

Operation Job 是后端可执行的最小任务单元。

字段：

- `id`：内部 ID。
- `operationId`：所属 Operation。
- `organizationId`：所属组织。
- `type`：执行类型，例如 `notification_in_app`、`notification_email`。
- `status`：`queued`、`running`、`succeeded`、`failed`、`unsupported`、`requires_manual_step`、`cancelled`。
- `payload`：执行所需的非敏感参数。
- `attemptCount` / `maxAttempts`：已尝试次数和最大尝试次数。
- `runAfter`：最早执行时间。
- `lockedBy` / `lockedUntil`：runner lease。
- `lastErrorSummary`：最近失败摘要。
- `createdAt` / `startedAt` / `finishedAt` / `updatedAt`：状态时间。

## 状态规则

Operation 状态：

- `queued`：已创建，等待 Job 执行。
- `running`：至少一个 Job 正在执行。
- `succeeded`：所有必要 Job 成功完成。
- `failed`：必要 Job 失败且不可继续重试。
- `unsupported`：目标或 adapter 明确不支持该动作。
- `requires_manual_step`：系统不能确定性完成，需要用户或 owner 手动处理。
- `cancelled`：用户或系统取消。

Job 状态：

- `queued`：可被 runner claim。
- `running`：已被 runner claim 且 lease 未过期。
- `succeeded`：执行成功。
- `failed`：执行失败且达到重试上限，或业务返回不可重试失败。
- `unsupported`：handler 明确返回不支持。
- `requires_manual_step`：handler 能判断下一步必须由用户或 owner 手动补齐。
- `cancelled`：所属 Operation 被取消。

规则：

- Runner claim Job 时必须使用数据库行锁和 lease，避免并发 runner 重复执行同一个 Job。
- `lockedUntil` 过期的 `running` Job 可以被重新 claim。
- 每次执行失败增加 `attemptCount`，未到 `maxAttempts` 时回到 `queued` 并设置 `runAfter`。
- Job handler 必须具备幂等性：重复执行同一个 Job 不应造成重复通知或重复外部状态变更。
- Operation 的最终状态由必要 Job 的结果汇总产生。
- 任一必要 Job 进入 `requires_manual_step` 时，Operation 进入 `requires_manual_step` 并保留 `manualInstruction`。
- Operation 状态变化必须可以创建 Notification Event。

## 当前实现策略

当前 backend 与 runner 同进程运行：

- Backend 启动时创建 Postgres store。
- 业务模块创建 Operation 和 Job 后立即返回当前业务结果。
- Runner 通过短周期轮询 claim due Job。
- 单 ECS、单 backend 阶段可以只跑一个 runner 实例。
- 后续需要多实例时，Postgres lease 和 `FOR UPDATE SKIP LOCKED` 可以支撑横向扩展的最小过渡。

引入外部队列的条件：

- Job 数量或耗时已经影响 API 响应和数据库负载。
- 需要高并发 worker、独立扩缩容、延迟队列或复杂重试策略。
- 需要跨服务事件消费。

在这些条件出现之前，Postgres-backed runner 是正式实现，不是临时方案。

## 通知集成

- Operation 创建、成功、失败、不支持、需要人工处理时创建 Notification Event。
- 同类失败由 Notification Thread 聚合和限流。
- 邮件投递本身也由 Operation Job 执行，失败时记录 Delivery，不递归制造无限通知。

## API 边界

- `GET /api/operations`：按组织、资源、状态查询 Operation。
- `GET /api/operations/:operationId`：读取单个 Operation 和最近 Job 状态。
- 业务 API 可以返回 `operation` 摘要，前端据此展示异步状态。
- Operation API 必须要求用户属于目标组织；不能跨组织读取 Operation 或 Job。
- Job Runner 在 Operation 进入 `succeeded`、`failed`、`unsupported`、`requires_manual_step` 时，按 `requestedByUserId` 创建站内通知；通知失败不能回滚 Operation 状态。
- 设备采集刷新和 Agent Skill 探测不创建 Operation，也不通过 Operation/Job Runner 下发设备命令；设备侧负责采集和上报。

## UI 边界

- 任务中心是 Console 右上角工具抽屉，不进入主导航。
- `/operations` 是任务中心抽屉深链，打开时覆盖在当前 Console 上下文之上。
- 抽屉展示 Operation 概览、列表和选中 Operation 的 Job 详情；关闭后回到打开前的 Console 页面。
- 抽屉不展示后端原始 payload、token、设备密钥或调试字段。

## Harness

- Store 能创建 Operation、入队 Job、claim due Job、完成 Job、失败重试和标记最终 Operation 状态。
- Lease 未过期的 Job 不会被重复 claim。
- Lease 过期的 running Job 可以被重新 claim。
- Job 成功后 Operation 进入 `succeeded`。
- Job 达到重试上限后 Operation 进入 `failed`。
- 不支持 Job 会让 Operation 进入 `unsupported`。
- 需要人工处理的 Job 会让 Operation 进入 `requires_manual_step`，并保留用户可理解的手动处理说明。
- Operation 状态变化能创建通知事件。
## 验收标准

- 异步动作不再靠长请求或前端 loading 假装完成。
- 用户能看到 Operation 当前状态、失败摘要和必要的人工处理提示。
- 后端能在进程重启后继续处理 queued 或 lease 过期的 Job。
- 重复异常不会疯狂发邮件。
- 不引入当前不需要的外部队列或独立 worker 服务。
