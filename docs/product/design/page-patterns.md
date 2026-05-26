# Page Patterns

Page specs define the visual, content, and interaction boundaries for current surfaces. Add new pages here before implementation.

## Home

Purpose: Explain Lorume as an Agent Network control plane and show implemented Runtime Fleet, Runs, Organization Settings, and utility drawer capabilities.

Rules:

- First viewport must show both the value proposition and a concrete product preview.
- The preview must contain real current product objects such as Runtime, Agent, Runs, alerts, tasks, or notifications.
- CTA links only point to implemented paths.
- Do not expose future modules as clickable product UI.
- Avoid giant empty panels, decorative-only gradients, or abstract hero art.

## Login

Purpose: Email-code login.

Rules:

- The page focuses one identity task.
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

Purpose: View Device, Runtime, Agent, recent sync, ownership, and one clear operating status.

Rules:

- Runtime and Channel are separate concepts.
- Runtime Fleet does not provide Channel filtering.
- Availability and operating evidence use Lorume-owned semantics, but the page exposes one user-facing object status: `同步中`、`在线`、`离线`、`异常`.
- The layout exposes counts in the top workbar, then Device, Runtime, and Agent lists plus a sticky detail inspector. It does not repeat body-level metric cards, page explanations, or secondary title blocks.
- The refresh action lives in the top workbar as the final icon. Runtime Fleet should not render a separate page-header refresh button.
- The left navigation stays fixed and keeps the identity entry at the bottom of the viewport.
- Desktop layouts keep the selected detail inspector visible while the main content scrolls.
- Agent Skill probing appears as a compact row-level action with read-only metadata; it does not become a standalone page, editor, import flow, or migration wizard.
- Device, Runtime, and Agent details use the same section rhythm: overview, basic facts, status, ownership, and optional local paths.
- Copying an object ID uses toast feedback; the detail panel should not grow a temporary copied row.
- Collection failures, adapter exceptions, and unusable payloads fold into `异常`; details stay traceable in ingestion records, structured logs, notifications, or future diagnostics without dumping debug data into UI.

## Runs

Purpose: View conversation Tasks, creator, Channel, conversation/group, message summary, current stage, and selected details.

Rules:

- The board only shows real work items.
- Do not render listener status, raw execution records, adapter evidence, or debugging notes as task cards.
- Runtime and Channel filters are separate.
- Channel options come from backend facets, not from currently loaded rows.
- Time range uses explicit start/end controls.
- Status filtering tabs are not shown. Status is represented by six board lanes: `待处理`、`进行中`、`待验收`、`已完成`、`需关注`、`已取消`; `需关注` groups `failed` and `unknown`.
- Lanes use a compact project-board width and fill the available viewport height. The current desktop target is approximately `17.5rem` per lane. The Runs page itself must avoid body-level vertical scrolling in the primary desktop view; the board owns horizontal scrolling at its bottom edge, and each lane owns its own vertical scrolling. Empty lanes show inline muted text on the lane background rather than a nested empty card. Lane backgrounds use the shared `--runs-lane-*` tokens with low saturation; no single normal workflow lane should visually dominate the board.
- Task cards follow the Mail preview pattern with a fixed four-row hierarchy: assignee Agent, `userMessage` truncated to 16 characters, `agentReply` or `暂无 Agent 答复`, then last updated time and the channel pill. Card pills show channel kind only; they do not repeat lane status or conversation/group labels and they never invent an execution-link state. Click opens a detail dialog and immediately returns the card to idle visual state.
- The detail dialog shows only the task fields that currently exist in the Task query model. The header title is a short truncated `userMessage`; the body uses three sections: task information (`发起人`、`承接 Agent`、`更新时间`、`渠道`), user message, and Agent reply. The channel value combines the channel kind and backend-normalized readable conversation/source label when available, such as `DingTalk 小卷和用户支持的同学们` or `Slock #AjisFarm`. It opens centered, keeps Radix DialogContent responsible for positioning, and applies any 3D treatment only to an inner visual card layer. It must stay compact and must not degrade into a raw field list or show execution association, source summary, adapter evidence, or raw IDs.
- Long text wraps or clamps without body-level horizontal scroll.
- Raw IDs, `cid...`, phone numbers, and opaque conversation IDs are not used as conversation names.
- Wide screens use the board as the main surface; there is no persistent selected inspector on the right.

## Operations Utility Drawer

Purpose: View asynchronous Operation / Job status, resource, target, errors, and recent updates.

Rules:

- Opens from the top-right `任务` button; `/operations` is a deep-link drawer route.
- It is not a primary nav page and has no internal task/notification tab switcher.
- Drawer width is narrow by default and uses a vertical list. Selecting an operation opens a detail dialog.
- The overlay dims without background blur.
- Reads organization-scoped data; no organization means no API request.
- Does not show backend raw payload, tokens, device secrets, or debug fields.
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
