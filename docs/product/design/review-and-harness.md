# Review And Harness

UI 工作完成前必须同时做视觉 Review、CSS/token Review 和相关 harness。自动检测是证据，不是结论。

## Review Order

1. 确认页面属于哪个 surface。
2. 检查是否遵循对应页面规范。
3. 检查 token 和共享组件是否被复用。
4. 截图 Review 桌面、窄屏和关键状态。
5. 检查长文本、空数据、错误、loading、未登录、权限不足。
6. 运行相关 harness。

## Screenshot Review

截图时至少关注：

- 是否有未实现入口。
- 是否出现横向滚动。
- 标题、按钮、badge、详情面板是否溢出。
- Console 页面是否只有一条顶部 workbar，且页面主体没有重复标题、解释文案或指标卡。
- 字体分工是否符合 Sans / Mono 规则。
- Icon 是否统一。
- 装饰是否遮挡内容、造成视觉疲劳，或让页面显得空洞。
- Console 页面是否仍然能快速扫描。
- 任务/通知是否从右上角入口打开窄抽屉，而不是变成主导航页面。

## CSS And Token Review

检查：

- 是否存在新增硬编码色值。
- 是否绕过 shadcn primitives 写了临时按钮、输入框、badge。
- 是否新增了一次性 box-shadow、border、font-family、radius。
- 是否在业务页面复制 logo 或 icon SVG。
- 是否破坏 Brand、Identity、Console 之间的 token 一致性。
- Console 页面是否仍保持简洁、高级、专业、统一；必要时把最终截图与 Datadog Infrastructure List、Grafana Fleet Management、Linear 列表/详情等优秀竞品的信息密度和视觉噪声做对照，但不照搬其品牌风格。
- Runs 看板截图需要额外对照 Taskflow Kanban 参考：泳道宽度、卡片密度、左侧状态条、状态色使用和空态是否看起来像生产工具，而不是 demo 卡片堆叠。详情弹窗要对照 Cards/Detail surface 是否把任务信息、用户消息、Agent 回复三块排清楚。

## Harness Responsibility

- 文档和规范变化运行 `npm run check:repo`。
- 共享 UI primitive、token、路由或页面交互变化运行 `npm run check:quick`。
- 布局、响应式、看板、筛选、登录/邀请可视路径变化运行对应 Playwright harness。
- 全量交付前运行 `npm run verify`。

当前视觉 harness 锚点：

- `src/components/ui/shadcn-smoke.test.tsx` 锁定 shadcn primitives 可导入、主题变量可用、`cn` 工具可组合类名。
- `src/App.test.tsx` 锁定首页入口、已实现 Console 导航、不可用入口隐藏、Runtime Fleet / Runs / 组织设置的核心交互，以及任务/通知工具抽屉的打开、关闭和路由边界。
- `src/console/ConsoleUtilityDrawer.test.tsx`、`src/settings/OrganizationSettingsPage.test.tsx` 锁定任务/通知抽屉、已读状态、组织邀请入口的 API 读取、权限显示和详情查看。
- `e2e/runtime-fleet.spec.ts` 锁定 Runtime Fleet 的详情面板、顶部 workbar 刷新、响应式和无 Channel 筛选。
- `e2e/runtime-fleet.spec.ts` 锁定 Runtime Fleet 左侧导航固定、详情 inspector 桌面滚动可见、多设备归属正确、Agent 行级 Skill 入口、无采集健康堆叠区块、无可用性筛选，以及页面不展示 debug-only 字段。
- `e2e/runtime-work-board.spec.ts` 锁定 Runs 的多选 Channel 子菜单 / 时间筛选、五个可见泳道状态收敛、`已取消` 泳道隐藏、看板高度、泳道宽度、Sidebar 宽度、页面不出现 body-level 垂直滚动、泳道内部滚动、任务卡 Taskflow hover 深度、详情弹窗居中与内部 3D 卡片层、详情三块结构、卡片不显示调试内容、监听缺口不变成任务卡。
视觉变更不一定都需要新增截图回归工具，但必须能被以上至少一种 harness 或一次明确截图 Review 覆盖。

## Issue Classification

发现问题后判断应沉淀到哪里：

- Context: agent 操作规则，写入 [../../../AGENTS.md](../../../AGENTS.md)。
- Design spec: 视觉、交互、内容或页面规则，写入本目录。
- Product spec: 数据、行为、对象边界，写入对应 `docs/product/*-spec.md`。
- Harness: 可执行质量保障，写入 unit、component 或 e2e。

## Root-Cause Rule

修复 UI 问题时要确认位置合理：

- 跨页面共性问题优先修 token 或共享组件。
- 单页面布局问题修页面 pattern 或页面实现。
- 平台适配问题修 adapter，不让 React 组件推断平台语义。
- 数据质量问题修后端、collector 或 normalized model，不用前端文案掩盖。
- Harness 应验证当前正确设计是否存在，例如统一状态、行级 Skill 操作和无未实现入口；不要长期保留“过去误放过的文案不存在”这类历史脚印测试。
