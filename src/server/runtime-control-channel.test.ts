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

  it("marks a registered device offline when its socket disconnects", () => {
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
      lastError: "socket closed",
    });
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
