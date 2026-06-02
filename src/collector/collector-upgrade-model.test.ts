import { describe, expect, it } from "vitest";
import {
  collectorUpgradeStages,
  compareCollectorVersions,
  isAllowedCollectorPackageFile,
  normalizeCollectorPackageManifest,
  redactCollectorUpgradeMessage,
} from "./collector-upgrade-model";

describe("collector upgrade model", () => {
  it("accepts only fixed collector package files", () => {
    expect(isAllowedCollectorPackageFile("lorume-device-collector.mjs")).toBe(true);
    expect(isAllowedCollectorPackageFile("../config.json")).toBe(false);
    expect(isAllowedCollectorPackageFile("config.json")).toBe(false);
  });

  it("normalizes a valid package manifest", () => {
    const manifest = normalizeCollectorPackageManifest({
      schemaVersion: "collector-package-v1",
      version: "0.1.2",
      createdAt: "2026-06-02T00:00:00.000Z",
      minUpgradeProtocolVersion: 1,
      files: [{
        fileName: "lorume-device-collector.mjs",
        path: "lorume-device-collector.mjs",
        mode: "0755",
        sha256: "a".repeat(64),
        bytes: 123,
      }],
    });

    expect(manifest?.version).toBe("0.1.2");
  });

  it("rejects unsafe manifest file paths", () => {
    expect(normalizeCollectorPackageManifest({
      schemaVersion: "collector-package-v1",
      version: "0.1.2",
      createdAt: "2026-06-02T00:00:00.000Z",
      minUpgradeProtocolVersion: 1,
      files: [{
        fileName: "lorume-device-collector.mjs",
        path: "../lorume-device-collector.mjs",
        mode: "0755",
        sha256: "a".repeat(64),
        bytes: 123,
      }],
    })).toBeNull();
  });

  it("orders collector versions by numeric segments", () => {
    expect(compareCollectorVersions("0.1.2", "0.1.0")).toBeGreaterThan(0);
    expect(compareCollectorVersions("0.1.10", "0.1.2")).toBeGreaterThan(0);
    expect(compareCollectorVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("defines the fixed progress stage list", () => {
    expect(collectorUpgradeStages).toContain("restart_pending");
    expect(collectorUpgradeStages).toContain("rolled_back");
  });

  it("redacts secret-bearing progress fields", () => {
    expect(redactCollectorUpgradeMessage({
      deviceToken: "secret",
      nested: { authorization: "Bearer secret" },
      message: "failed",
    })).toEqual({
      deviceToken: "[redacted]",
      nested: { authorization: "[redacted]" },
      message: "failed",
    });
  });
});
