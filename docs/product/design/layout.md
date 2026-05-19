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

- Desktop Console uses compact left rail navigation.
- The left rail has three zones: brand + current organization at the top, primary navigation in the middle, and the personal account avatar/menu at the bottom.
- Topbar utility buttons are only for tasks and notifications; page-specific primary actions stay in the page header.
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

## Responsive

- Breakpoints are content-driven.
- Small screens stack rail, topbar, content, and drawer in a readable order.
- Boards may stack lanes vertically on narrow screens.
- Drawers can become full-width on narrow screens, but they still read as utility states rather than primary pages.
