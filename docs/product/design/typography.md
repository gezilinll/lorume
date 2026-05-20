# Typography

Lorume uses a two-role typography system: Sans for product reading and interaction, Mono for technical values and compact numeric scanning.

## Font Roles

| Role | Token | Use |
|---|---|---|
| Sans | `--font-sans` / `--lorume-font-body` | Page titles, Chinese body, buttons, forms, work items, details |
| Mono | `--font-mono` / `--lorume-font-mono` | Runtime names, technical labels, numbers, timestamps, short IDs |

## Sans Rules

Sans is the default product voice:

- Home and auth headlines.
- Console page titles.
- CTA buttons.
- Work item titles and summaries.
- Form labels, placeholders, errors, and details.
- Drawer and inspector text.

Use weight, spacing, and layout for hierarchy. Do not use display-size type inside compact panels.

## Mono Rules

Mono is used only when alignment or technical recognition matters:

- Numeric metrics.
- Short runtime, agent, channel, and operation type values.
- Command fragments.
- Short hashes and timestamps.

Mono is not used for long Chinese sentences.

## Hierarchy

- Each page has one highest-level heading.
- Home can use a larger headline, but it must leave product preview visible in the first viewport.
- Console titles stay compact enough to leave room for filters, lists, and inspectors.
- Compact panels use compact headings.
- Text does not scale with viewport width; use fixed sizes with media-query adjustments when needed.
- Letter spacing remains `0`.

## Implementation Mapping

- `.homeTitle`, `.auth-layout__title`, `h1`, `h2`, `.detailHeader h2`, `.workCard strong`, `.primaryButton`, `.secondaryButton`, `.quickRangeButton`, `.toolbarField select`, `.detailBlock p`, and `.detailBlock li` use `--lorume-font-body`.
- `.navItem`, `.metricCard strong`, `.tableSummary`, `.assetHeader`, short IDs, command fragments, and timestamps use `--lorume-font-mono`.
- `.badge`, `.refPill`, and `.statusBadge` use `--lorume-font-body`; they are product labels/statuses, not code tokens.
- `src/ui/ui-tokens.test.tsx` locks the core mapping; update this spec and the harness together.

## Line Length

- Body copy targets 45 to 75 English-character equivalent width.
- Detail and card paragraphs should stay concise; summarize or collapse long content.
- Long IDs, raw URLs, and external opaque identifiers are wrapped, summarized, or hidden when they are not useful to users.
