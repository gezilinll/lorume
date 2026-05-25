# shadcn/ui System

Lorume uses shadcn/ui as the frontend design-system foundation. shadcn-generated component files in `src/components/ui/` are owned application code and may be edited when product needs require it, but new primitives should first be installed with the official `shadcn` CLI.

## Setup

- Framework: Vite.
- Styling: Tailwind CSS v4 through `@tailwindcss/vite`.
- Theme: CSS variables in `src/index.css`.
- Preset: `b1FS9kEKH` from `https://ui.shadcn.com/create?preset=b1FS9kEKH`.
- Import alias: `@/*` maps to `./src/*`.
- Utilities: `cn` lives in `src/lib/utils.ts`.

## Component Rules

- Import generated primitives from `@/components/ui/*`.
- Use lucide-react icons for UI icons.
- Use shadcn `Sidebar` for Console navigation.
- Use shadcn `Sheet` for Operations and Notifications drawers.
- Use `Card`, `Table`, `Badge`, `Button`, `Input`, `Field`, `Select`, `DropdownMenu`, `Tabs`, `Tooltip`, `Skeleton`, `Alert`, and `Sonner` before creating app-owned wrappers.
- App-owned wrappers must live outside `src/components/ui/`, for example `src/components/data/StatusBadge.tsx`.

## Theming

`src/index.css` owns shadcn semantic tokens such as `background`, `foreground`, `card`, `primary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `chart-*`, and `sidebar-*`. Product components should consume these through Tailwind utilities such as `bg-background`, `text-foreground`, `border-border`, and `text-muted-foreground`.

## Migration Rule

The legacy `src/ui/Pixel*` primitives and `src/ui/tokens.css` are retired. New work must not import them. Existing imports may remain only until their scheduled migration task removes them.
