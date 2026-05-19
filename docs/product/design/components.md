# Components

Component rules cover current UI primitives and page-level components. New components should first confirm whether an existing primitive can be reused.

## Shared Primitives

The following primitives keep their current filenames during this redesign:

- `PixelButton`: primary, secondary, danger, and compact action buttons.
- `PixelField`: labeled input controls.
- `PixelPanel`: modern precision surface.
- `PixelBadge`: status, source, channel, stage, and count badges.
- `PixelIcon`: shared product icon entry.
- `PixelLogo`: brand mark.
- `PixelDecorations`: optional low-noise grid/trace decoration, not pixel sprites.
- Console shell organization switcher: top-left current organization entry, future-ready for organization switching without adding fake options.
- Console account menu: bottom-left avatar entry for personal account actions.

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
- Runtime/source/channel badges use neutral or info color unless expressing state.
- A row should not accumulate badges that repeat the same fact.

## Metrics

- Metrics appear in summary rails or compact metric grids.
- The label explains the object; the value uses Sans by default and Mono only when fixed-width numeric scanning is required.
- A metric may have a top accent line, but it should not dominate the page.

## Rows And Cards

- Rows/cards must answer what the object is, what state it is in, and why the user should care.
- Work items include task, creator/user-facing source, Agent, Runtime/Channel, and stage when available.
- Long titles and summaries wrap or clamp.
- Debug payloads, adapter evidence, opaque external IDs, tokens, and raw JSON do not enter rows/cards.

## Detail Panels

- Detail panels are document-like, with a clear title, summary, status badges, and ordered metadata.
- Detail text uses Sans; technical values and timestamps can use Mono.
- Do not repeat data already obvious in the surrounding list unless it helps orientation.

## Utility Drawers

- Operations and Notifications drawers open from top-right buttons.
- Drawers are narrow by default and use vertical list + selected detail.
- Drawers have no internal task/notification tabs; each route represents one active drawer state.
- Closing returns users to the page they opened the drawer from.

## Organization And Account Chrome

- Current organization belongs in the upper-left Console rail, directly below the brand mark.
- The organization entry can open a small menu for current organization actions; do not invent unavailable organization switching data.
- Personal identity belongs at the lower-left rail as an avatar/account menu.
- The account menu contains personal account actions such as logout; it must not repeat current organization or role when that information is already visible elsewhere.
- Raw email should not be permanently exposed in the rail; show it inside the account menu where it confirms identity.

## Empty And Error States

- Empty states explain the current filter/context.
- Error states include a user-meaningful cause and next step.
- Loading states should not block reading the rest of the page unless the page has no data yet.
