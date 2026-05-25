# Typography

Lorume uses a two-role typography system: Sans for product reading and interaction, Mono for technical values and compact numeric scanning.

## Font Roles

| Role | Source | Use |
|---|---|---|
| Sans | `--font-sans`, shadcn theme variables, and Tailwind font utilities | Page titles, Chinese body, buttons, forms, work items, details |
| Mono | `--font-mono`, shadcn theme variables, and Tailwind font utilities | Runtime names, technical labels, numbers, timestamps, short IDs |

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

- Typography tokens live in `src/index.css` through shadcn theme variables and Tailwind v4 utility usage.
- Generated shadcn components in `src/components/ui/` and app-owned wrappers should consume font styles through Tailwind classes and shadcn tokens.
- Product labels, statuses, buttons, forms, cards, tables, sidebars, and sheets use Sans unless the value needs technical recognition or numeric alignment.
- Runtime names, short IDs, command fragments, hashes, timestamps, and dense numeric metrics may use Mono.
- `src/components/ui/shadcn-smoke.test.tsx` locks the shadcn foundation; component and page tests should cover typography behavior through generated primitives, wrappers, and user-visible structure instead of old page CSS selector contracts.

## Line Length

- Body copy targets 45 to 75 English-character equivalent width.
- Detail and card paragraphs should stay concise; summarize or collapse long content.
- Long IDs, raw URLs, and external opaque identifiers are wrapped, summarized, or hidden when they are not useful to users.
