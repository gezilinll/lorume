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
  "docs/product/runtime-work-state-probe.md"
  "docs/product/runtime-listening-acceptance-spec.md"
  "docs/product/backend-service-spec.md"
  "docs/product/cli-device-capability-spec.md"
  "docs/product/agent-skill-probing-spec.md"
  "docs/product/auth-and-access-spec.md"
  "playwright.config.ts"
  "e2e/db.ts"
  "e2e/runtime-fleet.spec.ts"
  "e2e/runtime-work-board.spec.ts"
  "src/catalog/catalog-object.ts"
  "src/catalog/index.ts"
  "src/console/ConsoleUtilityDrawer.tsx"
  "src/console/ConsoleUtilityDrawer.test.tsx"
  "src/settings/OrganizationSettingsPage.tsx"
  "src/runtime/runtime-inventory-query.ts"
  "src/runtime/runtime-normalize.ts"
  "src/backend/backend-server.ts"
  "src/server/runtime-inventory-store.ts"
  "src/server/postgres-store.ts"
  "src/server/runtime-http-api-postgres.test.ts"
  "src/test/postgres.ts"
  "db/migrations/0001_backend_core.sql"
  "scripts/db-migrate.mjs"
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
    Path("docs/product/runtime-work-state-probe.md"),
    Path("docs/product/runtime-listening-acceptance-spec.md"),
    Path("docs/product/backend-service-spec.md"),
    Path("docs/product/cli-device-capability-spec.md"),
    Path("docs/product/agent-skill-probing-spec.md"),
    Path("docs/product/auth-and-access-spec.md"),
]

problems = []
link_pattern = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
forbidden_phrases = [
    ("docs/product/cli-device-capability-spec.md", "回传命令状态", "collector must not describe backend command result reporting"),
    ("docs/product/cli-device-capability-spec.md", "后端下发的授权 context", "connector status context is explicit local/test input, not backend-triggered collection"),
]

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

if problems:
    print("check:repo: Markdown link check failed", file=sys.stderr)
    for problem in problems:
        print(f"- {problem}", file=sys.stderr)
    sys.exit(1)
PY

echo "check:repo: ok"
