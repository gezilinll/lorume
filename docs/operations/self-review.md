# Self Review Protocol

Use this protocol when a user asks for `self review`, `自我 Review`, `review 一下`, or asks whether recent work is complete, consistent, or ready. This is broader than UI review: it covers code, docs, specs, harnesses, deployment notes, and product/data boundaries.

The review posture is a code-review posture. Findings come first, ordered by severity, with file and line references when available. If no issues are found, say that clearly and still list residual risks or test gaps.

## Review Inputs

Start by identifying the changed surface:

```sh
git status --short
git diff --name-only
```

Then read the smallest relevant source-of-truth set:

- Always read [../../AGENTS.md](../../AGENTS.md) for repository workflow, current source-of-truth mapping, and harness expectations.
- For UI changes, read [../product/ui-design.md](../product/ui-design.md), [../product/design/README.md](../product/design/README.md), and [../product/design/review-and-harness.md](../product/design/review-and-harness.md).
- For Runtime Fleet / Runs / collector / backend changes, read the matching `docs/product/*-spec.md` listed in `AGENTS.md`.
- For deployment or real-device changes, read [ssh-deployment.md](ssh-deployment.md), [../product/backend-service-spec.md](../product/backend-service-spec.md), and [../product/runtime-device-registration-spec.md](../product/runtime-device-registration-spec.md).
- For auth, operations, notifications, or organization settings, read the matching product spec before judging implementation.

Do not review only the diff if the change affects a product contract. Compare the code against the relevant spec and compare the spec against current code behavior.

## Review Questions

Ask these questions explicitly while reviewing:

- Product model: Does the implementation preserve current Lorume objects and relationships, especially `Device -> Runtime -> Agent -> Task`?
- Data semantics: Is backend/collector normalized data the source of truth, instead of React inventing platform meaning?
- API and persistence: Do API responses, DB schema, stores, and frontend adapters agree on fields, statuses, nullability, pagination, auth, and error behavior?
- UI and content: If UI changed, does it follow the current shadcn/ui, token, page-pattern, density, interaction, and accessibility rules?
- Security and privacy: Are tokens, cookies, SSH keys, platform API keys, device tokens, raw secret-bearing logs, and opaque platform IDs kept out of committed docs, fixtures, tests, and screenshots?
- Docs freshness: Did any wording become stale, especially deployment shape, product object names, adapter allowlists, status labels, routes, or current capabilities?
- Harness coverage: Is there a focused unit/component/e2e/check script that proves the important behavior? If not, is the residual risk called out?
- Deployment safety: Are production checks read-only unless the user explicitly requested mutation, and are local isolated harnesses kept away from production data?
- Scope control: Did the change introduce speculative entities, fake navigation, placeholder capabilities, broad refactors, or parallel UI systems?

## Output Format

Use this structure:

1. Findings, highest severity first:
   - `P0`: data loss, auth bypass, production mutation, secret exposure, service-down risk.
   - `P1`: broken core flow, product/spec mismatch, stale deployment instructions that would mislead operators.
   - `P2`: missing harness, edge-case regression, UI/UX defect with meaningful user impact.
   - `P3`: cleanup, wording drift, minor maintainability issue.
2. Open questions or assumptions.
3. Verification performed and exact commands.
4. Residual risk or test gaps.

Keep summaries short. Do not lead with praise or implementation recap before findings.

## Fix Classification

When review finds a gap, decide where the durable rule belongs:

- `AGENTS.md`: repository-wide agent workflow, source-of-truth mapping, or verification rule.
- `docs/product/*-spec.md`: product/data/API behavior, status semantics, adapter boundary, or acceptance criteria.
- `docs/product/design/`: visual language, component behavior, layout, content, accessibility, or UI review rules.
- `docs/operations/`: deployment, real-device, self-review, or operational runbook behavior.
- Tests/harnesses: any behavior that should be executable evidence.

Do not create long-lived tests that only assert old bugs are absent by matching past wording. Prefer tests that assert the current correct behavior exists.

## Verification Floor

For docs-only review changes, run:

```sh
npm run check:repo
```

For code changes, run the narrowest relevant harness from `AGENTS.md`. Before handoff, commit, or deploy, run `npm run verify` unless the user explicitly narrows the scope and the skipped checks are disclosed.
