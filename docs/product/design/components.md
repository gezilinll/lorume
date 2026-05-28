# Components

Component rules cover current UI primitives and page-level components. New components should first confirm whether an existing primitive can be reused.

## Shared Primitives

Shared UI primitives are generated shadcn files in `src/components/ui/`. App-owned product wrappers live in focused folders outside `src/components/ui/` and compose shadcn primitives.

- `Button`: actions.
- `Badge`: status and metadata chips.
- `Card`: panels and contained summaries.
- `Sidebar`: Console navigation.
- `Sheet`: utility drawers.
- `Field` and `Input`: forms.
- `Table`: dense object rows.
- `Select`, `DropdownMenu`, and `Tabs`: filtering and view controls. Select dropdown content uses the card surface token (`bg-card` / `text-card-foreground`) so compact filter popovers stay visually aligned with the light Console surfaces instead of becoming a high-contrast black menu.
- `Skeleton` and `Alert`: loading and error states.
- `Sonner`: ephemeral feedback such as copy success.
- Console Sidebar: composed from the generated shadcn `Sidebar` primitives. The Console shell must use `SidebarHeader` + `SidebarMenu` for one unified workspace/account switcher, `SidebarGroupLabel` + `SidebarMenuButton` for primary nav, and `SidebarRail` for collapse. The workspace/account menu shows current user identity, workspace list, active workspace check, optional future create-workspace entry, and logout in one shadcn `DropdownMenu`. Do not add a separate Lorume wordmark inside the protected Console sidebar, and do not reintroduce a separate profile card in `SidebarFooter`.

App-owned wrappers:

- `Pill`: normalized status/channel/runtime/assignee metadata chips. Use stable `data-pill-kind` and `data-pill-tone` attributes for harnesses. Compact card pills use a stable `h-6` hit/readability box with `leading-4` so labels do not look clipped.
- `Pill` tone usage follows the accent token families. Status pills use semantic `success` / `warning` / `danger` / `info`; channel/category pills may use `blue`, `cyan`, `orange`, `green`, `pink`, `yellow`, or `purple` when the category is the primary scanning cue.
- Directory/avatar initials should use a shared deterministic accent wrapper instead of one-off gradients or page-local hex values.
- `StatusBadge`: product status wrapper over `Pill`; use it instead of hand-colored badges.
- `SpotlightSurface`: reusable click/hover surface for non-Kanban surfaces that need a subtle focus affordance. Runs task cards no longer use cursor-following glow; they use the Taskflow Kanban card pattern with `data-spotlight="task-card"` kept only as a stable harness hook.
- `DetailSurface`: shadcn Dialog-backed detail card for task, operation, notification, and other focused object details. Runs task details use `data-surface="task-detail"`, `data-depth="modal-3d"`, and `data-layout="task-detail-simple"`. DialogContent remains the accessible centered positioning layer; 3D transform belongs to an internal `data-depth-plane` visual layer. Close controls must live inside that plane so the whole visible card, including close affordance, moves as one surface. Detail overlays may use a very light `2px` backdrop blur plus dimming to separate the focused card without obscuring the underlying board.
- Console Workbar: the sticky top strip for page title/summary on the left and utility icons/refresh on the right.

## Buttons

- Button text uses Sans.
- Primary actions use Taskflow purple and clear object-specific labels.
- Secondary actions use white/soft surfaces and hairline borders.
- Danger actions use danger tone and explicit object labels.
- Disabled, loading, focus-visible, hover, and active states must exist.
- Do not expose actions whose page, data path, permission, and harness do not exist.

## Fields

- Fields must have visible labels.
- Placeholder text gives examples; it never replaces a label.
- Error messages state what failed and what the user can do next.
- Verification code inputs support paste and clear focus states.

## Badges

- Badge copy is short and semantic.
- Status badges use semantic color.
- Runtime Fleet Device/Runtime status badges use only `同步中`、`在线`、`离线`、`异常`; Agent status badges additionally allow `不可见` for historical Agents absent from the latest full Runtime snapshot. `不可见` must expose a Tooltip explaining that the Agent was previously collected but is absent from the latest full collection and may have been deleted, disabled, or moved out of scope. `未知` stays out of asset status UI.
- Runtime/source/channel badges use neutral or info color unless expressing state.
- A row should not accumulate badges that repeat the same fact.
- Runs task cards use a consistent pill order: channel kind only. The lane already expresses status, so cards must not repeat status pills such as `待处理`; conversation/group labels such as `DingTalk 群聊` do not appear as card pills. Creator and assignee appear as text metadata, not extra pills. Missing optional facts are omitted rather than replaced with raw IDs or frontend-fabricated execution states. If the pill set exceeds the card limit, remaining pills collapse into a `+N` count pill.
- Runs channel pills should be visually richer than neutral source badges, using a stable soft accent per channel kind while keeping status meaning on lane/card stripes.

## Metrics

- Metrics appear in summary rails or compact metric grids.
- The label explains the object; the number uses Mono.
- A metric may have a top accent line, but it should not dominate the page.

## Rows And Cards

- Rows/cards must answer what the object is, what state it is in, and why the user should care.
- Work items include task, creator/user-facing source, Agent, Runtime/Channel, and stage when available.
- Long titles and summaries wrap or clamp.
- Debug payloads, adapter evidence, opaque external IDs, tokens, and raw JSON do not enter rows/cards.
- Runs cards follow the Taskflow Kanban density: compact channel pill row, short `userMessage` title, `agentReply` or `暂无 Agent 答复`, creator/assignee metadata, footer time, and a thin left status stripe. Target card radius is about `11px`, padding is about `14px 13px 12px 17px`, and title line-height is tight enough for repeated scanning.
- Hover adds a one-pixel lift and restrained `0 12px 26px` shadow. Do not add cursor-following glow, decorative blobs, or persistent selected state after opening a detail dialog.

## Menus And Filters

- Compact Console menus use `bg-card`, `border-border`, `--menu-shadow`, 36px-ish rows, and 12-13px text. Avoid large profile-panel spacing inside Sidebar account menus.
- Filter triggers have two visible states: inactive outline (`Filter` icon + `筛选`) and active solid blue (`Filter` icon + `N 个筛选` + inline clear `x`).
- Filter menu dimensions should fit the available options. A single-dimension menu should not reserve large blank vertical space.
- Multi-select submenu rows use a left checkbox treatment: selected rows show a black square with a white check and a `--menu-selection` background; unselected rows reserve the same left column with a visible border/background so the checkbox target does not disappear into the menu surface.
- `全部` in a multi-select filter represents zero selected concrete options. It is not checked together with specific options.

## Detail Panels

- Detail panels are document-like, with a clear title, summary, status badges, and ordered metadata.
- Detail text uses Sans; technical values and timestamps can use Mono.
- Do not repeat data already obvious in the surrounding list unless it helps orientation.
- Object details that are opened from a card/list use `DetailSurface` dialogs. Dialog overlays use only light dimming plus a restrained `2px` backdrop blur; stronger blur or frosted panels are not allowed.
- Runs task details are not raw field stacks. The header title is only truncated `userMessage`; the body has exactly three designed blocks: task information (`发起人`、`承接 Agent`、`更新时间`、`渠道`), user message, and Agent reply. The channel field may include the backend-normalized readable conversation/source label after the channel kind, for example `DingTalk 小卷和用户支持的同学们` or `Slock #AjisFarm`; it must never fall back to opaque external IDs. Do not repeat status, channel, or Agent in the header, and do not show execution association, source summary, adapter evidence, or raw IDs.

## Utility Drawers

- Operations and Notifications drawers open from top-right buttons.
- Drawers are narrow by default and use a vertical list. Clicking a task or notification opens `DetailSurface`; the drawer itself does not expand into a wide two-pane workspace.
- Drawers have no internal task/notification tabs; each route represents one active drawer state.
- Closing returns users to the page they opened the drawer from.

## Workbar

- Console pages use one sticky top workbar instead of page-level hero/title blocks.
- The workbar is a shared flat Taskflow top strip (`bg-background/85`, bottom border, fixed `h-14` content row) inside the Console shell, not a page-owned loose header or a floating card inside a header. Runtime Fleet, Runs, Skill 仓库, and Settings must render the same workbar treatment.
- The workbar must span the main content width without padded side color blocks. Avoid nested rounded workbar cards that reveal sidebar/page background on the left or right edges.
- The left side shows page identity and compact page-specific facts. The right side holds utility icons and, only on refreshable pages, a refresh icon as the last action.
- Page bodies do not repeat the workbar title, explanatory paragraph, or summary metrics unless the data is part of the primary workflow.
- Utility icons are icon-only with tooltips; counts appear as compact badges.

## Empty And Error States

- Empty states explain the current filter/context.
- Error states include a user-meaningful cause and next step.
- Loading states should not block reading the rest of the page unless the page has no data yet.
