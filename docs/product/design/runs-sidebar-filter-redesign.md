# Runs Sidebar And Filter Redesign Landing Spec

本文档定义 Console 全局内容间距、Runs 大屏布局、取消泳道前端隐藏、Console Sidebar 组织/账号菜单、Runs 筛选交互的落地边界、前置处理、实施步骤、spec / harness 更新和验收规则。它是本轮 UI 迭代的落地文档；稳定规则落地时必须同步回对应 source of truth。

## Goal

在不推翻当前 React、TypeScript、Tailwind CSS v4、shadcn/ui 和 Taskflow 视觉语言的前提下，完成五项体验调整：

- Console 所有受保护页面统一内容间距规则，减少大屏无效留白，同时保持运营台需要的呼吸感。
- Runs 大屏减少左右空白，让看板按主内容可用宽度计算，而不是被通用居中容器限制。
- Runs 前端不展示 `已取消` 泳道，但后端采集、数据库存储、Task 状态归一化继续保留 `cancelled`。
- 组织切换和个人账号入口改成 shadcn Sidebar 示例风格的侧向菜单交互。
- Runs 筛选改成更接近菜单式筛选的交互，并把时间范围筛选单独放在筛选弹窗外。

## Confirmed Product Decisions

- Runs 可见泳道改为 5 列：`待处理`、`进行中`、`待验收`、`已完成`、`需关注`。
- `已取消` 不再作为 Runs 前端泳道展示，也不计入 Runs 看板可见总数。
- `cancelled` 仍是合法 Task 状态，采集、归一化、入库、后端读取和调试/审计数据都不能删除。
- `需关注` 继续聚合 `failed` 和 `unknown`。
- Runs 不增加状态筛选 tab。状态通过可见泳道表达。
- 时间范围是一级筛选控件，放在搜索条旁边，不再塞进紧凑筛选弹窗。
- 渠道筛选保留且为多选；筛选按钮打开 shadcn `DropdownMenu` 主菜单，`渠道` 作为子菜单项 hover/focus 后在侧边展开，子菜单用 checkbox item 展示 `全部` 和各渠道计数。
- Sidebar 继续使用 shadcn `Sidebar` primitives；不复制静态 HTML，也不替换现有设计系统。
- Console 页面不再统一套用一个 `1440px` 居中最大宽度；页面根据任务类型使用不同宽度档位。
- 间距不能过窄。桌面内容与 viewport 边缘必须保留 24px 左右的视觉安全距离，超宽屏也不能把内容贴到边缘。

## Current Gaps

### Runs Layout

当前 `AppShell` 对所有页面使用 `mx-auto max-w-[1440px]`。Runs 又使用固定 `auto-cols-[235px]` 和 6 个泳道。大屏下主区域被居中最大宽度限制，看板没有充分使用可用空间，左右两侧会显得空。

### Global Page Spacing

当前所有 Console 页面共享同一个内容 wrapper。这个规则对普通页面比较稳，但对 Runs 过窄；如果直接移除所有页面的 max-width，又会让 Organization Settings 这类表单页在超宽屏上变得松散难读。本轮需要把“页面宽度”从单一规则升级成按页面职责分档。

### Cancelled Lane

变更前 `runtimeTaskBoardLaneDefinitions` 固定包含 `已取消`，相关 App test、Playwright 和设计文档也锁定了完整状态列。这与本轮“前端不展示已取消泳道”的新决策冲突；落地后必须统一到五个可见泳道和 `statusScope=board-visible`。

### Sidebar Switchers

当前组织和个人入口已经基于 shadcn `SidebarMenuButton` + `DropdownMenu`，但入口分散且下拉内容比较轻。新规则使用一个截图 4 风格的统一工作区/账号菜单：顶部显示当前工作区，菜单内展示用户身份、工作区列表、 active check、创建工作区占位和退出登录。`App` 目前也固定使用 `auth.session.organizations[0]`，没有 active organization 状态。

### Runs Filters

当前筛选入口是一个 Popover，里面包含 Channel Select 和日期范围 Calendar。这个结构容易出现字体、层级、间距与 Console 其他控件不一致的问题；时间范围也被隐藏在二级弹窗里，不利于高频看板筛选。渠道筛选还需要从单选升级为多选，避免用户只能在一个触点和全部之间切换。

## Design Contract

### Global Console Spacing

Console 页面使用三档内容宽度，而不是单一最大宽度：

| Layout tier | Pages | Width rule | Rationale |
|---|---|---|---|
| `workspace` | Runs | Full available width with guarded page padding | 看板和泳道是主信息面，需要吃满可用宽度 |
| `data-dense` | Runtime Fleet, utility-heavy list pages | `min(100%, 1680px)` centered | 数据目录需要比 1440 更宽，但仍要有构图边界 |
| `standard` | Organization Settings and form/settings pages | `min(100%, 1280px)` centered | 表单、设置和说明内容需要可读行宽，不宜铺满 |

Global spacing tokens:

```css
--console-page-padding-x: clamp(18px, 1.6vw, 30px);
--console-page-padding-y: clamp(18px, 1.7vw, 28px);
--console-content-max-standard: 1280px;
--console-content-max-data: 1680px;
--console-content-max-workspace: none;
```

Rules:

- Desktop page padding should visually land around `24px` to `30px` on common large screens.
- Laptop widths may compress to `18px` to keep content usable.
- Mobile may use `14px` to `16px`, but only below the mobile sidebar breakpoint.
- Avoid `px-0` on protected Console pages. Full-width data pages still need a background margin so surfaces do not touch the viewport edge.
- Page sections should align to the same left edge within a page.
- Top workbar remains full width; page body owns content width and horizontal rhythm.
- Runtime Fleet should use the `data-dense` tier so Device / Runtime / Agent directory surfaces have more room on large screens without becoming edge-to-edge.
- Organization Settings should use the `standard` tier so forms, tables, token controls, and invitation content stay readable.
- Utility drawers keep their own drawer width rules and do not inherit page max-width.
- If a future page is mostly a board, canvas, timeline, or operational workspace, default it to `workspace`; if it is a directory/table, default it to `data-dense`; if it is forms/docs/settings, default it to `standard`.

Recommended AppShell API:

```ts
type ConsoleLayoutTier = "workspace" | "data-dense" | "standard";
```

`AppShell` can derive the tier from `activePage` first:

| Page | Tier |
|---|---|
| `runs` | `workspace` |
| `runtime` | `data-dense` |
| `settings` | `standard` |

This keeps layout ownership centralized and prevents page components from inventing one-off outer margins.

### Runs Width And Spacing

Runs 页面应从通用内容最大宽度中脱离：

- `AppShell` 为 Runs 提供专用 content variant，不使用 `mx-auto max-w-[1440px]`。
- Runs 主体使用完整 `SidebarInset` 剩余宽度。
- 页面内边距继承全局 `--console-page-padding-*`，必要时只在看板内部微调；不要在大屏继续叠加大块居中留白。
- 搜索和筛选条与看板左边缘对齐。
- 看板横向滚动条属于看板区域，不让 `body` 出现横向滚动。
- 窄屏继续横向滚动；桌面宽度足够时 5 个泳道填满可用宽度。
- 泳道宽度下限保持 Taskflow 的紧凑目标，约 `235px`。
- 大屏泳道可以随可用空间增长，但卡片文字仍按现有规则 clamp / wrap，不为了填宽展示更多不稳定字段。

建议实现规则：

```css
--runs-lane-min-width: 235px;
--runs-lane-gap: 14px;
--runs-lane-max-comfort-width: 340px;
```

看板 grid 在可用宽度足够时使用 5 等分；不足时使用 `min-width: calc(5 * var(--runs-lane-min-width) + 4 * var(--runs-lane-gap))` 触发横向滚动。超宽屏如果 5 等分导致单列过宽，应把泳道最大舒适宽度控制在约 `320px` to `340px`，剩余空间留给 board 内部节奏，而不是让卡片变成横向长条。

### Visible Board Statuses

Runs 可见工作集定义为：

```ts
const RUNTIME_TASK_BOARD_VISIBLE_STATUSES = [
  "todo",
  "in_progress",
  "review",
  "done",
  "failed",
  "unknown",
] as const;
```

展示规则：

| 泳道 | 包含状态 |
|---|---|
| `待处理` | `todo` |
| `进行中` | `in_progress` |
| `待验收` | `review` |
| `已完成` | `done` |
| `需关注` | `failed`, `unknown` |

`cancelled` 的规则：

- 不生成可见泳道。
- 不参与 `已显示 X / Y` 的 Y。
- 不参与 top workbar 的 Runs 任务总数。
- 不参与 Channel facet 的可见计数。
- 不从后端模型、数据库、collector、adapter 映射或 API 响应类型中删除。

### Query Contract

为了避免前端只靠“隐藏一列”造成总数和渠道 facet 不一致，Runs 查询应支持看板可见范围过滤。

推荐新增只读查询参数：

```http
GET /api/runtime-tasks?taskType=conversation&statusScope=board-visible
```

规则：

- `statusScope=board-visible` 表示排除 `cancelled`，并只计算当前 Runs 可见工作集。
- 该参数影响 `items`、`total`、`summary.byStatus` 和 `facets.channels`。
- 单个泳道分页仍使用 `status=todo`、`status=in_progress`、`status=review`、`status=done`、`status=failed`、`status=unknown`。
- `需关注` 仍可由前端分别请求 `failed` 和 `unknown` 后合并，也可以后续扩展后端 group 查询；本轮不需要新增 group status。
- 多选渠道使用重复 `channelKind` 参数；后端对 `channelKind` 和兼容 `channelKinds` 去重后过滤，并且 channel facets 不受当前已选渠道收窄。
- 不传 `statusScope` 时，后端保持当前行为，仍可返回 `cancelled`。

如果实现阶段决定不新增 `statusScope`，则必须提供等价的后端过滤方式；不能让 Channel facet 包含用户看不到的 `cancelled` 工作量。

### Filter Interaction

Runs 顶部筛选条结构：

- 搜索框：继续作为主输入，placeholder 保持搜索任务、消息、发起人、Agent 或会话/群组。
- 时间范围按钮：独立显示在搜索框右侧，可显示 `日期范围`、单日、或 `YYYY/MM/DD - YYYY/MM/DD`。
- 筛选按钮：只打开非时间筛选菜单。

时间范围规则：

- 使用 shadcn `Popover` + `Calendar` 的 range 模式。
- 筛选字段继续使用 `Task.updatedAt`，缺失时 fallback 到 `Task.createdAt`。
- 只选择开始日期时，过滤该自然日。
- 选择开始和结束日期时，过滤本地自然日的闭区间。
- 控件必须提供清除动作。

筛选菜单规则：

- 渠道是当前唯一非时间筛选维度。
- 渠道项来自后端 facet，且应用 search/time/statusScope 后的可见工作集。
- 菜单字体、圆角、边框、阴影使用项目 shadcn / Taskflow token；不要出现高对比黑色菜单或系统默认字体。
- 使用 shadcn `DropdownMenuSub` 表达 `渠道 >`。主菜单只展示筛选维度，hover/focus/键盘右箭头打开侧边子菜单。
- 渠道子菜单使用 `DropdownMenuCheckboxItem`，支持多选具体 channel kind；`全部` 是零选择状态，不与具体渠道同时选中。
- UI 生成重复 `channelKind` 查询参数表达多选，例如 `channelKind=dingtalk&channelKind=webchat`；后端可兼容 `channelKinds=dingtalk,webchat`。
- 当前不加入优先级、负责人、创建者、项目、标签筛选，因为这些不是当前 Task 查询模型的一等字段。

### Sidebar Organization And Account Menus

工作区/账号入口：

- 保持在 `SidebarHeader` 中，作为 Console identity。
- 顶部触发器显示当前工作区名称和 compact icon/avatar；不再保留单独的底部个人账号卡片。
- 点击后展开一个截图 4 风格的 shadcn `DropdownMenu` 面板；面板内先展示当前用户 display name / email，再展示 `工作区` 分组。
- 工作区列表来自用户 session 中的 organizations。当前组织高亮并展示 check；多组织时支持切换 active organization，单组织时仍展示当前组织和角色，不伪造其他团队。
- `创建工作区` 当前作为禁用占位展示，直到有明确产品路径、权限和 harness；不得跳转到未实现页面。
- `退出登录` 放在同一菜单底部，使用 destructive text treatment。
- 不把账号菜单做成新的页面或设置中心。

Active organization 状态：

- `App` 不再固定使用 `organizations[0]`。
- 新增 `activeOrganizationId` 状态，从 session organizations 中解析当前组织。
- 默认值为第一个 organization。
- 切换后 Runtime Fleet、Runs、Organization Settings、Operations 和 Notifications 统一使用 active organization。
- 可选把 active organization 存入 `localStorage`，key 需包含 user id，避免不同账号串用。
- 如果 session 刷新后 active organization 不存在，回退到第一个 organization。

Collapsed sidebar：

- 统一工作区/账号入口在 collapsed 状态下只显示 icon/avatar。
- tooltip 继续可用。
- 点击仍打开侧向菜单。

Mobile：

- 移动端 Sidebar 继续走 shadcn Sheet。
- 选择导航或组织后关闭 mobile sidebar。
- 菜单不能超出 viewport；必要时改用 `align="center"` 或 `side="bottom"`。

## Scope

In scope:

- Console 全局页面间距、内容最大宽度和 AppShell layout tier。
- Runs 页面大屏间距和看板宽度规则。
- Runs 5 个可见泳道。
- `cancelled` 后端保留、前端 Runs 隐藏。
- Runs 查询可见范围过滤。
- Runs 搜索、时间范围、渠道筛选交互重构。
- Sidebar 组织切换和个人账号菜单重构。
- Active organization 状态接入现有 Console 数据入口。
- 相关 specs、unit tests、Playwright harness 更新。

Out of scope:

- 删除 `cancelled` Task 状态。
- 清理生产数据库中的 cancelled 数据。
- 新增状态筛选 tab。
- 新增负责人、创建者、优先级、项目、标签筛选。
- 新增未实现的团队创建、团队管理或账号设置页面。
- 替换 shadcn/ui 或复制 shadcn 文档静态示例代码。
- 改动 Runtime Fleet 的信息架构。
- 把所有页面做成无最大宽度的全屏布局。

## File Impact

App shell and sidebar:

- `src/App.tsx`
- `src/components/layout/AppShell.tsx`
- `src/index.css`
- `src/components/ui/sidebar.tsx` only if current primitive lacks required side / RTL behavior
- `src/App.test.tsx`

Runs UI and query client:

- `src/runtime/RuntimeWorkBoardPage.tsx`
- `src/runtime/RuntimeTaskCard.tsx` only if wider lanes expose card overflow
- `src/runtime/runtime-work-query-api.ts`
- `src/runtime/runtime-work-query-api.test.ts`
- `src/runtime/RuntimeTaskCard.test.tsx` only if card visible text rules change

Backend query:

- `src/server/postgres-store.ts`
- `src/server/postgres-store.test.ts`
- `src/server/runtime-http-api.ts`
- `src/server/runtime-http-api-postgres.test.ts`
- `e2e/runtime-backend-api.spec.ts`

E2E:

- `e2e/runtime-work-board.spec.ts`
- `e2e/runtime-fleet.spec.ts` only if active organization affects shared shell assertions

Specs and design docs:

- `docs/product/design/page-patterns.md`
- `docs/product/design/components.md`
- `docs/product/design/layout.md`
- `docs/product/design/review-and-harness.md`
- `docs/product/runtime-task-acceptance-spec.md`
- `docs/product/backend-service-spec.md`
- `docs/product/design/taskflow-ui-redesign.md` should be updated or annotated because it currently says Runs keeps 6 lanes.

## Implementation Steps

### Phase 1: Spec Alignment

Update product specs before implementation:

- `layout.md` adds Console layout tiers and shared page padding tokens.
- `runtime-task-acceptance-spec.md` changes Runs visible lanes from six to five.
- `page-patterns.md` changes Runs lane rule, filter rule, and time range placement.
- `backend-service-spec.md` documents `statusScope=board-visible` or the chosen equivalent query filter.
- `taskflow-ui-redesign.md` is amended so the old 6-lane decision does not conflict with this newer landing spec.

Exit criteria:

- Docs agree that `cancelled` exists in the product model but is not visible in Runs Kanban.
- Docs agree time range is outside the compact filter menu.
- Docs agree Console uses `workspace` / `data-dense` / `standard` layout tiers instead of one global 1440px max-width.

### Phase 2: Backend Visible Scope

Add board-visible filtering to the runtime task query path.

Implementation expectations:

- Parse `statusScope=board-visible` in `runtime-http-api`.
- Apply the scope in `postgres-store` before calculating `items`, `total`, `summary`, and `facets`.
- Preserve existing `status=cancelled` direct query behavior when `statusScope` is not used.
- Ensure `statusScope=board-visible&status=cancelled` returns no visible items or is rejected with a documented 400. Prefer returning no visible items to keep it read-only and simple.

Tests:

- Store test proves cancelled rows are still stored and queryable without `statusScope`.
- Store/API tests prove board-visible totals and channel facets exclude cancelled.

### Phase 3: Runs Five-Lane Board

Update client board definitions and data loading.

Implementation expectations:

- Replace public board lane definitions with five visible lanes.
- Keep `taskStatusLabels.cancelled = "已取消"` for details, tests, and backend responses.
- `boardTaskStatuses()` excludes `cancelled`.
- Overview request includes `statusScope=board-visible`.
- Lane requests include `statusScope=board-visible` plus the lane status.
- `visibleTotal`, `displayedItems`, top workbar task total, and empty states use the board-visible scope.
- Remove `laneSurfaceClass("cancelled")` from active use; the token can remain until later cleanup if removing it would create unrelated churn.

Tests:

- Unit tests expect five lanes.
- App tests and Playwright no longer search for `已取消` lane.
- Tests assert cancelled fixture tasks do not appear as cards.

### Phase 4: Global Width And Spacing

Add page layout tiers in `AppShell`.

Implementation expectations:

- `runs` uses `workspace`.
- `runtime` uses `data-dense`.
- `settings` uses `standard`.
- Content wrappers share global responsive padding tokens.
- Runtime Fleet gets more large-screen room than today but remains centered and bounded.
- Organization Settings keeps a narrower readable measure.
- Runs content wrapper uses full available width and fixed viewport height behavior.
- Board uses five responsive columns with `235px` minimum.
- No body-level horizontal or vertical overflow in the primary desktop view.
- Horizontal scroll appears only on the board area when viewport width is insufficient.

Harness:

- Playwright checks laptop width, 1440 desktop, and wide desktop.
- Assert board left edge aligns with filter bar.
- Assert the fifth lane is visible on wide desktop without large side gutters.
- Assert Runtime Fleet content is wider than the old 1440px cap on wide desktop but still has page edge padding.
- Assert Organization Settings does not stretch form controls across the full viewport.

### Phase 5: Filter Redesign

Move date range outside the compact filter menu and rebuild the filter menu.

Implementation expectations:

- Search remains a text input.
- Date range button sits beside search and opens Calendar range popover.
- Filter button opens channel menu.
- Filter button opens a shadcn menu whose `渠道` item opens a side submenu.
- Channel submenu uses checkbox items and supports selecting multiple channel kinds at once.
- Active channel state is summarized in the main menu item; zero selected channels means `全部`.
- Active filter state is visible without in-app explanatory text.
- Clear actions are available for date range and channel.

Tests:

- Unit/App tests prove repeated `channelKind` URLs, client-side multi-channel filtering, submenu checkbox state, and date range outside the filter menu.
- Store/API tests prove repeated `channelKind` parameters return the union of selected channels.
- Playwright checks the filter menu opens, `渠道` opens the side submenu, checkbox options include backend facet counts, and date range is outside the filter menu.

### Phase 6: Sidebar Menus And Active Organization

Upgrade organization and account menus into one unified workspace/account menu.

Implementation expectations:

- `AppShell` receives `organizations`, `activeOrganization`, `onSwitchOrganization`, `userEmail`, `userDisplayName`, and `onLogout`.
- `App` owns active organization selection.
- Sidebar header renders one workspace/account trigger; the old footer profile card is removed.
- Workspace/account menu lists current user identity, session organizations, active check, disabled create-workspace placeholder, and logout.
- Switching organization updates pages and utility drawers consistently.
- Collapsed and mobile sidebar states remain usable.

Tests:

- App test covers workspace/account menu content.
- App test covers switching active organization when multiple organizations exist.
- App test covers logout from the unified menu.
- Existing mobile sidebar navigation test still passes.

### Phase 7: Verification And Deployment

Run focused checks first, then full project verification:

```sh
npm run typecheck
vitest run src/runtime/runtime-work-query-api.test.ts src/App.test.tsx src/server/postgres-store.test.ts src/server/runtime-http-api-postgres.test.ts
npm run test:e2e
npm run verify
```

If production deployment is requested after implementation:

```sh
npm run smoke:production
```

Authenticated smoke remains optional and requires operator-provided cookie or bearer token.

## Harness Updates

Update assertions to protect behavior rather than pixel-perfect screenshots:

| Harness | Required Coverage |
|---|---|
| `src/runtime/runtime-work-query-api.test.ts` | Five visible lanes, `cancelled` label preserved, board-visible query URL, repeated `channelKind` URL, multi-channel client filtering |
| `src/server/postgres-store.test.ts` | `statusScope=board-visible` excludes cancelled from totals/facets while raw query preserves cancelled; multi-channel filtering returns the union of selected channels |
| `src/server/runtime-http-api-postgres.test.ts` | API returns board-visible summaries/facets and accepts repeated `channelKind` parameters |
| `src/App.test.tsx` | Layout tiers, unified Sidebar workspace/account menu, active org switching, Runs has no cancelled lane, filter menu has `渠道` submenu with checkbox options |
| `e2e/runtime-work-board.spec.ts` | Five lanes, no cancelled lane, large-screen spacing, filter menu `渠道` submenu, date range outside menu |
| `e2e/runtime-fleet.spec.ts` | Data-dense page width, no body overflow, content keeps edge padding |
| `e2e/runtime-backend-api.spec.ts` | Backend visible-scope read path if not fully covered by postgres API tests |

## Acceptance Criteria

- Runs desktop no longer looks centered inside a narrow 1440px island on large screens.
- Runtime Fleet uses a wider data-dense layout than the previous 1440px cap, while keeping balanced page padding.
- Organization Settings remains visually centered and readable; controls do not stretch across ultra-wide screens.
- All protected Console pages share the same page padding rhythm.
- Runs shows exactly five visible lanes: `待处理`、`进行中`、`待验收`、`已完成`、`需关注`.
- Runs never renders `已取消` as a lane.
- `cancelled` tasks are still accepted by collector, normalized, stored, and queryable outside board-visible scope.
- Runs visible totals, top workbar task count, and channel facets exclude `cancelled`.
- Time range filter is visible outside the compact filter menu.
- Filter menu typography, spacing, border, radius, and selected state match the current shadcn / Taskflow Console language.
- Filter menu exposes `渠道 >` as a submenu and supports selecting multiple concrete channels at once.
- Workspace/account menu opens from the Sidebar identity entry, shows user identity plus workspace list, and can switch active organization when multiple organizations exist.
- Logout stays accessible from the unified workspace/account menu.
- Collapsed sidebar, mobile sidebar, utility drawers, and navigation continue to work.
- `npm run verify` passes.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Specs drift back to old Runs lane rules | Keep `runtime-task-acceptance-spec.md`, `page-patterns.md`, and `taskflow-ui-redesign.md` aligned with the five visible lane rule |
| Global spacing becomes too tight | Use `clamp(18px, 1.6vw, 30px)` for desktop padding and verify screenshots before reducing |
| Settings pages become too wide | Keep `standard` tier at about `1280px` and avoid full-width form controls |
| Hiding cancelled makes audit data feel missing | Keep backend/API queryability and do not delete the status; only Runs board-visible scope hides it |
| Channel facet counts disagree with visible cards | Add backend board-visible query scope and keep facets independent from the currently selected channel set |
| Multi-channel filtering accidentally behaves like single-select | Encode repeated `channelKind` params in the client and cover store/API union filtering in tests |
| Wide lanes make cards too loose | Keep text clamp rules and verify at 1440 / 1920 / 2048 widths; tune lane growth only after screenshots |
| Active organization switch affects unrelated pages | Centralize active organization in `App` and pass one value to all organization-scoped surfaces |
| Sidebar side menu breaks mobile | Use shadcn Sidebar mobile Sheet state and responsive menu alignment; cover with Playwright mobile test |

## Product Principles

- Preserve the product object model. UI visibility is not a data deletion rule.
- Use shadcn primitives first; add app-owned wrappers only when repeated product behavior emerges.
- Keep Taskflow visual language: compact, light, low-noise, operational.
- Do not expose unsupported filters, pages, or fields just because the reference screenshot has them.
- Specs, implementation, and harness must move together.
