# Icons And Assets

Lorume icons, logo, and decorative assets must use a unified modern visual weight. Consistency is more important than quick one-off SVGs.

## Icon System

- Product icons use `lucide-react`. Do not add ad hoc SVG icons in page components when a lucide icon exists.
- Do not mix icon libraries, text symbols, ad hoc SVGs, and different stroke weights on one page.
- Icons should feel simple, modern, and operational; they should avoid retro grid styling.

## Brand Mark

The brand mark and browser tab icon should stay visually aligned. Update the app chrome source, [../../../public/favicon.svg](../../../public/favicon.svg), relevant tests, and product visual rules in the same change when the mark changes.

## Asset Sources

SVG, PNG, generated bitmap assets, or external icon sources can be used only when:

- The visual style matches the current system.
- File names are semantic.
- Licensing is traceable.
- Colors can be token-controlled or reliably theme-compatible.

## Decorations

Decorations are optional and quiet, such as low-noise grid backgrounds, hairline traces, or subtle product-preview structure.

Rules:

- Decoration carries no business meaning.
- Decoration cannot overlap text or controls.
- Decoration cannot create scroll or responsive problems.
- Console pages should use minimal decoration.

## Images

When a page needs to prove product capability, use real UI or credible UI simulation. Do not use abstract illustration where the user needs to understand the product.
