# Page Patterns

Page specs define the visual, content, and interaction boundaries for current surfaces. Add new pages here before implementation.

## Home

Purpose: Explain Lorume as an Agent Network control plane and show implemented Runtime Fleet, Runs, 定时任务, Skill 仓库, Organization Settings, and utility drawer capabilities.

Rules:

- First viewport must show both the value proposition and a concrete product preview.
- The preview must contain real current product objects such as Runtime, Agent, Runs, alerts, tasks, or notifications.
- CTA links only point to implemented paths.
- Public top navigation is intentionally minimal: the header shows the Lorume mark and a single `登录` action. Protected Console destinations are introduced through the capability cards, not duplicated as header nav.
- The hero uses one primary `进入控制台` CTA. Do not add a secondary Console route CTA beside it.
- Implemented capability cards use a balanced responsive grid with consistent card heights and bottom-aligned actions. Wide desktop may show all current capability cards in one row; medium desktop must avoid a lone orphan card row.
- Capability icons may use the shared brand, cyan, orange, purple, and green accent tokens to keep the public page bright while staying inside the app color system.
- Do not expose future modules as clickable product UI.
- Avoid giant empty panels, decorative-only gradients, or abstract hero art.

## Login

Purpose: Email-code login.

Rules:

- The page focuses one identity task.
- Auth pages expose a small `返回首页` link in the header; this is secondary to the form and must not become a second auth path.
- The operations preview is compact and shows current product concepts, not live organization data.
- Backend session probe errors are surfaced only when unexpected; anonymous probe errors stay quiet.
- Form labels are visible and controls have clear focus/loading/error states.

## Verify Code

Purpose: Verify an emailed login code.

Rules:

- The user sees which email receives the code.
- The code field supports paste and direct correction.
- Back/change-email action is visible but secondary.

## Create Organization

Purpose: Create the first organization when a signed-in user has no organization.

Rules:

- Explain that organization scope owns Device, Runtime, Agent, Skill, and Task state.
- Keep the form short: organization name and slug.
- After creation, return to the intended Console page.

## Invite

Purpose: Join an organization through an invitation link.

Rules:

- Explain the invited organization and email context.
- Do not show raw invitation token.
- Expired, mismatched, already joined, and accepted states need explicit text.

## Runtime Fleet

Purpose: View Device, Runtime, Agent, Task-derived recent activity, ownership, collector version posture, and one clear operating status.

Rules:

- Runtime and Channel are separate concepts.
- Runtime Fleet does not provide Channel filtering.
- Availability and operating evidence use Lorume-owned semantics, but the page exposes one user-facing object status: `同步中`、`在线`、`离线`、`异常`.
- Collector version posture is separate from object status. Device cards and details may show `最新`、`待升级`、`升级中`、`升级失败`、`需手动重装` or `未上报`, but those labels must not replace `同步中`、`在线`、`离线`、`异常`.
- The layout exposes counts in the top workbar, then Device, Runtime, and Agent lists plus a sticky detail inspector. It does not repeat body-level metric cards, page explanations, or secondary title blocks.
- Device uses the `users.html` team-activity rhythm: icon/dot, object title, compact metadata, recent activity, and status badge.
- Runtime and Agent use the `users.html` member-directory rhythm: compact avatar, primary label, secondary metadata, status, Task count, and recent activity. Runtime does not use a separate kind column or repeated kind badge in the directory table.
- Runtime and Agent directory columns are left-aligned. Tail columns such as `Task`, `最近活跃`, and row-level `Skill` actions use stable fixed widths, but headers, numbers, timestamps, and buttons all start from the same left edge within their column.
- `最近活跃` is derived from active Task activity aggregates. It must not fall back to collector sync time.
- The refresh action lives in the top workbar as the final icon. Runtime Fleet should not render a separate page-header refresh button.
- The left navigation stays fixed and keeps one workspace/account identity entry in the sidebar header. The account menu is part of that unified entry, not a separate footer card.
- Desktop layouts keep the selected detail inspector visible while the main content scrolls.
- Runtime and Agent Skill actions appear as compact row-level actions that deep-link to the read-only Skill 仓库. The action column keeps a stable width but has no visible header label, and the button text is `查看 Skill`. They do not become editors, import flows, assignment controls, probe triggers, or migration wizards.
- Collector upgrade is the only Runtime Fleet device control action. It appears from the selected Device detail, creates a `collector_upgrade` Operation, and hands progress/result display to the Operations drawer. It must not expose a raw WebSocket command, shell command, runtime probe, or generic remote control button.
- Device, Runtime, and Agent details use the same section rhythm: overview, basic facts, status, ownership, and optional local paths.
- Copying an object ID uses toast feedback; the detail panel should not grow a temporary copied row.
- Collection failures, adapter exceptions, and unusable payloads fold into `异常`; details stay traceable in ingestion records, structured logs, notifications, or future diagnostics without dumping debug data into UI.
- Devices that do not advertise collector upgrade capability show a concise `需手动重装` posture and keep the organization settings install command as the recovery path.

## Runs

Purpose: View conversation Tasks, creator, Channel, conversation/group, message summary, current stage, and selected details.

Rules:

- The board only shows real work items.
- Do not render listener status, raw execution records, adapter evidence, or debugging notes as task cards.
- Runtime and Channel filters are separate.
- Channel options come from backend facets, not from currently loaded rows.
- Channel filtering is multi-select. The compact filter menu exposes a `渠道` submenu; the submenu opens beside the main menu and uses checkbox items for `全部` plus each channel kind/count. Selecting no specific channel means `全部`.
- Time range uses one Date Picker Range control backed by shadcn Popover + Calendar. It is a first-level control beside search, not nested inside the compact filter popover, and must not split into two datetime inputs.
- Status filtering tabs are not shown. Status is represented by five visible board lanes: `待处理`、`进行中`、`待验收`、`已完成`、`需关注`; `需关注` groups `failed` and `unknown`. `cancelled` remains a valid backend Task status but is hidden from the Runs Kanban visible work set.
- Lanes use the Taskflow Kanban rhythm and fill the available viewport height. The current desktop target is about `235px` per lane. The Runs page itself must avoid body-level vertical scrolling in the primary desktop view; the board owns horizontal scrolling at its bottom edge, and each lane owns its own vertical scrolling. Empty lanes show inline muted text on the lane background rather than a nested empty card. Lane backgrounds use the shared `--runs-lane-*` tokens with low saturation; no single normal workflow lane should visually dominate the board.
- Task cards follow the Taskflow Kanban card pattern: compact chips at the top, short `userMessage` title, `agentReply` or `暂无 Agent 答复`, lightweight Task metadata, footer time, and a thin left status stripe. Card pills show channel kind only; they do not repeat lane status or conversation/group labels and they never invent an execution-link state. Click opens a detail dialog and immediately returns the card to idle visual state.
- The detail dialog shows only the task fields that currently exist in the Task query model. The header title is a short truncated `userMessage`; the body uses three sections: task information (`发起人`、`承接 Agent`、`更新时间`、`渠道`), user message, and Agent reply. The channel value combines the channel kind and backend-normalized readable conversation/source label when available, such as `DingTalk 小卷和用户支持的同学们` or `Slock #AjisFarm`. It opens centered, keeps Radix DialogContent responsible for positioning, and applies any 3D treatment only to an inner visual card layer. It must stay compact and must not degrade into a raw field list or show execution association, source summary, adapter evidence, or raw IDs.
- Long text wraps or clamps without body-level horizontal scroll.
- Raw IDs, `cid...`, phone numbers, and opaque conversation IDs are not used as conversation names.
- Wide screens use the board as the main surface; there is no persistent selected inspector on the right.

## 定时任务

Purpose: View collected Runtime schedule definitions, next-run metadata when available, latest execution status, and grouped scheduled Task history.

Rules:

- The page uses the `data-dense` Console layout tier, the shared top workbar, a compact search/filter surface, a directory table, and a sticky detail inspector.
- It is the only Console page for `taskType=scheduled`; Runs remains conversation-only.
- The table groups multiple scheduled Task executions by stable schedule identity. It shows schedule name, Runtime, Agent, cron expression, timezone, next run when known, latest status, latest time, and execution count as separate scan columns.
- The filter menu follows the Runs compact menu treatment: a single filter button, submenu groups, selected counts, and a reset-all action when any non-search filter is active. Search is a separate first-level input.
- Detail inspector shows the selected schedule definition first, then execution status counts and recent execution history. It does not expose raw adapter evidence, local file paths, command names, or debug payloads.
- Disabled schedules and schedules with `failed` or `unknown` latest execution remain visible and use concise status chips rather than becoming separate alert cards.
- The page is read-only. No create, edit, enable/disable, run-now, retry, delete, or backend-triggered probe controls are allowed.

## Skill 仓库

Purpose: Aggregate already-collected Runtime and Agent Skill metadata into a read-only inventory with filters and an inspector.

Rules:

- The page uses the `data-dense` Console layout tier, the shared top workbar, a compact search/filter surface, a directory table, and a sticky detail inspector.
- It does not render a hero, repeated summary metric cards, or a page-owned title block. Counts live in the top workbar.
- The list follows the Runtime Fleet Agent directory rhythm: avatar, left accent stripe, primary Skill name, short description, Runtime ownership, `Scope`, source, status, compact Agent avatars/count, and latest collection time. The latest collection column keeps enough fixed width for two-line date/time readability.
- `Scope` and source are separate columns. `Runtime`/`Agent` explains capability layer; `系统自带`/`自定义` explains provenance.
- Runtime-scope Skill rows derive their available Agent list from active Agents under the same Runtime. Agent-scope rows use stored Agent ownership. Agent deep links show Runtime common Skills usable by that Agent plus that Agent's own Skills.
- The filter menu follows the Runs compact menu treatment: a single filter button, submenu groups, selected counts, and a reset-all action when any non-search filter is active. Search is a separate first-level input.
- The detail inspector shows basic metadata, derived available Agents, and a compact `查看` action for the selected Skill. Runtime fields display the Runtime name only, because the field label already provides the semantic context.
- The `查看` action opens a read-only detail card. The detail card header shows only the Skill name; it does not repeat the short description, chips, metadata, or available Agents. The card shows `本地路径` when collected and expands `Skill 正文` as the primary reading area.
- Skill 仓库 must not show raw adapter source-path evidence, command names, hidden adapter fields, same-name diagnostics as primary content, edit/import/install/assignment controls, or auxiliary Skill files.
- The page is read-only. No create, import, edit, publish, install, assign, migrate, sync, execute, or backend-triggered probe controls are allowed.

## Operations Utility Drawer

Purpose: View asynchronous Operation / Job status, resource, target, errors, and recent updates.

Rules:

- Opens from the top-right `任务` button; `/operations` is a deep-link drawer route.
- It is not a primary nav page and has no internal task/notification tab switcher.
- Drawer width is narrow by default and uses a vertical list. Selecting an operation opens a detail dialog.
- The overlay dims without background blur.
- Reads organization-scoped data; no organization means no API request.
- Does not show backend raw payload, tokens, device secrets, or debug fields.
- Collector upgrade Operations show Device, current version, target version, stage, progress message, and result. They remain platform operations, not Runs tasks.
- Closing returns to the previous Console context.

## Notifications Utility Drawer

Purpose: View sync, collection, approval, and recovery notification threads.

Rules:

- Opens from the top-right `通知` button; `/notifications` is a deep-link drawer route.
- It is not a primary nav page and has no internal task/notification tab switcher.
- Drawer width is narrow by default and uses a vertical thread list. Selecting a notification opens a detail dialog.
- The overlay dims without background blur.
- Reads organization-scoped data; no organization means no API request.
- Selecting an unread thread marks it as read.
- The drawer is a triage/recovery entry, not a replacement for full logs.

## Organization Settings

Purpose: View current organization, member identity, and create invitation links.

Rules:

- No-organization state points users to create or accept invitation flows.
- Owner/admin can create invitation links; other roles see read-only identity.
- Invitation links display only to the current operator and must not be logged or copied into committed screenshots.
- The top workbar owns page identity; the page body starts with organization controls rather than a separate explanatory header.
