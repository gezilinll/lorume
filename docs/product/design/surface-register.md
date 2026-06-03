# Surface Register

Surface Register defines page types, visual intensity, and experience boundaries. New pages must be classified here before visual and interaction work lands.

## Surface Types

| Surface | Pages | Role | Visual Intensity |
|---|---|---|---|
| Brand Surface | `/` | Explain Lorume value and direction | High |
| Identity Surface | `/login`, `/invite/:token` | Login, organization join, identity recovery | Medium-high |
| Console Surface | `/runtime`, `/runs`, `/scheduled-tasks`, `/skills`, `/agent-dashboard`, `/settings`; `/operations` and `/notifications` as utility drawer routes | Daily management, inspection, filtering, triage | Medium |

## Brand Surface

Brand Surface can use stronger composition, larger type, and a richer product preview. It must quickly explain:

- What Lorume manages.
- What is currently implemented.
- Whether the user should log in or inspect an implemented Console route.

Brand Surface cannot use unavailable modules as CTA and cannot replace product signal with empty atmosphere.

## Identity Surface

Identity Surface shares the same shadcn/ui and Tailwind v4 system but focuses a single task:

- Enter email.
- Send verification code.
- Enter verification code.
- Create organization or join invited organization.

Identity Surface may show a compact operations preview, but errors, success, loading, expired invitation, and permission states must stay clear.

## Console Surface

Console Surface prioritizes operating efficiency:

- Navigation is stable and exposes only implemented pages.
- Filters are compact and content-width aware.
- Lists, boards, and detail inspectors prioritize readability.
- Summary rails and badges provide scan anchors without color noise.
- Task and notification drawers belong to top-right Console chrome.

Console Surface long body text, task titles, tables, cards, and details use readable Sans with selective Mono for technical values.

## Cross-Surface Rules

- All surfaces share tokens, logo, icon entry points, and semantic state colors.
- Surfaces can vary density and preview richness, not brand identity.
- If one component needs different strength across surfaces, express it through variants or tokens, not page-local hardcoding.
