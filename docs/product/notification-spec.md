# Notification Spec

状态：当前规则

本规格定义 Lorume 的公共通知机制。通知用于把需要关注、需要处理、已完成或已失败的异步事件传达给相关人，覆盖设备采集、组织邀请和系统健康等当前模块。

## 目标

- 为 [Operation And Job Runner Spec](./operation-job-runner-spec.md) 驱动的异步操作提供统一通知模型，避免每个业务模块各自实现通知。
- 支持页面内通知和邮件通知。
- 通知相关 owner、申请人、设备负责人、Agent 负责人和组织管理员。
- 对重复异常做聚合、限流、升级和恢复通知，避免线上异常时疯狂重复发送。
- 通知内容只包含摘要和跳转入口，不泄露密钥、完整日志或外部平台私有返回体。

## 非目标

- 不做聊天式通知流。
- 不接管外部平台消息路由。
- 不把通知当成审计日志。审计由对应业务对象和 operation / sync job / approval event 保存。
- 不为每个业务模块维护一套独立通知表。
- 不保证邮件一定送达；邮件投递失败必须记录并可排查。

## 对象模型

### Notification Event

Notification Event 是业务模块发出的原始通知事件。

字段：

- `id`：内部 ID。
- `organizationId`：所属组织。
- `eventType`：事件类型。
- `severity`：`info`、`warning`、`critical`。
- `sourceModule`：`runtime`、`auth`、`system`。
- `resourceType` / `resourceId`：关联资源。
- `operationId`：关联 Operation，可为空。
- `actorUserId`：触发人，可为空。
- `recipientUserIds`：候选接收人。
- `title`：短标题。
- `summary`：摘要。
- `dedupeKey`：聚合键。
- `createdAt`：创建时间。

### Notification Thread

Notification Thread 是同类事件的聚合结果。页面内通知列表优先展示 Thread，而不是每条原始 Event。

字段：

- `id`：内部 ID。
- `organizationId`：所属组织。
- `dedupeKey`：聚合键。
- `status`：`open`、`resolved`、`muted`。
- `severity`：当前最高严重级别。
- `eventType`：主事件类型。
- `resourceType` / `resourceId`：关联资源。
- `title`：聚合标题。
- `latestSummary`：最近一次摘要。
- `occurrenceCount`：发生次数。
- `firstOccurredAt` / `lastOccurredAt`：首次和最近发生时间。
- `resolvedAt`：恢复或关闭时间，可为空。
- `cooldownUntil`：邮件冷却时间，可为空。

### Notification Delivery

Notification Delivery 是一次实际投递记录。

字段：

- `id`：内部 ID。
- `threadId`：关联 Thread。
- `eventId`：触发投递的 Event。
- `channel`：`in_app`、`email`。
- `recipientUserId`：接收人。
- `recipientAddress`：邮件地址或应用内用户 ID。
- `status`：`pending`、`sent`、`failed`、`skipped`。
- `readAt`：站内通知被接收人读取的时间；仅 `in_app` 投递需要。
- `skipReason`：跳过原因，可为空。
- `sentAt`：发送时间，可为空。
- `errorSummary`：失败摘要，可为空。

### Notification Preference

Notification Preference 是用户或组织对通知的基础偏好。

字段：

- `id`：内部 ID。
- `organizationId`：所属组织。
- `userId`：用户，可为空；为空表示组织默认。
- `eventType`：事件类型或通配。
- `channel`：`in_app`、`email`。
- `enabled`：是否启用。
- `severityThreshold`：最低严重级别。

## 聚合与限流

重复事件必须聚合，不能每次都发独立邮件。

默认聚合键：

```text
organizationId + sourceModule + resourceType + resourceId + eventType + severity
```

Collector 上报失败使用稳定聚合键：

```text
runtime:collector:${deviceId}:${snapshotType}:failed
```

规则：

- 相同 `dedupeKey` 的事件进入同一个 Notification Thread。
- In-app 通知记录所有重要状态变化，但列表层优先展示聚合后的 Thread。
- Email 只在状态转换、首次出现、达到升级阈值、恢复成功或需要人处理时发送。
- 同一 Thread 在 `cooldownUntil` 之前不重复发普通 email。
- `critical` 可以缩短冷却，但仍必须有最小间隔。
- 恢复事件会关闭对应 Thread，并发送一条恢复通知。
- 被用户 mute 的 Thread 不再发 email，但仍保留 in-app 状态。

建议默认冷却：

- `info`：不主动发 email，除非是迁移完成、邀请接受等明确结果。
- `warning`：同一 Thread `30min` 内最多一封 email。
- `critical`：同一 Thread `10min` 内最多一封 email。

升级规则：

- 连续失败但未跨阈值：只更新 Thread，不重复发 email。
- 达到阈值：例如设备离线或采集失败持续 `10min`、`30min`、`1h`，发升级通知。
- 恢复成功：发恢复通知，关闭 Thread。

## 事件范围

### Runtime / Device

事件：

- Device 离线。
- Device 恢复在线。
- Collector 版本过旧。
- Device-state 上报失败。
- Task 采集或映射异常。
- 数据同步完成。
- 数据同步失败。
- Runtime 探测异常。

接收人：

- Device owner。
- Runtime owner。
- 组织 owner / admin，限采集失败、持续失败或 critical 场景。

普通数据同步完成默认只进入 in-app，不主动发 email。当前没有后端触发的设备刷新、采集下发或探测完成通知。

最近同步时间过旧可以作为排查线索进入诊断视图或后续运维报告，但不单独生成“采集过期”通知；只有采集失败、adapter 异常、payload 结构不可用或持续失败升级才进入通知模型。

Collector 上报失败进入统一通知模型：

- Device-state 上报失败生成 `collector_device_state_failed`。
- 事件由认证后的 device token 解析组织，接收人为该组织 active owner / admin。
- 事件关联 `resourceType=device` 和上报 payload 中的 `deviceId`；如果 payload 无法解析设备 ID，使用 `unknown` 作为可排查占位。
- 摘要只包含设备 ID、采集类型和截断后的错误摘要，不包含原始 payload、token、外部平台返回体或调试-only 字段。

### Approval

事件：

- 有待审批。
- 审批通过。
- 审批拒绝。
- 审批超时。

接收人：

- 申请人。
- 审批人。
- 资源 owner。

### Auth / Organization

事件：

- 邀请发送。
- 邀请接受。
- 成员加入。
- 成员角色变化。

接收人：

- 邀请人。
- 被邀请人。
- 组织 owner / admin。

### System

事件：

- 邮件 provider 发送失败。
- Backend readyz 异常。
- 数据库连接异常。
- Collector 控制面异常。

接收人：

- 组织 owner / admin。
- 系统维护者。

## 投递渠道

### In-app

In-app 是默认渠道。

规则：

- 所有重要事件都写入 Notification Event。
- 通知中心是 Console 右上角工具抽屉，不进入主导航。
- 通知中心展示 Thread 列表和详情；Thread 列表优先展示聚合结果，不展示原始 Event 流。
- Thread 的未读/已读状态按当前用户的 `in_app` Delivery `readAt` 计算。
- 用户选择一条未读 Thread 时，前端调用标记已读 API 并在抽屉内更新状态。
- 资源详情页可以展示与该资源相关的 Thread。
- 用户可以标记已读、关闭已恢复 Thread 或 mute 某个 Thread。

### Email

Email 只用于需要人处理、失败、异常、完成确认和审核类事件。

规则：

- 邮件标题必须包含资源类型和事件摘要。
- 邮件正文只放摘要、状态、时间和跳转链接。
- 不放 token、验证码、完整日志、Skill 文件内容、脚本正文或外部平台私有返回体。
- 发送失败必须记录 Notification Delivery。
- 邮件发送失败本身可以产生 system notification，但必须限流。

## API 边界

Notification API：

- `GET /api/notifications`：读取当前用户可见 Notification Thread。
- `GET /api/notifications/:threadId`：读取 Thread 和 Delivery 详情。
- `POST /api/notifications/:threadId/read`：把当前用户在该 Thread 下的站内投递标记为已读。
- 静音和通知偏好要等对应 UI、权限和 harness 一起出现后再开放。

业务模块内部 API：

- `createNotificationEvent`：创建事件并执行聚合。
- `scheduleNotificationDelivery`：根据偏好、严重级别、冷却和聚合规则创建投递任务。
- `markNotificationResolved`：关闭 Thread 并发送恢复通知。

Operation 集成 API：

- `notifyOperationStatusChanged`：Operation 进入 `succeeded`、`failed`、`unsupported`、`requires_manual_step` 时创建事件。
- `notifyOperationRequiresApproval`：业务动作转为 Approval Request 时通知审批人和申请人。

## Harness

聚合与限流：

- 相同 dedupeKey 的事件进入同一 Thread。
- 同一 Thread 冷却期内不会重复发 email。
- critical 事件遵循最小间隔。
- 恢复事件会关闭 Thread 并发送一次恢复通知。
- muted Thread 不发 email。

投递：

- in-app 记录所有重要事件。
- email 只发送给匹配接收人和偏好的用户。
- email 内容不包含 token、完整日志、Skill 文件内容或脚本正文。
- 邮件 provider 失败会记录 Delivery 失败，并产生限流后的 system notification。

业务集成：

- 设备上报的 Agent Skill probe snapshot 失败或不支持事件进入 runtime notification；重复失败按 dedupe/cooldown 聚合。当前不创建后端触发式探测请求通知。
- 认证后的 Collector `device_state` 上报失败会聚合为 runtime warning 通知，并按 `30min` 邮件冷却投递给组织 owner / admin。
- Device 离线持续发生时只按阈值升级通知。
- Approval 待处理会通知审批人，通过或拒绝会通知申请人。
- 通知工具抽屉能展示未读/已读状态；选择未读 Thread 后只标记当前用户的站内投递为已读。

## 验收标准

- 所有异步业务事件都能进入统一 Notification 模型。
- 页面内通知能显示状态变化和异常摘要。
- 邮件通知只覆盖需要处理、失败、完成确认、审核和持续异常。
- 重复异常不会疯狂重复发送邮件。
- 恢复成功会关闭异常通知并发送恢复摘要。
- 通知内容不泄露密钥、完整日志、Skill 文件内容或外部平台私有返回体。
