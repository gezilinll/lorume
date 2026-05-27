# Design Tokens

Lorume visual implementation must flow through shadcn semantic tokens, Tailwind utilities, and shared UI primitives. Product components should not scatter one-off colors, shadows, borders, fonts, or spacing.

## Source

Code token entry:

- [../../../src/index.css](../../../src/index.css)

Shared UI primitives are generated shadcn component files:

- [../../../src/components/ui](../../../src/components/ui)

The shadcn setup and import rules live in [shadcn-ui-system.md](shadcn-ui-system.md).

## Token Layers

1. Primitive token: raw palette, font stacks, radii, spacing, shadow.
2. shadcn semantic token: `background`, `foreground`, `card`, `primary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `chart-*`, and `sidebar-*`.
3. Component token: button, field, badge, card, sidebar, sheet, table, drawer, inspector.

Business pages should use Tailwind utilities mapped to semantic or component tokens.

## Required Token Groups

- Font: `--font-sans`, `--font-mono`, and Tailwind font utilities backed by `src/index.css`.
- Color: `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--border`, `--input`, `--ring`, `--chart-*`, and `--sidebar-*`.
- Accent families: `--brand-*`, `--blue-*`, `--cyan-*`, `--orange-*`, `--green-*`, `--pink-*`, `--red-*`, `--yellow-*`, and `--purple-*`. Each family exposes `solid`, `soft`, `border`, and `foreground` roles through the naming pattern documented in [color.md](color.md).
- Product surface helpers: `--surface`, `--surface-soft`, `--surface-muted`, `--ink-2`, `--muted-2`, `--line-2`, `--menu-selection`, `--menu-shadow`, `--active-filter`, and `--active-filter-foreground`.
- Border and ring: `--border`, `--input`, `--ring`, and Tailwind utilities for hairlines, focus-visible rings, and disabled states.
- Radius: `--radius` plus shadcn radius utilities for small, medium, large, and full-pill forms.
- Shadow: Tailwind/shadcn shadow utilities for subtle surface, elevated surface, floating drawer, and focus states.
- Spacing: Tailwind spacing utilities on the 4px base scale.
- Motion: Tailwind animation utilities plus reduced-motion fallbacks.
- Z-index: Tailwind z-index utilities for header, utility bar, drawer, popover, modal, and toast layering.

## Change Rules

- If the same visual value appears three times for the same intent, promote it to token or component variant.
- If a layout is truly page-specific, keep it page-scoped but still use tokens for visual values.
- Token names describe intent, not current color. Use shadcn semantic names such as `--primary` and `--muted-foreground`, not `--blue-button`.
- Product page components may choose from named accent families, but they must not embed raw hex or one-off `rgba` values for repeated chips, avatars, status stripes, menu selections, or active filter states.
- Token changes must be checked against Brand, Identity, and Console surfaces.

## Forbidden

- Untokenized `#fff`, `#000`, random rgba, or one-off box-shadow in product CSS.
- Business page CSS overriding shared component core states.
- Visual tokens for a single runtime source, platform, or data row.
