# Taskflow UI Redesign Landing Spec

本文档定义 Lorume Console 迁移到 Taskflow HTML Demo 视觉语言的落地边界、前置处理、实施步骤、spec / harness 更新和验收规则。它不是临时团队排期，也不替代各页面 TinySpec；实施时应把稳定规则同步回对应 source of truth。

## Goal

把 Lorume 当前 Console 改造成以 Taskflow 为参考的浅色、紧凑、低噪声运营台：

- 顶部栏、左侧栏、页面配色、面板、按钮、表格、活动列表、Kanban 卡片遵循 `/Users/linbinghe/Downloads/taskflow-html 2` 的视觉规则。
- 内容仍使用 Lorume 的真实 `Device / Runtime / Agent / Task` 数据。
- 技术栈继续使用 React、TypeScript、Tailwind CSS v4、shadcn/ui 和 lucide-react。
- 不引入模拟项目中的假业务模块，不暴露未实现能力。

## Confirmed Product Decisions

- Runs 早期曾把所有产品状态都展示为泳道；后续规则见 [runs-sidebar-filter-redesign.md](runs-sidebar-filter-redesign.md)，当前 Runs 可见泳道为 5 列，`cancelled` 后端保留但前端不展示 `已取消` 泳道。
- `kanban.html` 用于定义 Runs 的看板布局、列样式、卡片密度、标签、左侧状态条和顶部工具节奏。
- `users.html` 的“成员目录”用于 Runtime Fleet 的 Runtime 与 Agent 模块。
- `users.html` 的“团队动态”用于 Runtime Fleet 的 Device 模块。
- 顶栏和左栏照抄 Taskflow 的布局规则、配色和样式，但导航项只保留 Lorume 已实现入口。
- Runtime Fleet 的 `最近活跃` 是 Task 处理活动时间，不是 collector 同步时间。

## Taskflow Visual Contract

落地时以参考项目 `assets/app.css` 后半段 v2 覆盖规则为准。

| Role | Target |
|---|---|
| App background | `#f6f8fb`，不使用装饰性径向光斑或 orb 背景 |
| Surface | `#ffffff`、`#fbfcfe` |
| Muted surface | `#f3f4f6` |
| Ink | `#111827` |
| Secondary text | `#737d8f` |
| Faint text | `#a2aab7` |
| Line | `#e7ebf0` |
| Soft line | `#eef1f5` |
| Brand | `#6658f6` / `#6357f6` |
| Brand gradient | `#6658f6` to `#8e64ff` |
| Blue | `#2764ff` / `#eef4ff` |
| Cyan | `#35b7d5` / `#e7f8fb` |
| Orange | `#ff7a1a` / `#fff1e8` |
| Green | `#19b46b` / `#e9fbf2` |
| Pink | `#ee65c7` / `#fff0fb` |
| Red | `#ff4f5e` / `#fff0f2` |
| Yellow | `#f6b739` / `#fff8e8` |
| Purple | `#9a46ff` / `#f5ebff` |

Layout targets:

- Sidebar desktop width is about `220px`.
- Topbar height is about `56px`.
- Desktop content width is tiered rather than a single `1440px` cap: Runs uses full guarded workspace width, Runtime Fleet uses the wider data-dense cap, and settings/forms use the standard readable cap.
- Desktop content padding is about `24px` to `26px`.
- Panel radius is about `13px` to `14px`.
- Button height is about `34px`; icon button is about `34px`.
- Nav row height is about `32px`.
- Kanban column header height is about `44px`.
- Kanban lane width should use the Taskflow compact-board target of about `235px` while preserving Lorume's five visible Runs lanes.
- Task cards use about `11px` radius and a thin left status stripe.

## Frontloaded Work

### 1. Runtime Fleet Activity Contract

Current Runtime Fleet has Task counts through `RuntimeFleetTaskSummary`, but it does not expose latest Task processing time. The UI must not calculate `最近活跃` by loading paginated Task rows, because pagination and filters would make the answer incomplete.

Add aggregate activity timestamps to the Runtime Fleet backend/query contract:

```ts
interface RuntimeFleetTaskSummary {
  byAgentId: Record<string, TaskStatusCounts>;
  byRuntimeId: Record<string, TaskStatusCounts>;
  byDeviceId: Record<string, TaskStatusCounts>;
  lastActiveAtByAgentId?: Record<string, string>;
  lastActiveAtByRuntimeId?: Record<string, string>;
  lastActiveAtByDeviceId?: Record<string, string>;
}
```

Aggregation rules:

- Activity source is `Task.updatedAt`, falling back to `Task.createdAt`.
- Agent activity is the max Task activity time for that Agent.
- Runtime activity is the max Task activity time for all Agents under that Runtime.
- Device activity is the max Task activity time for all Runtimes and Agents under that Device.
- Collector heartbeat, metadata sync, device registration, Skill probe, Operation events, Notification events, and page refresh do not count as activity.
- If no Task activity exists, show `暂无活跃`; do not fall back to sync time.

### 2. Relative Time Formatter

Add one shared formatter for Runtime Fleet activity labels.

Function contract:

```ts
formatRelativeActivityTime(value?: string, options?: { now?: Date }): string
```

Display rules:

| Condition | Label |
|---|---|
| Missing value | `暂无活跃` |
| Invalid value | `未知` |
| 0-59 seconds ago | `刚刚` |
| 1-59 minutes ago | `N 分钟前` |
| 1-23 hours ago | `N 小时前` |
| Yesterday in local time | `昨天 HH:mm` |
| 2-6 days ago | `N 天前` |
| 7-30 days ago in current year | `MM月DD日` |
| More than 30 days ago in current year | `MM月DD日` |
| Previous years | `YYYY年MM月DD日` |
| More than 60 seconds in the future | `YYYY年MM月DD日` |

Detail views may expose full absolute time through `title` or secondary text, but list rows should prefer the relative label.

### 3. Design Source Of Truth

Before or alongside code changes, update:

- `docs/product/design/color.md`
- `docs/product/design/layout.md`
- `docs/product/design/visual-language.md`
- `docs/product/design/shadcn-ui-system.md`
- `docs/product/design/page-patterns.md`
- `docs/product/runtime-fleet-page-spec.md`
- `docs/product/runtime-task-acceptance-spec.md`

These updates must convert the Taskflow reference into durable rules, not paste temporary implementation notes.

### 4. Harness Expectations

Existing tests currently assert old shell and page structure. Update tests to protect product invariants and new layout boundaries:

- navigation remains limited to implemented pages;
- Operations and Notifications remain top-right utility drawers;
- Runtime Fleet uses Task-derived `最近活跃`;
- Runs keeps five visible lanes and hides `cancelled` from the board-visible scope;
- raw external IDs and adapter evidence stay out of UI;
- mobile/laptop layouts do not introduce body-level horizontal overflow.

## Scope

In scope:

- Global Console theme token migration.
- Console sidebar and topbar rewrite.
- Runs Kanban visual rewrite.
- Runtime Fleet Device / Runtime / Agent visual rewrite.
- Runtime Fleet Task activity aggregation.
- Relative activity timestamps.
- Utility drawer and Organization Settings visual polish to avoid clashes.
- Product design docs and harness updates.

Out of scope:

- Adding new primary navigation pages.
- Adding People, Projects, Templates, Brand Kits, Playbook, Agent Studio, Object Catalog, Governance, or Workflow Studio as usable UI.
- Changing the runtime object model beyond Task activity aggregates.
- Adding `task.runtimeId`.
- Reintroducing raw adapter evidence, raw source refs, local paths, raw external IDs, or secrets to user-facing UI.
- Replacing shadcn/ui with copied static HTML/CSS.

## File Impact

Data and query:

- `src/runtime/runtime-model.ts`
- `src/runtime/runtime-fleet-query.ts`
- `src/server/postgres-store.ts`
- `src/server/runtime-http-api.ts`
- `src/runtime/runtime-fleet-query.test.ts`
- `src/server/postgres-store.test.ts`
- `src/server/runtime-http-api-postgres.test.ts`

Design system and shell:

- `src/index.css`
- `src/components/ui/sidebar.tsx`
- `src/components/ui/card.tsx`
- `src/components/ui/button.tsx`
- `src/components/data/Pill.tsx`
- `src/components/layout/AppShell.tsx`
- `src/App.test.tsx`
- `src/components/ui/shadcn-smoke.test.tsx`

Shared UI should continue to compose existing shadcn primitives and app-owned wrappers. Add new wrappers only when duplication becomes real; do not create speculative Taskflow component files just to mirror the reference HTML.

Runs:

- `src/runtime/RuntimeWorkBoardPage.tsx`
- `src/runtime/RuntimeTaskCard.tsx`
- `src/runtime/RuntimeTaskDetailDialog.tsx`
- `src/runtime/RuntimeTaskCard.test.tsx`
- `src/runtime/RuntimeTaskDetailDialog.test.tsx`
- `e2e/runtime-work-board.spec.ts`

Runtime Fleet:

- `src/runtime/RuntimeFleetPage.tsx`
- `src/runtime/RuntimeFleetPage.skill-probe.test.tsx`
- `e2e/runtime-fleet.spec.ts`

Secondary Console surfaces:

- `src/console/ConsoleUtilityDrawer.tsx`
- `src/console/ConsoleUtilityDrawer.test.tsx`
- `src/settings/OrganizationSettingsPage.tsx`
- `src/settings/OrganizationSettingsPage.test.tsx`

Docs:

- `docs/product/design/color.md`
- `docs/product/design/layout.md`
- `docs/product/design/visual-language.md`
- `docs/product/design/shadcn-ui-system.md`
- `docs/product/design/page-patterns.md`
- `docs/product/runtime-fleet-page-spec.md`
- `docs/product/runtime-task-acceptance-spec.md`

## Landing Steps

### Phase 1: Data Truth

Implement Runtime Fleet Task activity aggregation before UI rewrites.

Acceptance:

- Backend Runtime Fleet response includes `lastActiveAtByAgentId`, `lastActiveAtByRuntimeId`, and `lastActiveAtByDeviceId`.
- Unit and Postgres tests prove latest Task timestamp wins.
- Assets with no Task activity show `暂无活跃`.
- `lastSeenAt` and `collectedAt` are not used as activity fallback.

Focused checks:

```sh
npm run check:runtime
npm run check:backend
npm run check:db
```

### Phase 2: Activity Time Formatting

Implement and test relative activity labels with fixed `now` values.

Acceptance:

- All documented time ranges are covered by tests.
- Runtime Fleet UI can display relative labels without duplicating date logic.
- Existing absolute formatter remains available for detail/title contexts.

Focused checks:

```sh
npm run check:runtime
npm run check:quick
```

### Phase 3: Specs And Design Tokens

Update product design docs and global CSS tokens.

Acceptance:

- `docs/product/design/` describes Taskflow as the current visual direction.
- shadcn remains the primitive foundation.
- Token names and semantic colors support Taskflow chips, panels, status badges, sidebar, topbar, and lanes.
- `check:repo` passes.

Focused checks:

```sh
npm run check:repo
npm run check:quick
```

### Phase 4: Console Shell

Rebuild `AppShell` around Taskflow sidebar and topbar.

Acceptance:

- Desktop sidebar is fixed and visually matches the 220px Taskflow target.
- Topbar is about 56px high with search on the left and utility buttons on the right.
- Navigation exposes only Runtime Fleet, Runs, and 组织设置.
- Operations and Notifications remain utility drawer entry points.
- Mobile sidebar still opens and closes correctly.

Focused checks:

```sh
npm run check:quick
npm run check:e2e
```

### Phase 5: Shared Taskflow Components

Create reusable app-owned wrappers for repeated Taskflow patterns.

Acceptance:

- Activity list supports Device module.
- Directory table supports Runtime and Agent modules.
- Avatar supports deterministic initials and gradient styling.
- Panel wrapper supports Taskflow border/radius/shadow rhythm.
- Components do not create a parallel primitive system under `src/components/ui/`.

Focused checks:

```sh
npm run check:quick
```

### Phase 6: Runs Redesign

Apply `kanban.html` visual language to Runs while keeping Lorume data and the five visible board lanes.

Acceptance:

- Five board-visible product lanes are visible.
- Lane and card styling follows Taskflow Kanban rules.
- Cards show Lorume Task content only: Agent, user message, Agent reply fallback, channel, and activity/update time.
- Cards do not show raw IDs, execution association, adapter evidence, source summaries, or fake metadata.
- Filters still use backend channel facets and shadcn date range popover.
- Detail dialog remains limited to the current Task model.
- No body-level horizontal overflow on tested viewports.

Focused checks:

```sh
npm run check:runtime
npm run check:quick
npm run check:e2e
```

### Phase 7: Runtime Fleet Redesign

Apply `users.html` patterns to Runtime Fleet.

Acceptance:

- Device module uses Team Activity style cards.
- Runtime module uses Member Directory style table/list.
- Agent module uses Member Directory style table/list.
- All `最近活跃` values come from Task activity aggregates.
- `暂无活跃` appears when no Task activity exists.
- Sync and health evidence remains available in details, but list activity does not equal sync.
- Agent Skill probe remains a read-only row-level action.
- Detail inspector remains sticky on desktop and usable on mobile.

Focused checks:

```sh
npm run check:runtime
npm run check:quick
npm run check:e2e
```

### Phase 8: Secondary Surface Polish

Align Operations, Notifications, and Organization Settings with the new shell.

Acceptance:

- Utility drawers use the same panel, button, chip, list, and table rhythm.
- Organization Settings keeps permission behavior and token secrecy unchanged.
- Invitation links and device tokens are not logged or committed in docs/screenshots.

Focused checks:

```sh
npm run check:quick
npm run check:backend
```

### Phase 9: Full Verification And Review

Run final checks and visual review.

Required checks:

```sh
npm run check:repo
npm run check:runtime
npm run check:backend
npm run check:db
npm run check:quick
npm run check:build
npm run check:e2e
./scripts/verify.sh
```

Acceptance:

- Full harness passes.
- Runtime Fleet and Runs match Taskflow visual direction without exposing unsupported modules.
- Product docs, implementation, and tests agree.

## Harness Update Matrix

| Harness | Required updates |
|---|---|
| `src/runtime/runtime-fleet-query.test.ts` | Activity map normalization, relative time labels, no sync fallback |
| `src/server/postgres-store.test.ts` | Latest Task activity aggregation by Agent / Runtime / Device |
| `src/server/runtime-http-api-postgres.test.ts` | Runtime Fleet API returns activity maps |
| `src/App.test.tsx` | New shell structure, product-safe navigation, utility buttons |
| `src/components/ui/shadcn-smoke.test.tsx` | Primitive rendering after token/style updates |
| `src/runtime/RuntimeTaskCard.test.tsx` | Taskflow card hierarchy and no raw IDs |
| `src/runtime/RuntimeTaskDetailDialog.test.tsx` | Same limited Task fields after restyle |
| `src/runtime/RuntimeFleetPage.skill-probe.test.tsx` | Skill probe action survives directory redesign |
| `src/console/ConsoleUtilityDrawer.test.tsx` | Drawer content still works after style polish |
| `src/settings/OrganizationSettingsPage.test.tsx` | Permission and token behavior unchanged |
| `e2e/runtime-work-board.spec.ts` | Five visible lanes, cancelled lane hidden, Taskflow board layout, filters, detail dialog, responsive overflow |
| `e2e/runtime-fleet.spec.ts` | Device activity list, Runtime/Agent directories, `最近活跃`, sticky detail, responsive overflow |

## Principles To Preserve Or Upgrade

Preserve:

- Runtime model has four top-level product objects: `Device`, `Runtime`, `Agent`, `Task`.
- Relationship stays linear: `Device -> Runtime -> Agent -> Task`.
- Runtime and Agent status remains collection status.
- Task product model keeps `userMessage` and optional `agentReply`; do not reintroduce unsupported title/description/tool call fields.
- Runs stays task-context first.
- Runtime kind, adapter kind, and Channel kind remain separate.
- shadcn/ui remains the generated primitive system.
- App-owned wrappers live outside `src/components/ui/`.
- Navigation exposes only implemented capabilities.

Upgrade:

- Add a durable design rule that `最近活跃` means Task processing activity, not collection freshness.
- Add a durable design rule that collection freshness and activity are separate concepts.
- Add a durable page pattern for Taskflow-style Runtime Fleet modules:
  - Device as activity list;
  - Runtime and Agent as directories.
- Add a durable page pattern for Taskflow-style Runs Kanban while preserving the five board-visible product lanes and keeping `cancelled` queryable outside the board-visible scope.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| `最近活跃` becomes misleading by falling back to sync time | Show `暂无活跃` when Task activity is missing |
| Token migration changes public home or auth pages unintentionally | Run App tests and visually inspect public/identity surfaces |
| Static CSS copy creates a second design system | Encode values into shadcn-compatible tokens and app wrappers |
| Runtime Fleet file becomes too large | Extract ActivityList, DirectoryTable, Avatar, and panel wrappers |
| E2E becomes pixel-brittle | Assert stable layout boundaries, roles, labels, and product content rather than every pixel |
| Runs status scope diverges from the static five-column reference | Copy card/column language while preserving Lorume's board-visible status model |

## Definition Of Done

- Design docs describe the Taskflow visual direction.
- Runtime Fleet API exposes Task-derived activity maps.
- Runtime Fleet renders Device activity list plus Runtime/Agent directories.
- Runtime Fleet `最近活跃` follows the documented Task activity rules.
- Runs renders Taskflow-style Kanban with five visible product lanes, while `cancelled` remains backend-queryable and hidden from the board.
- Console sidebar and topbar match Taskflow style while keeping Lorume navigation.
- Operations, Notifications, and Organization Settings no longer visually clash.
- No raw IDs, adapter evidence, secrets, or unsupported future capabilities are exposed.
- `./scripts/verify.sh` passes before handoff.
