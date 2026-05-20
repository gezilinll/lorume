import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("dev e2e server configuration", () => {
  it("keeps internal e2e snapshots away from manual dev snapshot paths", () => {
    const source = readFileSync(path.resolve("scripts/dev-e2e.ts"), "utf8");

    expect(source).toContain("inventorySnapshotPath");
    expect(source).toContain("workStateSnapshotPath");
    expect(source).toContain('path.join(repoRoot, ".lorume", "e2e")');
    expect(source).toContain('path.join(e2eSnapshotRoot, "runtime-inventory", "latest.json")');
    expect(source).toContain('path.join(e2eSnapshotRoot, "runtime-work-state", "latest.json")');
  });

  it("keeps backend-only e2e state isolated from browser and manual dev state", () => {
    const source = readFileSync(path.resolve("scripts/dev-backend-e2e.ts"), "utf8");
    const config = readFileSync(path.resolve("playwright.backend.config.ts"), "utf8");

    expect(source).toContain('path.join(repoRoot, ".lorume", "backend-e2e")');
    expect(source).toContain("lorume_backend_e2e");
    expect(source).toContain("deviceTokenRequired: true");
    expect(config).toContain("runtime-backend-api.spec.ts");
    expect(config).toContain("lorume_backend_e2e");
    expect(config).toContain("process.env.LORUME_E2E_DATABASE_URL");
    expect(readFileSync(path.resolve("playwright.config.ts"), "utf8")).toContain("runtime-backend-api.spec.ts");
  });
});
