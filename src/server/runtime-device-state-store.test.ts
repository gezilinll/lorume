import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeDeviceStateStore, validateRuntimeDeviceStateSnapshot, type RuntimeDeviceStateSnapshot } from "./runtime-device-state-store";

const fixture: RuntimeDeviceStateSnapshot = {
  collectedAt: "2026-05-21T10:00:00.000Z",
  device: {
    id: "fixture-mac",
    hostname: "fixture-mac.local",
    os: "darwin",
  },
  runtimes: [{
    id: "fixture-mac:runtime:openclaw",
    deviceId: "fixture-mac",
    kind: "openclaw",
    name: "OpenClaw Gateway",
    collectionStatus: "online",
  }],
  agents: [{
    id: "fixture-mac:runtime:openclaw:agent:main",
    runtimeId: "fixture-mac:runtime:openclaw",
    name: "main",
    collectionStatus: "online",
  }],
  tasks: [],
};

describe("runtime device-state store", () => {
  it("writes and reads the latest device_state snapshot", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-runtime-store-"));
    const store = createRuntimeDeviceStateStore({
      snapshotPath: path.join(dataDir, "latest.json"),
    });
    expect(store.readLatestSnapshot()).toBeNull();

    store.writeLatestSnapshot(fixture);

    expect(store.readLatestSnapshot()?.device.id).toBe("fixture-mac");
    expect(store.readLatestSnapshot()?.device.hostname).toBe("fixture-mac.local");
  });

  it("rejects malformed snapshots before persistence", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-runtime-store-"));
    const store = createRuntimeDeviceStateStore({
      snapshotPath: path.join(dataDir, "latest.json"),
    });

    expect(validateRuntimeDeviceStateSnapshot({ device: { id: "missing-fields" } })).toBe(false);
    expect(() => store.writeLatestSnapshot({ device: { id: "missing-fields" } })).toThrow(/invalid/i);
  });

  it("tracks device connection freshness separately from the latest snapshot", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-runtime-store-"));
    const store = createRuntimeDeviceStateStore({
      snapshotPath: path.join(dataDir, "latest.json"),
      staleAfterMs: 60_000,
    });

    expect(store.readDeviceConnection("fixture-mac")).toBeNull();

    store.writeDeviceConnection({
      deviceId: "fixture-mac",
      status: "online",
      connectedAt: "2026-05-08T08:00:00.000Z",
      lastHeartbeatAt: "2026-05-08T08:00:10.000Z",
      collectorVersion: "0.1.0",
    });

    expect(store.readDeviceConnection("fixture-mac", new Date("2026-05-08T08:00:30.000Z"))).toMatchObject({
      deviceId: "fixture-mac",
      status: "online",
      collectorVersion: "0.1.0",
    });
    expect(store.readDeviceConnection("fixture-mac", new Date("2026-05-08T08:02:00.000Z"))).toMatchObject({
      deviceId: "fixture-mac",
      status: "stale",
    });

    store.markDeviceDisconnected("fixture-mac", "2026-05-08T08:02:30.000Z", "socket closed");

    expect(store.readDeviceConnection("fixture-mac")).toMatchObject({
      deviceId: "fixture-mac",
      status: "offline",
      lastDisconnectedAt: "2026-05-08T08:02:30.000Z",
    });
    expect(store.readDeviceConnection("fixture-mac")?.lastError).toBeUndefined();
  });

});
