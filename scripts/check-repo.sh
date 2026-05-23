#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required_paths=(
  "README.md"
  "AGENTS.md"
  "docs/product/ui-design.md"
  "docs/product/design/README.md"
  "docs/product/design/principles.md"
  "docs/product/design/surface-register.md"
  "docs/product/design/visual-language.md"
  "docs/product/design/tokens.md"
  "docs/product/design/typography.md"
  "docs/product/design/color.md"
  "docs/product/design/layout.md"
  "docs/product/design/components.md"
  "docs/product/design/icons-and-assets.md"
  "docs/product/design/interaction.md"
  "docs/product/design/motion.md"
  "docs/product/design/content-and-terminology.md"
  "docs/product/design/responsive-and-accessibility.md"
  "docs/product/design/page-patterns.md"
  "docs/product/design/review-and-harness.md"
  "docs/product/runtime-device-registration-spec.md"
  "docs/product/runtime-fleet-page-spec.md"
  "docs/product/runtime-openclaw-adapter-spec.md"
  "docs/product/runtime-slock-adapter-spec.md"
  "docs/product/runtime-task-acceptance-spec.md"
  "docs/product/backend-service-spec.md"
  "docs/product/cli-device-capability-spec.md"
  "docs/product/agent-skill-probing-spec.md"
  "docs/product/auth-and-access-spec.md"
  "docs/product/operation-job-runner-spec.md"
  "docs/product/notification-spec.md"
  "playwright.config.ts"
  "e2e/db.ts"
  "e2e/runtime-fleet.spec.ts"
  "e2e/runtime-work-board.spec.ts"
  "src/catalog/catalog-object.ts"
  "src/catalog/index.ts"
  "src/console/ConsoleUtilityDrawer.tsx"
  "src/console/ConsoleUtilityDrawer.test.tsx"
  "src/settings/OrganizationSettingsPage.tsx"
  "src/runtime/runtime-fleet-query.ts"
  "src/runtime/runtime-model.ts"
  "src/backend/backend-server.ts"
  "src/server/runtime-device-state-store.ts"
  "src/server/postgres-store.ts"
  "src/server/runtime-http-api-postgres.test.ts"
  "src/test/postgres.ts"
  "db/schema.sql"
  "scripts/db-setup.mjs"
  "scripts/check-commit-message.mjs"
  "scripts/check-commit-message.test.mjs"
  "scripts/dev-e2e.ts"
  "scripts/lorume.mjs"
  "scripts/lorume-device-collector.mjs"
  "scripts/install-device-collector.sh"
  "fixtures/runtime/collector-snapshot.sample.json"
  "docs/product/agent-network-runtime-panorama.png"
  "docs/product/agent-network-build-objects.png"
  "assets/product-ui/01-command-center.png"
  ".githooks/commit-msg"
)

for path in "${required_paths[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "check:repo: missing required path: $path" >&2
    exit 1
  fi
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "check:repo: python3 is required for Markdown link checks" >&2
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
import re
import sys
import urllib.parse

root = Path.cwd().resolve()
markdown_files = [
    Path("README.md"),
    Path("AGENTS.md"),
    Path("docs/product/ui-design.md"),
    Path("docs/product/design/README.md"),
    Path("docs/product/design/principles.md"),
    Path("docs/product/design/surface-register.md"),
    Path("docs/product/design/visual-language.md"),
    Path("docs/product/design/tokens.md"),
    Path("docs/product/design/typography.md"),
    Path("docs/product/design/color.md"),
    Path("docs/product/design/layout.md"),
    Path("docs/product/design/components.md"),
    Path("docs/product/design/icons-and-assets.md"),
    Path("docs/product/design/interaction.md"),
    Path("docs/product/design/motion.md"),
    Path("docs/product/design/content-and-terminology.md"),
    Path("docs/product/design/responsive-and-accessibility.md"),
    Path("docs/product/design/page-patterns.md"),
    Path("docs/product/design/review-and-harness.md"),
    Path("docs/product/runtime-device-registration-spec.md"),
    Path("docs/product/runtime-fleet-page-spec.md"),
    Path("docs/product/runtime-openclaw-adapter-spec.md"),
    Path("docs/product/runtime-slock-adapter-spec.md"),
    Path("docs/product/runtime-task-acceptance-spec.md"),
    Path("docs/product/backend-service-spec.md"),
    Path("docs/product/cli-device-capability-spec.md"),
    Path("docs/product/agent-skill-probing-spec.md"),
    Path("docs/product/auth-and-access-spec.md"),
    Path("docs/product/operation-job-runner-spec.md"),
    Path("docs/product/notification-spec.md"),
]

problems = []
link_pattern = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
forbidden_phrases = [
    ("docs/product/cli-device-capability-spec.md", "回传命令状态", "collector must not describe backend command result reporting"),
    ("docs/product/cli-device-capability-spec.md", "后端下发的授权 context", "connector status context is explicit local/test input, not backend-triggered collection"),
    ("docs/product/runtime-device-registration-spec.md", "展示名", "Device must not document a collected display name"),
    ("docs/product/runtime-device-registration-spec.md", "connectionMode", "Device must not document collected connectionMode"),
    ("docs/product/runtime-device-registration-spec.md", "Runtime 不可达或设备", "Device status must not roll up runtime health"),
    ("AGENTS.md", "OpenClaw-first", "OpenClaw-first is an implementation phase, not a durable root rule"),
    ("README.md", "OpenClaw-first", "README should stay business-facing and avoid temporary phase labels"),
    ("docs/product/runtime-fleet-page-spec.md", "OpenClaw-first", "page specs should describe backend data consumption, not temporary adapter phases"),
    ("docs/product/runtime-device-registration-spec.md", "OpenClaw-first", "device registration should document adapter allowlists, not temporary phase labels"),
    ("docs/product/cli-device-capability-spec.md", "OpenClaw-first", "CLI spec should document adapter allowlists, not temporary phase labels"),
    ("docs/product/notification-spec.md", "Inventory 采集失败", "notifications must use current device_state terminology"),
    ("docs/product/notification-spec.md", "Work-state 采集失败", "notifications must use current Task/device_state terminology"),
    ("docs/product/notification-spec.md", "人工触发的刷新、迁移或下发完成", "backend-triggered device refresh/downlink is not current behavior"),
    ("docs/product/notification-spec.md", "Agent Skill 探测请求", "backend-triggered probe requests are not current behavior"),
    ("docs/product/auth-and-access-spec.md", "所有新规则进入 spec、AGENTS 和 harness", "repo-wide rule placement belongs in AGENTS.md, not auth spec"),
    ("docs/product/design/components.md", "Runtime Fleet asset status badges use only `工作中`", "Runtime Fleet asset statuses must be syncing/online/offline/error"),
    ("docs/product/design/page-patterns.md", "object status: `工作中`", "Runtime Fleet object statuses must be syncing/online/offline/error"),
    ("docs/product/runtime-device-registration-spec.md", "source?: {", "Task provenance must use adapter.kind, not source"),
    ("docs/product/runtime-openclaw-adapter-spec.md", "source?: {", "Task provenance must use adapter.kind, not source"),
    ("docs/product/runtime-slock-adapter-spec.md", "source.kind", "Task provenance must use adapter.kind, not source.kind"),
    ("docs/product/runtime-slock-adapter-spec.md", "channel.name", "Task channel identity belongs in channel.kind; conversation title belongs in conversation.title"),
]

if Path("docs/product/runtime-task-probe.md").exists():
    problems.append("docs/product/runtime-task-probe.md: stale filename; use docs/product/runtime-openclaw-adapter-spec.md")

plan_docs = sorted(path.as_posix() for path in Path("docs/superpowers/plans").glob("*.md"))
if plan_docs:
    problems.append(
        "docs/superpowers/plans: process plans must not be committed as durable docs: "
        + ", ".join(plan_docs)
    )

for md_path in markdown_files:
    text = md_path.read_text(encoding="utf-8")
    for forbidden_path, phrase, reason in forbidden_phrases:
        if md_path.as_posix() == forbidden_path and phrase in text:
            problems.append(f"{md_path}: forbidden outdated wording `{phrase}` ({reason})")
    for match in link_pattern.finditer(text):
        raw_target = match.group(1).strip()
        if not raw_target or raw_target.startswith(("#", "http://", "https://", "mailto:")):
            continue

        target = raw_target.split("#", 1)[0].strip()
        if target.startswith("<") and target.endswith(">"):
            target = target[1:-1]
        if not target:
            continue

        target = urllib.parse.unquote(target)
        resolved = (root / md_path.parent / target).resolve()

        try:
            resolved.relative_to(root)
        except ValueError:
            problems.append(f"{md_path}: link escapes repository: {raw_target}")
            continue

        if not resolved.exists():
            display = resolved.relative_to(root)
            problems.append(f"{md_path}: missing link target {raw_target} -> {display}")

runtime_device_spec = Path("docs/product/runtime-device-registration-spec.md").read_text(encoding="utf-8")
expected_runtime_kind = 'export type RuntimeKind = "openclaw";'
if expected_runtime_kind not in runtime_device_spec:
    problems.append("docs/product/runtime-device-registration-spec.md: RuntimeKind must list only currently implemented runtime kinds")

if "claude_code" in runtime_device_spec:
    problems.append("docs/product/runtime-device-registration-spec.md: claude_code must not be a supported RuntimeKind")

typescript_blocks = re.findall(r"```ts\n(.*?)\n```", runtime_device_spec, re.S)

def code_block_containing(marker):
    for block in typescript_blocks:
        if marker in block:
            return block
    problems.append(f"docs/product/runtime-device-registration-spec.md: missing TypeScript block `{marker}`")
    return ""

runtime_interface = code_block_containing("export interface Runtime")
forbidden_runtime_fields = ["endpoint", "capabilities", "sourceRefs"]
for field in forbidden_runtime_fields:
    if field in runtime_interface:
        problems.append(f"docs/product/runtime-device-registration-spec.md: Runtime product model must not expose `{field}`")

agent_interface = code_block_containing("export interface Agent")
forbidden_agent_fields = ["origin", "sourceRefs", "load"]
for field in forbidden_agent_fields:
    if field in agent_interface:
        problems.append(f"docs/product/runtime-device-registration-spec.md: Agent product model must not expose `{field}`")

task_interface = code_block_containing("export interface Task")
if "runtimeId" in task_interface:
    problems.append("docs/product/runtime-device-registration-spec.md: Task product model must not expose runtimeId")
if "lastRun" in task_interface:
    problems.append("docs/product/runtime-device-registration-spec.md: Task product model must not expose lastRun")

if problems:
    print("check:repo: Markdown link check failed", file=sys.stderr)
    for problem in problems:
        print(f"- {problem}", file=sys.stderr)
    sys.exit(1)
PY

echo "check:repo: ok"
