# OpenClaw Agent Dashboard Frontend TinySpec

版本：v0.1

## Summary

Agent 看板是 Lorume Console 的数据密集型运行观察页。一期只展示后端已落地的 OpenClaw `main` Agent Analysis 报告，不新增后端实体，不直接访问 collector，不把真实设备执行作为前端测试条件。

页面目标是让操作者看到某个 Agent 在一个报告周期内的日常运转：运行概览、运行表现、任务类型、用户反馈、典型案例、风险与建议，并能手动创建一次新的分析 Operation。

## Scope

一期支持：

- `Runtime.kind=openclaw`
- OpenClaw 外部 Agent id 为 `main`
- 报告类型 `promptKind=daily_operation_review`
- 报告版本 `promptVersion=openclaw-agent-operation-analysis-v2`

一期不支持：

- Slock、Codex 或其他 Runtime 的 Agent 分析展示。
- 多 Agent 横向对比。
- 全局满意度、NPS、评分、情绪判断或跨 Agent 对比。
- 前端新增 chart 依赖。
- 前端直接读取数据库、调用 collector 或执行真实设备命令。

## Route And Entry Points

- Console route：`/agent-dashboard`
- URL 参数：`agentId=<Lorume Agent id>`
- 主导航文案：`Agent 看板`
- Runtime Fleet Agent 行级操作：`查看看板`，跳转 `/agent-dashboard?agentId=...`
- Runtime Fleet Agent 详情操作：`查看看板`，跳转 `/agent-dashboard?agentId=...`

未知 Console 路由仍默认回到 Runtime Fleet。`/operations` 和 `/notifications` 继续作为工具抽屉路由，不因 Agent 看板新增而变为主导航页面。

## Data Sources

页面只使用组织作用域 HTTP API：

- `GET /api/runtime-fleet`
- `GET /api/agent-analysis-reports?agentId=&limit=`
- `GET /api/agent-analysis-reports/:reportId`
- `POST /api/agent-analysis-runs`
- `GET /api/operations/:operationId`

前端 API adapter 必须归一化后端响应，并过滤不属于页面契约的字段。即使后端异常返回 `satisfactionScore`、`nps`、raw prompt、nonce 或类似字段，页面也不得展示。任务类型内的 `satisfaction.level` 只能转译为用户可读的反馈倾向文案。

## Layout

页面使用当前 Console Surface：

- 左侧主导航。
- 顶部 Workbar 显示页面标题、当前 Device / Runtime / Agent / period 摘要和刷新动作。
- 主体为数据密集双栏布局：左侧报告主体，右侧报告历史和分析任务状态。
- 不渲染 hero、营销文案、大型装饰背景或重复页面标题块。

## Content Rules

`运行概览` 必须展示：

- Task 总数。
- 状态分布。
- `failed`、`unknown` 数。
- 最近活跃时间。
- `done` / `failed` 任务的平均、p50、p90 耗时。
- 当前报告周期。

报告主体必须拆成面向管理者的模块：

- `运行表现`：工作量、完成情况、耗时表现、异常模式。
- `任务类型`：类型名称、数量估计、反馈倾向、说明。
- `用户反馈`：按任务类型展示 `positive | mixed | negative | unknown` 的中文含义：`偏正向`、`分化明显`、`偏负向`、`证据不足`。
- `典型案例`：案例标题、结果、反馈信号、原因、证据 id。
- `风险与建议`：风险和建议分块展示。
- `历史报告`：只展示日期、状态或任务量，不突出 Operation ID。

文案边界：

- 不展示 `系统计算`、`硬指标`、`Agent 自评`、`边界说明`、`置信度` 等内部实现或校验措辞。
- 不展示 raw backend payload、prompt 全文、nonce、device token、session token、cookie、OpenClaw secret 或调试字段。
- 不展示全局满意度、NPS、评分或用户情绪判断。
- 非 OpenClaw 或非 `main` Agent 明确显示 `不支持分析`，不误导为数据缺失。
- 空报告状态显示 `暂无分析报告`，并保留可支持目标的手动 `运行分析` 动作。

## Interactions

筛选与选择：

- 默认从 URL 读取 `agentId`。
- 无 URL 参数时优先选择最近报告的 Agent；没有报告时选择当前组织中第一个支持的 OpenClaw `main` Agent。
- Agent 选择器展示 Device / Runtime / Agent 组合。
- 报告历史用于切换 period/report。

运行分析：

- `运行分析` 调用 `POST /api/agent-analysis-runs`。
- 成功后显示 toast，并在页面侧栏轮询对应 Operation。
- 全局进度仍可在 Operations 抽屉查看。
- running、succeeded、failed、unsupported 等状态必须可见。
- 创建失败显示 toast，不创建本地假报告。

## Harness

单元与组件测试：

- `src/agent-dashboard/agent-dashboard-query.test.ts`
  - 报告列表/详情归一化。
  - 无效 payload 回退。
  - run API 返回 Operation / Job。
  - v2 报告归一化，旧 v1 报告可降级展示且不暴露 raw payload。
- `src/agent-dashboard/AgentDashboardPage.test.tsx`
  - 展示运行概览、运行表现、任务类型、用户反馈、典型案例、风险与建议、报告历史。
  - 页面不出现 `系统计算`、`硬指标`、`Agent 自评`、`边界说明`、`置信度`。
  - 覆盖空报告、unsupported target、running/succeeded/failed、创建请求失败。
- `src/App.test.tsx`
  - 主导航出现 `Agent 看板`。
  - `/agent-dashboard` 可打开。
  - Runtime Fleet `查看看板` 带 `agentId` 跳转。

E2E：

- `e2e/agent-dashboard.spec.ts`
  - 只验证前端导航、响应式和接口展示。
  - 不触发真实 collector。
  - 检查 1440px、1185px、390px 下无 body 横向溢出。
  - 检查页面不出现技术字段、评分/NPS、raw payload，不把 Operation 抽屉变成主导航页面。

推荐命令：

- 开发迭代：`npm run check:quick`
- 完整前端验收：`npm run check:e2e`
- 文档/spec mapping：`npm run check:repo`
