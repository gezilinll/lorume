import { describe, expect, it } from "vitest";
import { validateDevicePackageVersionState } from "./check-device-package-version.mjs";

describe("device package version guard", () => {
  it("rejects collector or CLI package changes without a version bump", () => {
    const result = validateDevicePackageVersionState({
      baseVersions: { packageVersion: "0.1.0" },
      changedFiles: ["scripts/lorume.mjs"],
      currentVersions: {
        collectorScriptVersion: "0.1.0",
        packageLockPackageVersion: "0.1.0",
        packageLockRootVersion: "0.1.0",
        packageVersion: "0.1.0",
        runtimeAdaptersVersion: "0.1.0",
      },
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join("\n")).toContain("device package version must increase");
  });

  it("accepts collector or CLI package changes with a consistent higher version", () => {
    const result = validateDevicePackageVersionState({
      baseVersions: { packageVersion: "0.1.0" },
      changedFiles: ["scripts/lorume-device-collector.mjs"],
      currentVersions: {
        collectorScriptVersion: "0.1.1",
        packageLockPackageVersion: "0.1.1",
        packageLockRootVersion: "0.1.1",
        packageVersion: "0.1.1",
        runtimeAdaptersVersion: "0.1.1",
      },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects inconsistent device package version sources", () => {
    const result = validateDevicePackageVersionState({
      baseVersions: { packageVersion: "0.1.0" },
      changedFiles: [],
      currentVersions: {
        collectorScriptVersion: "0.1.1",
        packageLockPackageVersion: "0.1.0",
        packageLockRootVersion: "0.1.1",
        packageVersion: "0.1.1",
        runtimeAdaptersVersion: "0.1.1",
      },
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join("\n")).toContain("package-lock package version");
  });
});
