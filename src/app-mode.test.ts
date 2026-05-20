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

  it("keeps legacy auth mode values mapped to safe profiles", () => {
    expect(resolveLorumeAppMode("required")).toBe("production");
    expect(resolveLorumeAppMode("disabled")).toBe("agent");
  });
});
