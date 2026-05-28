# Lorume

**Lorume is an open-source control plane for operating human-agent teams in production.**

Lorume helps teams manage Agents, Workflows, Skills, worker devices, runtime queues, memory, permissions, approvals, audits, and governance from one place. It is designed for teams that are moving from "one powerful agent on one machine" to a governed Agent Network that can be observed, scaled, and operated like real production infrastructure.

## Why Lorume

AI agents are quickly becoming part of daily operations, but most teams still run them through scattered chat entrypoints, local machines, cron jobs, ad-hoc skills, and tribal knowledge.

Lorume starts from a different premise: production agents need a control plane.

It should be possible to answer:

- Which Agents, Workflows, Skills, and Workers exist?
- Who owns them, who can change them, and what permissions do they have?
- What is running right now, what is queued, and where is it running?
- Which Skill or Tool made a Run fail?
- Which Worker is overloaded or unhealthy?
- Which approvals, audits, policies, and lifecycle rules apply?
- How do we safely create, test, publish, monitor, roll back, and retire agentic work?

## Operating Model

Lorume treats an Agent Network as multiple coordinated paths, not one giant agent:

- **Personal request path**: people or teams start work from personal, team, DingTalk, document, scheduled, or system-event entry points. A Personal Work Agent carries profile, responsibility tags, preference memory, and permission policy. Ambiguous or cross-domain work can be routed through the Semantic Coordinator, then answered by reusable Domain Agents and executed by the Runtime Fabric.
- **Fixed workflow path**: scheduled or event-driven workflows can run directly when their trigger, steps, outputs, and recipients are already known. They reuse Domain Agents and Runtime Fabric without forcing every run through semantic orchestration.
- **Governance feedback path**: quality, permission, stability, cost, and abnormal-output signals flow into governance, escalation, fix/re-run, decision records, and policy or knowledge updates.

The boundary is intentional:

- **Domain Agents** provide domain judgment: definitions, attribution, explanation, and recommendations.
- **Workflows** define fixed triggers, steps, outputs, recipients, retries, and lifecycle.
- **Semantic Coordinator** handles route, plan, escalation, and cross-domain reasoning. It does not dispatch machines.
- **Runtime / Execution Fabric** handles task queue, multi-machine dispatch, concurrency, retry, health checks, capacity, session routing, and failover. It does not decide semantic intent.
- **Registry / Catalog** records metadata such as owner, permissions, inputs, outputs, evals, and lifecycle. It is referenced by runtime, but does not execute work itself.

## What Lorume Manages

Lorume is not a chatbot UI and not a single-agent framework. It is a product layer for managing an Agent Network:

- **Command Center**: global health, running work, queue depth, approvals, alerts, and risk signals.
- **Catalog / Registry**: unified directory for Agents, Workflows, Skills, Tools, Data Sources, Memory, Policies, and Workers.
- **Agent Studio**: create, test, publish, monitor, and roll back Domain Agents.
- **Workflow Studio**: define repeatable business workflows with triggers, steps, approvals, outputs, and schedules.
- **Skill and Tool Capability Visibility**: understand which local capabilities Agents can use, with editing, migration, and rollout guarded behind future specs and harnesses.
- **Worker Fleet**: register and operate distributed M1/ECS/OpenClaw workers with health checks, capacity, sessions, drain, and failover.
- **Run Trace**: inspect each Run from route plan to queue, worker assignment, tool calls, approvals, output, and audit record.
- **People & Access**: manage users, role profiles, responsibility tags, owner slots, permission scopes, and approval chains.
- **Integrations & Resources**: connect OpenClaw, Nowledge, DingTalk, slock.ai, BI, Xingtu, SLS, GitLab, Aetheris CLI, and other systems.
- **Governance Center**: manage approvals, audit logs, policies, cost guard, memory governance, evals, stability, security, and lifecycle.

The current product UI intentionally exposes only the implemented surfaces: public homepage, email-code login, Runtime Fleet, Runs / Work Board, read-only Skill 仓库, and 组织设置. Operations and Notifications are available as top-right utility drawers instead of primary navigation pages. Runtime Fleet links Runtime and Agent rows into the read-only Skill 仓库 for already-collected target-local metadata. Other surfaces above are product direction and are added to navigation only after their page, data path, permissions, and harness exist.

## Core Concepts

| Concept | Meaning |
|---|---|
| **Agent** | A domain reasoning subject that explains, attributes, judges, and recommends. |
| **Workflow** | A repeatable process with a trigger, steps, outputs, recipients, and lifecycle. |
| **Skill** | A reusable capability package, often including instructions, scripts, tests, and tool usage rules. |
| **Tool** | A lower-level executable capability or API integration. |
| **Worker** | A runtime device or process that executes queued work. |
| **Task** | A schedulable execution unit waiting for or assigned to runtime execution. |
| **Run** | A full execution instance with route plan, tasks, logs, outputs, approvals, and audit records. |
| **Governance** | Cross-cutting rules for permission, audit, cost, safety, eval, stability, memory, and lifecycle. |

Every formal object should have at least: `name`, `type`, `purpose`, `owner slot`, `inputs / outputs`, `trigger`, `permission`, `eval`, and `lifecycle`.

## Runtime Terms

`Running Runs` and `Task Queue` intentionally describe different levels:

- **Running Runs** are active end-to-end execution instances that have started and are not yet completed, failed, cancelled, or archived.
- **Task Queue** contains execution units waiting for workers or waiting for concurrency slots.
- **Queue Depth** is the number of queued tasks that have not yet been picked up by a worker.

A single Run may contain multiple Tasks. For example, one Workflow Run may create separate tasks for link parsing, BI query, Xingtu query, report generation, and DingTalk delivery.

## Current Status

Lorume is in product definition and early engineering. The first implemented surfaces are a public homepage, email-code login with organization membership, Runtime Fleet, read-only Skill 仓库 for target-local Skill metadata, a read-only Runs / Work Board for Task visibility, organization settings, and top-right Operations / Notifications utility drawers. These surfaces are backed by the initial TypeScript Catalog Object model, the current `Device / Runtime / Agent / Task` runtime model, target-local Skill probe metadata, a device collector, Postgres-backed Operations and Notifications, a standalone local backend with Postgres-backed query APIs, and an outbound WebSocket device control channel for device connection health.

Runtime and device registration can now complete a development and ECS loop against the current device collector path. The backend has a Postgres-backed service shape, production-like local deployment path, organization-based access, and an initial ECS deployment; backups, monitoring, multi-device orchestration, and execution control are still being built.

The first product design package is available here:

- [Product UI/UX Design](docs/product/ui-design.md)
- [Design Specs](docs/product/design/README.md)
- [Runtime & Device Registration Spec](docs/product/runtime-device-registration-spec.md)
- [Runtime Fleet Page Spec](docs/product/runtime-fleet-page-spec.md)
- [Runtime OpenClaw Adapter Spec](docs/product/runtime-openclaw-adapter-spec.md)
- [Runtime Task Acceptance Spec](docs/product/runtime-task-acceptance-spec.md)
- [Backend Service Spec](docs/product/backend-service-spec.md)
- [CLI Device Capability Spec](docs/product/cli-device-capability-spec.md)
- [Agent Skill Probing Spec](docs/product/agent-skill-probing-spec.md)
- [Notification Spec](docs/product/notification-spec.md)
- [Agent Network Runtime Panorama](docs/product/agent-network-runtime-panorama.png)
- [Agent Network Build Object Map](docs/product/agent-network-build-objects.png)
- [Product UI Assets](assets/product-ui)

## For Contributors

Coding agents and contributors should start from [AGENTS.md](AGENTS.md). That guide contains the current development rules, spec and harness workflow, local commands, and verification expectations.

## Design Preview

![Lorume Command Center](assets/product-ui/01-command-center.png)

## License

MIT
