import { describe, expect, it } from "vitest";
import { resolveLorumeAppMode } from "./app-mode";

describe("Lorume app mode", () => {
  it("defaults to the production permission profile", () => {
    expect(resolveLorumeAppMode()).toBe("production");
  });

  it("supports explicit development and agent profiles", () => {
    expect(resolveLorumeAppMode("development")).toBe("development");
    expect(resolveLorumeAppMode("dev")).toBe("development");
    expect(resolveLorumeAppMode("agent")).toBe("agent");
  });

  it("defaults unknown profile values to production", () => {
    expect(resolveLorumeAppMode("staging")).toBe("production");
    expect(resolveLorumeAppMode("custom")).toBe("production");
  });
});
