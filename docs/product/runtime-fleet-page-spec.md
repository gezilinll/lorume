# Runtime Fleet Page Spec

版本：TinySpec v1.0

Runtime Fleet 是 Lorume 用来查看设备、runtime、agent 和 channel binding 的当前管理页面。页面正式数据来自 backend 查询 API；fixture 只作为开发期离线预览和测试辅助，不作为生产或正式本地验收路径。

## 分层原则

Runtime Fleet 必须区分“数据从哪里采集”和“产品上归属哪一层”。

- Device 管设备连接和承载状态：在线、最近心跳、连接方式、collector 状态、已注册 Runtime。Device 不拥有任务、会话或泳道。
- Runtime 管执行环境状态：是否可用、是否离线、是否闲置、是否有工作负载。Runtime 可以是采集任务和会话数据的入口，但不拥有项目管理级任务或泳道。
- Agent 管用户可理解的工作状态：待处理、处理中、待验收、已关闭、需关注，以及发起人、承接 Agent、会话/群组、消息摘要和执行结果。
- Adapter 负责把 OpenClaw、Multica、Slock 等平台差异转成 Lorume 统一模型。UI 不能直接解释平台原始字段，也不能把平台状态原样暴露成产品语义。

## 目标

- 展示已注册设备的基本状态、hostname、OS、最后同步时间和连接状态。
- 展示设备上的 runtime，包括 OpenClaw、Codex、Claude Code、Slock、Multica 等 `kind`。
- 展示 runtime 下的 managed agents、归属 runtime、统一状态、channel binding 和最近同步。
- 支持按关键词、runtime kind、同步时间过滤。Runtime kind 候选项必须从当前 snapshot 中真实存在的 runtime 动态生成；不展示当前设备没有上报的 Runtime 类型。
- Runtime Fleet 不提供 Channel 筛选，避免把 Slock、Multica、OpenClaw、Codex 等 Runtime / 平台入口误当成触达渠道。
- 点击设备、runtime 或 agent 后，在右侧详情面板查看身份信息、连接状态、归属关系、已注册 Runtime 和关联渠道。
- Agent 列表行提供目标 Agent 本地 Skill 探测入口；该能力只展示探测状态、Skill root / entry path、Markdown 文件名和非 Markdown 文件名，不提供编辑、导入、分配、同步或迁移。
- Runtime Fleet 不暴露手动远端刷新入口；页面只展示后端已有数据、collector 定时上报和自动轮询后的结果。
- 页面自动轮询最新 snapshot，使运行资产管理视图持续更新。

## 非目标

- 不做中控 Agent。
- 不创建、编辑或删除外部平台 Agent。
- 不接管聊天入口。
- 不展示所有网络接口、所有 MAC 地址或所有内部进程端口。
- 不把 capabilities、sourceRefs 等原始 adapter 字段作为页面主信息。
- 不做集中式 Skill Registry、组织 Skill 资产库、Skill 编辑器、Skill 下发或 Agent 迁移入口。

## 数据源

页面使用 `GET /api/runtime-fleet` 读取正式后端查询结果，并用 `GET /api/runtime-work-items` 的标准化工作项辅助推导 Runtime 与 Agent 展示状态。页面也可以读取 `GET /api/devices/:deviceId/collection-health` 作为状态折叠输入，但不渲染独立采集健康区块。Agent 行级 Skill 元数据只读取 `GET /api/agents/:agentId/skill-probe` 返回的最新已存储只读快照；P0 页面不请求目标设备执行本地探测。Runtime Fleet 做状态推导时必须读取完整 work-item 分页，不能只用第一页 500 条推断 Runtime / Agent 忙闲。没有后端数据或本地 backend 不可用时，页面只在非 production 模式允许使用明确标识的 `fixtures/runtime/collector-snapshot.sample.json` 做开发期离线预览；production 构建必须展示明确错误和空状态，不回退 fixture，不读取兼容期 latest API。组件不直接理解 OpenClaw、Slock 或 Multica 的内部结构，只消费标准化后的 Runtime Fleet view model。

`GET /api/runtime-fleet` 可能返回多个设备。页面不能把 `devices[0]` 当作全局主设备再混合全部 Runtime / Agent；必须按真实 `deviceId -> runtimeId -> agentId` 归属渲染、筛选和展示详情。开发期本地数据库中的 fixture 历史数据可以清理，但产品能力必须保留多设备展示。

页面挂载后每 30 秒读取一次后端查询结果，并显示页面自己的上次刷新时间。自动刷新只读取后端已有数据，不下发远端 `inventory.refresh` 命令；远端采集由 collector 启动、周期刷新或本机显式命令触发。当前 Runtime Fleet 页面不渲染请求设备刷新按钮、不展示命令轮询状态，也不把远端刷新包装成用户可用功能。

## 统一语义

Adapter 必须把外部平台差异转换成 Lorume 自己的数据语义，UI 不直接解释平台原始字段。

`lastSeenAt` 表示 Lorume 最近一次从对应对象采集到状态的时间。Device、Runtime、Agent 都使用同一字段语义，页面以本地化时间展示，不展示原始 UTC ISO 字符串。

Collector 必须上报足够的对象同步时间。开发期历史数据如果缺字段，优先清理数据和 fixture；Runtime Fleet 不为了旧数据长期堆兼容逻辑。

Runtime 可用性继续使用 `RuntimeHealthStatus = online/degraded/offline/unknown`。Runtime 运行状态使用独立的 `RuntimeOperatingStatus`：

- `offline`：Runtime 不可达或长时间未同步。
- `working`：Runtime 可达，且至少一个关联 Agent 有 `processing` 工作项；如果没有工作项但有 `queued/running` execution，也可以作为工作中证据。Slock 以 task board `in_progress` 作为工作中依据，不要求实时 activity。
- `idle`：Runtime 可达，adapter 能观测该 Runtime 的工作项或执行态，且当前没有处理中工作项或运行中 execution。
- `unknown`：仅作为内部 adapter 原始归一状态；Runtime Fleet 展示层必须折叠为 `异常`，不能直接向用户展示 `未知`。

Runtime 运行状态必须从 Lorume 统一 WorkStage / ExecutionStatus 推导，不直接把 Slock / OpenClaw / Multica 原始状态暴露到页面。

Runtime Fleet 展示层只向用户暴露统一对象状态：

- `working` / `工作中`：对象可识别且有可接收或正在处理工作的证据。Device 正常展示为 `工作中`，不展示 `正常`。
- `idle` / `空闲`：对象可识别，当前没有处理中工作或运行中 execution。
- `offline` / `离线`：对象明确离线或不可达。
- `exception` / `异常`：采集失败、adapter 异常、数据结构不可用、对象 degraded，或内部状态不能可靠判断。

采集成功且数据完整度符合当前 adapter 预期时，不因“距离上次同步超过某个时间”自动标记异常；页面展示最近同步时间，用户可以据此判断数据新鲜度。采集失败、adapter 异常或结构校验失败时，不猜测对象状态，相关 Device / Runtime / Agent 统一展示为 `异常`，详细原因进入后端 ingestion 记录、结构化日志和通知/运维诊断链路。

Agent 状态：

- `active`：当前有任务或会话正在执行；Slock 可用 task board assignee + `in_progress` 作为 Agent 正在承接任务的证据。
- `idle`：当前无任务或会话执行，但 Agent 可识别且可用；当某平台 work-state 已可观测且没有匹配该 Agent 的处理中工作项时，可以展示为空闲。
- `inactive`：已停用或不可接收任务。
- `degraded`：可识别但状态异常。
- `unknown`：仅作为内部 adapter 原始归一状态；Runtime Fleet 展示层必须折叠为 `异常`，不能直接向用户展示 `未知`。

Agent 状态必须优先使用 Lorume WorkItem / Execution 证据，再回退到 inventory 中的 adapter 原始归一结果。Slock task board 中的 assignee 名称可以用于匹配 ManagedAgent；如果 task board 中的 `agentId` 只是 workspace / token 归属而不是任务承接者，不能用它把所有任务错误归到同一个 Agent。

Agent 工作负载统计：

- `activeTasks`：当前执行中的任务数。
- `queuedTasks`：当前排队任务数。
- `activeSessions`：当前活跃会话数。
- `historicalSessions`：历史或累计会话数。
- `maxConcurrency`：配置的并发容量。

这些统计属于 Agent 工作负载或诊断信息。Runtime 可以用它们汇总出粗粒度忙闲状态，但 Runtime 详情不展示任务/会话明细，避免把 Agent 工作管理越层放到 Runtime。

Adapter 拿不到某个非关键字段时不伪造数据，页面展示 `不支持采集` 或不展示该区块。用于状态判定的关键结构不可用时，状态折叠为 `异常`，并通过规范化错误码与用户可读 message 记录到后端和日志。

## 页面字段策略

Device：

- 列表/卡片展示设备名、连接状态、最近同步、Runtime 数、Agent 数。
- 详情展示 `概览`、`基础信息`、`网络`、`运行资产`、`已注册 Runtime`。
- 详情中的最近同步只在概览中展示一次，连接状态不重复展示同一时间。
- 可以展示 CLI 已上报的局域网 IP、公网 IP 来源和用户名；不展示所有网络接口、所有 MAC 或未经采集确认的猜测信息。
- 不展示独立采集健康区块。inventory / work-state 采集失败、adapter 异常和结构不可用折叠到 Device / Runtime / Agent 自身状态；最近同步时间用于表达数据新鲜度。

Runtime：

- 列表展示 Runtime 名称、Runtime 类型、所属设备、状态、最近同步。
- 详情展示 `概览`、`基础信息`、`状态`、`归属关系` 和 CLI 已上报的本地路径。
- 运行入口不作为页面主信息，避免在没有明确用户价值前增加实体。
- Runtime 不展示项目管理级任务、会话泳道或 Agent 工作负载明细。
- capabilities 只作为诊断信息保留，不作为表格主列。

Agent：

- 列表展示 Agent 名称、归属 Runtime、关联渠道、状态、最近同步。
- 归属 Runtime 使用 Runtime 列表中的同一展示名，不用 UUID 作为主识别。
- 列表提供 `Skill` 行级操作，用户不需要先打开详情才能查看目标 Agent 的 Skill metadata。
- 详情展示 `概览`、`基础信息`、`状态`、`归属关系`、`关联渠道`、`运行统计` 和 CLI 已上报的本地路径。这里的 `运行统计` 仅指 Agent 工作负载统计，不应用于 Runtime 详情。
- Skill 探测 UI 未探测时展示空状态；请求中展示已请求/等待状态；成功时展示 Skill root、entry、Markdown 文件名和非 Markdown 文件名；失败、unsupported、device disconnected 时展示用户可理解的摘要。
- 非 Markdown / 二进制文件只展示 metadata，不作为链接、下载、预览或编辑入口。
- sourceRefs 只用于生成平台标识或外部链接，不直接以 `source: id` 的原始形式展示。

## 验收标准

- 主导航可以进入 Runtime Fleet 页面。
- 页面顶部显示设备、Runtime、Agent 数量，不展示独立异常统计卡。
- 页面不显示采集健康区块；采集失败或结构不可用时，对应对象状态显示为 `异常`。
- Runtime 筛选项来自当前 snapshot；fixture 只有 OpenClaw、Slock 时，筛选项只显示 `全部 / OpenClaw / Slock`。
- 用户可以搜索 `tester` 并只看到相关 Agent。
- Runtime Fleet 工具栏不展示 Channel 或可用性筛选；用户需要收敛某个 Agent 时使用搜索、Runtime 或同步时间筛选。
- 用户可以点击 Agent 行并在详情面板看到归属 Runtime、归属设备、关联渠道和运行统计。
- 用户可以从 Agent 行级 `Skill` 操作查看目标本地 Skill 元数据、未探测/请求中/成功/不支持/失败/设备未连接状态，并且非 Markdown 文件不渲染为链接。
- 用户滚动页面时，左侧导航保持固定，个人入口保持在左下角；右侧详情 inspector 在桌面宽度保持可视和可读。
- 用户在桌面宽度滚动到 Agent 表格后点击行，详情面板仍停留在可视区域内。
- 用户可以点击 Runtime 行并在详情面板看到所属设备、Agent 数量和统一状态，不出现运行入口或任务/会话统计区块。
- 当后端工作项查询中 Slock Runtime 关联的 Agent 有 `in_progress` 工作项时，Runtime 运行状态显示为 `工作中`。
- 当 Runtime 相关工作项落在后端查询第二页或更后面时，Runtime Fleet 仍能读取后续 cursor 页面并正确推导运行状态。
- 当后端工作项查询中 Slock task board 的 assignee 指向某个 Agent 且任务为 `in_progress` 时，该 Agent 状态显示为 `工作中`；已可观测但无处理中任务时显示为空闲。
- 用户可以点击 Device 卡片并在详情面板看到身份信息、连接状态和已注册 Runtime。
- 当后端已有最新 snapshot 时，页面展示后端设备名称而不是 fixture 设备名称。
- Production 构建下，后端查询失败时页面展示后端错误状态，不展示 fixture 设备、Runtime 或 Agent。
- 页面自动读取后端查询结果，并展示上次刷新时间。
- Runtime Fleet 页面不展示 `请求设备刷新` 按钮，不暴露远端刷新命令轮询状态。
- OpenClaw 历史 session 数展示为历史会话，不展示为活跃会话。
- Slock 仅能识别 workspace 且缺少可靠工作态证据时，Agent 状态折叠为 `异常`，不伪装成工作中。
- 页面在桌面和移动宽度下不横向溢出。
