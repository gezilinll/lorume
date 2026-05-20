# Color

Lorume uses a cool, low-noise palette grounded in mature Slate / Blue / Teal UI scales. Color serves hierarchy, state, and product memory; it must not decorate every component.

## Active Palette

| Role | Token | Value |
|---|---|---|
| Page background | `--lorume-color-bg` | `#f8fafc` |
| Rail background | `--lorume-color-bg-rail` | `#eef4f8` |
| Surface | `--lorume-color-surface` | `rgba(255, 255, 255, 0.88)` |
| Soft surface | `--lorume-color-surface-soft` | `#f1f5f9` |
| Blue surface | `--lorume-color-surface-blue` | `#eff6ff` |
| Ink | `--lorume-color-ink` | `#0f172a` |
| Muted text | `--lorume-color-muted` | `#64748b` |
| Faint text | `--lorume-color-faint` | `#94a3b8` |
| Hairline | `--lorume-color-line` | `#d8e2ee` |
| Strong line | `--lorume-color-line-strong` | `#b6c4d2` |
| Primary action | `--lorume-color-action` | `#2563eb` |
| Primary action bright | `--lorume-color-action-bright` | `#3b82f6` |
| Primary action dark | `--lorume-color-action-dark` | `#1d4ed8` |
| Operational signal | `--lorume-color-accent` | `#0f9f9a` |
| Success | `--lorume-color-success` | `#15803d` |
| Warning | `--lorume-color-warning` | `#a16207` |
| Danger | `--lorume-color-danger` | `#dc2626` |
| Info | `--lorume-color-info` | `#2563eb` |

## Usage Ratio

- 70% cool background and white surfaces.
- 20% text, lines, and structural chrome.
- 10% action, signal, and semantic state color.

If a screen feels busy, reduce accent usage before reducing useful data.

## Semantic Rules

- Action blue means primary action or active navigation.
- Teal means operational signal, sync, routing, or online context.
- Green means healthy or completed.
- Amber means attention, manual step, delayed sync, or pending user review. It should not create a separate "stale" asset status when recent sync time already explains freshness.
- Red means failed, blocked, critical, or destructive.
- Source/runtime/channel badges should be neutral by default. Semantic color is reserved for actual health, availability, progress, warning, and error states.

## Contrast

- Body text, form values, and buttons must remain readable on all surfaces.
- Low-contrast grid texture and traces cannot overlap text in a way that reduces legibility.
- Badge meaning must be expressed by text and color together.

## Forbidden

- High-saturation yellow sidebars.
- Thick black borders as a primary visual language.
- Single-hue blue SaaS pages.
- Random untokenized hex values in product CSS.
- Platform source colors mapped directly to product state colors.
