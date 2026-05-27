# Color

Lorume Console uses the Taskflow reference palette: compact white surfaces on a pale gray background, purple primary actions, and vivid but controlled blue/cyan/orange/green/pink/red/yellow/purple accents. Color serves hierarchy, state, object memory, and scan speed; it should make the product feel明快、年轻、统一, without turning large surfaces into decorative color blocks.

## Active Palette

| Role | Token | Value |
|---|---|---|
| Page background | `--background` | `#f6f8fb` |
| Sidebar / card surface | `--card`, `--sidebar` | `#ffffff` |
| Soft surface | `--muted` | `#f3f4f6` |
| Ink | `--foreground` | `#111827` |
| Muted text | `--muted-foreground` | `#737d8f` |
| Faint text | local text token | `#a2aab7` |
| Hairline | `--border` | `#e7ebf0` |
| Soft line / input | `--input` | `#eef1f5` |
| Primary action / active mark | `--primary` | `#6658f6` |
| Info blue | `--chart-1` / info status | `#2764ff` / `#eef4ff` |
| Cyan accent | `--chart-4` | `#35b7d5` / `#e7f8fb` |
| Warning orange | warning status | `#ff7a1a` / `#fff1e8` |
| Success green | success status | `#19b46b` / `#e9fbf2` |
| Danger red | `--destructive` / danger status | `#ff4f5e` / `#fff0f2` |
| Yellow auxiliary | `--chart-3` | `#f6b739` / `#fff8e8` |
| Purple auxiliary | local chip token | `#9a46ff` / `#f5ebff` |

## Accent Token Families

Each accent family must expose the same roles in `src/index.css`:

| Family | Solid | Soft | Border | Foreground | Use |
|---|---|---|---|---|---|
| Brand | `--brand` | `--brand-soft` | `--brand-border` | `--brand-foreground` | primary action, current navigation, Lorume identity |
| Blue | `--blue` | `--blue-soft` | `--blue-border` | `--blue-foreground` | active filters, information, review/acceptance state |
| Cyan | `--cyan` | `--cyan-soft` | `--cyan-border` | `--cyan-foreground` | runtime/category context, secondary object avatars |
| Orange | `--orange` | `--orange-soft` | `--orange-border` | `--orange-foreground` | in-progress, pending/manual attention |
| Green | `--green` | `--green-soft` | `--green-border` | `--green-foreground` | healthy, online, complete |
| Pink | `--pink` | `--pink-soft` | `--pink-border` | `--pink-foreground` | people/team accent, auxiliary chips |
| Red | `--red` | `--red-soft` | `--red-border` | `--red-foreground` | failed, blocked, destructive |
| Yellow | `--yellow` | `--yellow-soft` | `--yellow-border` | `--yellow-foreground` | low-priority/notice accents, not primary warning |
| Purple | `--purple` | `--purple-soft` | `--purple-border` | `--purple-foreground` | roles, admin labels, auxiliary chips |

The visual rule is "rich small accents on calm surfaces": use solid color for icons, left stripes, dots, avatar gradients, active filter pills, and primary CTAs; use soft color for chips, status pills, icon containers, selected rows, and light lane tinting. Do not apply vivid fills to entire panels, page backgrounds, or large table regions.

## Usage Ratio

- 65-75% cool background and white / near-white surfaces.
- 15-25% text, lines, and structural chrome.
- 8-12% action, signal, object memory, and semantic state color.

If a screen feels busy, reduce accent usage before reducing useful data.

## Semantic Rules

- Purple means primary action, active mark, or current navigation.
- Blue and cyan mean informational or runtime/category context.
- Green means healthy or completed.
- Orange means attention, manual step, delayed sync, or pending user review. It should not create a separate "stale" asset status when recent sync time already explains freshness.
- Red means failed, blocked, critical, or destructive.
- Source/runtime/channel badges may use a stable soft accent when they are the main scannable category on the surface, such as Runs channel pills. They must not reuse state colors to imply health or progress unless the label is actually a state.
- Avatars and initials use deterministic accent families so directory pages feel lively without changing object semantics.
- Runs lane backgrounds stay low-saturation; task card left stripes carry the stronger status signal.
- Active filter controls use `--active-filter` with white foreground. Inactive filter controls stay outline/white.

## Contrast

- Body text, form values, and buttons must remain readable on all surfaces.
- Low-contrast grid texture and traces cannot overlap text in a way that reduces legibility.
- Badge meaning must be expressed by text and color together.

## Forbidden

- High-saturation yellow sidebars.
- Thick black borders as a primary visual language.
- Single-hue blue or purple SaaS pages.
- Random untokenized hex values in product CSS.
- Platform source colors mapped directly to product state colors.
- Decorative radial blobs or gradient-orb backgrounds behind Console content.
- Making every surface neutral gray when a small, tokenized accent would improve scan speed.
