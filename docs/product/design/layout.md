# Layout

Lorume layout balances product clarity and operational density. Brand and Identity surfaces can use more breathing room; Console surfaces must stay stable, compact, and scannable.

## Spacing

- Use a 4px base spacing scale.
- Use `gap` for component and list rhythm.
- Avoid all sections having identical spacing; hierarchy should be visible.
- Do not create empty hero or preview panels that occupy space without product signal.

## Surfaces And Cards

- Surface: a bounded area for forms, lists, details, inspectors, drawers, and previews.
- Card: a repeated item such as a work item, runtime row, skill row, notification thread, or operation row.
- Do not put UI cards inside other UI cards.
- Page sections should read as layout regions, not as a pile of floating cards.

## Console Shell

- Desktop Console uses a Taskflow-style fixed left sidebar at about `220px`.
- Topbar is about `56px` tall and contains page identity, compact metadata, utility buttons, and refresh actions. Do not add a fake global search unless the search behavior is implemented.
- Content uses shared responsive padding around `18px` to `30px` and one of three width tiers:
  - `workspace`: full available width with guarded page padding for boards and operational canvases such as Runs.
  - `data-dense`: about `1680px` max width for directory/table pages such as Runtime Fleet.
  - `standard`: about `1280px` max width for forms/settings pages such as Organization Settings.
- Sidebar nav rows are about `32px` tall with `7px` radius and a muted active background.
- Main pages use summary rail + primary workspace + detail inspector when the data model supports it.
- Utility drawers open from the right and preserve the current Console context.
- Operations and Notifications drawers target `min(440px, calc(100vw - 16px))` on desktop unless a specific workflow proves more width is required.

## Width And Alignment

- Forms, filters, lanes, lists, and inspectors must have stable width rules.
- Search can grow, but filters keep meaningful minimum widths.
- Time range, Runtime, Channel, and stage filters cannot collapse to unreadable text.
- Detail titles, badges, and metadata wrap or truncate without creating horizontal page scroll.

## Overflow

- Body-level horizontal scrolling is a regression.
- Long URLs, long Chinese titles, raw JSON, and long IDs must wrap, clamp, or be summarized.
- Work card titles can clamp to multiple lines; detail titles can wrap.
- Opaque raw external IDs should not enter the user-facing visual layer.

## Density

- Brand surfaces use meaningful product preview density.
- Identity surfaces focus one form task and a compact operations preview.
- Console surfaces reduce decoration and emphasize lists, metrics, filters, lanes, and inspectors.
- Runtime Fleet uses Device activity-list rhythm plus Runtime/Agent directory-table rhythm.
- Runs uses a Kanban board rhythm: five visible lanes, `235px` minimum lane width, about `14px` lane gaps, `44px` lane headers, `11px` task-card radius, and a thin left status stripe.

## Responsive

- Breakpoints are content-driven.
- Small screens stack rail, topbar, content, and drawer in a readable order.
- Boards may stack lanes vertically on narrow screens.
- Drawers can become full-width on narrow screens, but they still read as utility states rather than primary pages.
