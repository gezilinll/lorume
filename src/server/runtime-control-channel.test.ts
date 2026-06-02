import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeControlChannel, type RuntimeControlSocket } from "./runtime-control-channel";
import { createRuntimeDeviceStateStore } from "./runtime-device-state-store";

class MemorySocket implements RuntimeControlSocket {
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

describe("runtime control channel", () => {
  it("registers a device through hello and updates heartbeat state", () => {
    const store = createStore();
    const currentTime = new Date("2026-05-08T08:00:00.000Z");
    const channel = createRuntimeControlChannel({
      store,
      now: () => currentTime,
    });
    const socket = new MemorySocket();

    channel.attach(socket);
    channel.receive(socket, JSON.stringify({
      type: "hello",
      deviceId: "fixture-mac",
      collectorVersion: "0.1.0",
      hostname: "fixture-mac.local",
    }));

    expect(store.readDeviceConnection("fixture-mac", currentTime)).toMatchObject({
      deviceId: "fixture-mac",
      status: "online",
      collectorVersion: "0.1.0",
      hostname: "fixture-mac.local",
    });
    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "hello.ack", deviceId: "fixture-mac" }));

    channel.receive(socket, JSON.stringify({
      type: "heartbeat",
      deviceId: "fixture-mac",
      collectorVersion: "0.1.0",
      summary: { activeTasks: 2 },
    }));

    expect(store.readDeviceConnection("fixture-mac", currentTime)).toMatchObject({
      status: "online",
      lastHeartbeatAt: "2026-05-08T08:00:00.000Z",
      summary: { activeTasks: 2 },
    });
  });

  it("records collector upgrade capability from hello and heartbeat", () => {
    const store = createStore();
    const currentTime = new Date("2026-06-02T08:00:00.000Z");
    const channel = createRuntimeControlChannel({
      store,
      now: () => currentTime,
    });
    const socket = new MemorySocket();

    channel.attach(socket);
    channel.receive(socket, JSON.stringify({
      type: "hello",
      deviceId: "fixture-mac",
      collectorVersion: "0.1.1",
      upgrade: {
        installPath: "/Users/example/.lorume/collector",
        protocolVersion: 1,
        supported: true,
      },
    }));

    expect(store.readDeviceConnection("fixture-mac", currentTime)).toMatchObject({
      collectorUpgrade: {
        installPath: "/Users/example/.lorume/collector",
        protocolVersion: 1,
        supported: true,
      },
      collectorVersion: "0.1.1",
    });

    channel.receive(socket, JSON.stringify({
      type: "heartbeat",
      deviceId: "fixture-mac",
      collectorVersion: "0.1.2",
      upgrade: {
        lastUpgradeJobId: "opjob_upgrade",
        lastUpgradeStatus: "succeeded",
        protocolVersion: 1,
        supported: true,
      },
    }));

    expect(store.readDeviceConnection("fixture-mac", currentTime)).toMatchObject({
      collectorUpgrade: {
        lastUpgradeJobId: "opjob_upgrade",
        lastUpgradeStatus: "succeeded",
        protocolVersion: 1,
        supported: true,
      },
      collectorVersion: "0.1.2",
    });
  });

  it("sends a collector upgrade request only to the target connected device", () => {
    const store = createStore();
    const currentTime = new Date("2026-06-02T08:30:00.000Z");
    const channel = createRuntimeControlChannel({
      store,
      now: () => currentTime,
    });
    const socket = new MemorySocket();

    channel.attach(socket);
    channel.receive(socket, JSON.stringify({
      type: "hello",
      deviceId: "fixture-mac",
      upgrade: { protocolVersion: 1, supported: true },
    }));

    const sent = channel.sendCollectorUpgradeRequest({
      currentVersion: "0.1.0",
      deadlineAt: "2026-06-02T08:35:00.000Z",
      deviceId: "fixture-mac",
      jobId: "opjob_upgrade",
      manifestUrl: "https://lorume.test/api/device-collector/manifest.json",
      nonce: "upgrade_nonce",
      operationId: "op_upgrade",
      packageBaseUrl: "https://lorume.test/api/device-collector/files",
      protocolVersion: 1,
      targetVersion: "0.1.2",
    });
    const missing = channel.sendCollectorUpgradeRequest({
      currentVersion: "0.1.0",
      deadlineAt: "2026-06-02T08:35:00.000Z",
      deviceId: "offline-device",
      jobId: "opjob_missing",
      manifestUrl: "https://lorume.test/api/device-collector/manifest.json",
      nonce: "upgrade_nonce",
      operationId: "op_missing",
      packageBaseUrl: "https://lorume.test/api/device-collector/files",
      protocolVersion: 1,
      targetVersion: "0.1.2",
    });

    expect(sent).toBe(true);
    expect(missing).toBe(false);
    expect(socket.sent).toContainEqual(expect.objectContaining({
      currentVersion: "0.1.0",
      deviceId: "fixture-mac",
      jobId: "opjob_upgrade",
      manifestUrl: "https://lorume.test/api/device-collector/manifest.json",
      nonce: "upgrade_nonce",
      operationId: "op_upgrade",
      packageBaseUrl: "https://lorume.test/api/device-collector/files",
      protocolVersion: 1,
      sentAt: "2026-06-02T08:30:00.000Z",
      targetVersion: "0.1.2",
      type: "collector.upgrade.request",
    }));
  });

  it("validates and routes collector upgrade progress", () => {
    const store = createStore();
    const progressMessages: unknown[] = [];
    const channel = createRuntimeControlChannel({
      onCollectorUpgradeProgress: (message) => {
        progressMessages.push(message);
      },
      store,
      now: () => new Date("2026-06-02T09:00:00.000Z"),
    });
    const socket = new MemorySocket();

    channel.attach(socket);
    channel.receive(socket, JSON.stringify({ type: "hello", deviceId: "fixture-mac" }));
    channel.receive(socket, JSON.stringify({
      type: "collector.upgrade.progress",
      protocolVersion: 1,
      operationId: "op_upgrade",
      jobId: "opjob_upgrade",
      deviceId: "fixture-mac",
      nonce: "upgrade_nonce",
      stage: "downloading",
      status: "running",
      currentVersion: "0.1.0",
      targetVersion: "0.1.2",
      message: "Downloading collector package",
      observedAt: "2026-06-02T09:00:01.000Z",
    }));

    expect(progressMessages).toEqual([
      expect.objectContaining({
        currentVersion: "0.1.0",
        deviceId: "fixture-mac",
        jobId: "opjob_upgrade",
        message: "Downloading collector package",
        nonce: "upgrade_nonce",
        operationId: "op_upgrade",
        stage: "downloading",
        status: "running",
        targetVersion: "0.1.2",
      }),
    ]);
  });

  it("rejects invalid collector upgrade progress without routing it", () => {
    const store = createStore();
    const progressMessages: unknown[] = [];
    const channel = createRuntimeControlChannel({
      onCollectorUpgradeProgress: (message) => {
        progressMessages.push(message);
      },
      store,
      now: () => new Date("2026-06-02T09:30:00.000Z"),
    });
    const socket = new MemorySocket();

    channel.attach(socket);
    channel.receive(socket, JSON.stringify({ type: "hello", deviceId: "fixture-mac" }));
    channel.receive(socket, JSON.stringify({
      type: "collector.upgrade.progress",
      protocolVersion: 1,
      operationId: "op_upgrade",
      jobId: "opjob_upgrade",
      deviceId: "other-device",
      nonce: "upgrade_nonce",
      stage: "shell",
      status: "running",
    }));

    expect(progressMessages).toEqual([]);
    expect(socket.sent).toContainEqual(expect.objectContaining({
      error: "invalid collector upgrade progress",
      type: "error",
    }));
  });

  it("marks a registered device offline without recording ordinary disconnects as control errors", () => {
    const store = createStore();
    const channel = createRuntimeControlChannel({
      store,
      now: () => new Date("2026-05-08T08:00:00.000Z"),
    });
    const socket = new MemorySocket();

    channel.attach(socket);
    channel.receive(socket, JSON.stringify({ type: "hello", deviceId: "fixture-mac" }));
    channel.detach(socket, "socket closed");

    expect(store.readDeviceConnection("fixture-mac")).toMatchObject({
      deviceId: "fixture-mac",
      status: "offline",
    });
    expect(store.readDeviceConnection("fixture-mac")?.lastError).toBeUndefined();
  });

  it("clears a previous transient control error after a later successful heartbeat", () => {
    const store = createStore();
    const currentTime = new Date("2026-05-08T08:00:00.000Z");
    const channel = createRuntimeControlChannel({
      store,
      now: () => currentTime,
    });
    const socket = new MemorySocket();

    store.writeDeviceConnection({
      deviceId: "fixture-mac",
      status: "offline",
      lastError: "socket closed",
      lastHeartbeatAt: "2026-05-08T07:59:00.000Z",
    });

    channel.attach(socket);
    channel.receive(socket, JSON.stringify({ type: "heartbeat", deviceId: "fixture-mac" }));

    expect(store.readDeviceConnection("fixture-mac", currentTime)).toMatchObject({
      deviceId: "fixture-mac",
      status: "online",
      lastHeartbeatAt: "2026-05-08T08:00:00.000Z",
    });
    expect(store.readDeviceConnection("fixture-mac", currentTime)?.lastError).toBeUndefined();
  });

  it("reports unsupported control messages without changing connection state", () => {
    const store = createStore();
    const currentTime = new Date("2026-05-08T08:00:00.000Z");
    const channel = createRuntimeControlChannel({
      store,
      now: () => currentTime,
    });
    const socket = new MemorySocket();

    channel.attach(socket);
    channel.receive(socket, JSON.stringify({ type: "hello", deviceId: "fixture-mac" }));
    channel.receive(socket, JSON.stringify({ type: "unknown.message", deviceId: "fixture-mac" }));

    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: "error",
      error: "unsupported message type: unknown.message",
    }));
    expect(store.readDeviceConnection("fixture-mac", currentTime)).toMatchObject({
      deviceId: "fixture-mac",
      status: "online",
    });
  });
});

function createStore() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-control-store-"));
  return createRuntimeDeviceStateStore({
    snapshotPath: path.join(dataDir, "latest.json"),
    staleAfterMs: 24 * 60 * 60 * 1000,
  });
}
