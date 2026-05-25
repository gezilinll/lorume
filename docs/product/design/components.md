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
- `Select`, `DropdownMenu`, and `Tabs`: filtering and view controls.
- `Skeleton` and `Alert`: loading and error states.
- `Sonner`: ephemeral feedback such as copy success.

App-owned wrappers:

- `Pill`: normalized status/channel/runtime/assignee metadata chips. Use stable `data-pill-kind` and `data-pill-tone` attributes for harnesses. Compact card pills use a stable `h-6` hit/readability box with `leading-4` so labels do not look clipped.
- `StatusBadge`: product status wrapper over `Pill`; use it instead of hand-colored badges.
- `SpotlightSurface`: click/hover surface for Runs task cards. It composes shadcn-style card surfaces with a scoped cursor-following glow, `data-surface="spotlight-card"`, and `data-spotlight="task-card"`; reduced motion must keep the card readable without requiring movement. Runs task hover stays subtle: one-pixel lift, restrained `0 10px 24px` shadow, and a small local glow.
- `DetailSurface`: shadcn Dialog-backed detail card for task, operation, notification, and other focused object details. Runs task details use `data-surface="task-detail"`, `data-depth="modal-3d"`, and `data-layout="task-detail-simple"`. DialogContent remains the accessible centered positioning layer; 3D transform belongs to an internal `data-depth-plane` visual layer. Close controls must live inside that plane so the whole visible card, including close affordance, moves as one surface.
- Console Workbar: the sticky top strip for page title/summary on the left and utility icons/refresh on the right.

## Buttons

- Button text uses Sans.
- Primary actions use action blue and clear object-specific labels.
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
- Runtime Fleet asset status badges use only `同步中`、`在线`、`离线`、`异常`; `未知` stays out of asset status UI.
- Runtime/source/channel badges use neutral or info color unless expressing state.
- A row should not accumulate badges that repeat the same fact.
- Runs task cards use a consistent pill order: channel kind only. The lane already expresses status, so cards must not repeat status pills such as `待处理`; conversation/group labels such as `DingTalk 群聊` do not appear as card pills. Creator and assignee appear as text metadata, not extra pills. Missing optional facts are omitted rather than replaced with raw IDs or frontend-fabricated execution states. If the pill set exceeds the card limit, remaining pills collapse into a `+N` count pill.

## Metrics

- Metrics appear in summary rails or compact metric grids.
- The label explains the object; the number uses Mono.
- A metric may have a top accent line, but it should not dominate the page.

## Rows And Cards

- Rows/cards must answer what the object is, what state it is in, and why the user should care.
- Work items include task, creator/user-facing source, Agent, Runtime/Channel, and stage when available.
- Long titles and summaries wrap or clamp.
- Debug payloads, adapter evidence, opaque external IDs, tokens, and raw JSON do not enter rows/cards.
- Runs cards follow a Mail-list density with four rows: assignee Agent, `userMessage` truncated to 16 characters, `agentReply` or `暂无 Agent 答复`, then last updated time plus channel pill. Target card padding is `px-3 py-3`; title line-height is tight enough for repeated scanning.
- Hover adds a low-intensity spotlight and 2.5D lift through `SpotlightSurface`: `translateY(-1px)`, scoped glow, and a restrained shadow. The card footer remains overflow-visible so compact channel pills are not clipped. Selected state is not persistent after opening a detail dialog.

## Detail Panels

- Detail panels are document-like, with a clear title, summary, status badges, and ordered metadata.
- Detail text uses Sans; technical values and timestamps can use Mono.
- Do not repeat data already obvious in the surrounding list unless it helps orientation.
- Object details that are opened from a card/list use `DetailSurface` dialogs. Dialog overlays must not blur the page; background dimming is enough.
- Runs task details are not raw field stacks. The header title is only truncated `userMessage`; the body has exactly three designed blocks: task information (`发起人`、`承接 Agent`、`更新时间`、`渠道`), user message, and Agent reply. Do not repeat status, channel, or Agent in the header, and do not show execution association, source summary, adapter evidence, or raw IDs.

## Utility Drawers

- Operations and Notifications drawers open from top-right buttons.
- Drawers are narrow by default and use a vertical list. Clicking a task or notification opens `DetailSurface`; the drawer itself does not expand into a wide two-pane workspace.
- Drawers have no internal task/notification tabs; each route represents one active drawer state.
- Closing returns users to the page they opened the drawer from.

## Workbar

- Console pages use one sticky top workbar instead of page-level hero/title blocks.
- The left side shows page identity and compact page-specific facts. The right side holds utility icons and, only on refreshable pages, a refresh icon as the last action.
- Page bodies do not repeat the workbar title, explanatory paragraph, or summary metrics unless the data is part of the primary workflow.
- Utility icons are icon-only with tooltips; counts appear as compact badges.

## Empty And Error States

- Empty states explain the current filter/context.
- Error states include a user-meaningful cause and next step.
- Loading states should not block reading the rest of the page unless the page has no data yet.
