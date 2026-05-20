import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fixtureSnapshot from "../../fixtures/runtime/collector-snapshot.sample.json";
import type { RuntimeInventorySnapshot } from "../runtime";
import { createRuntimeControlChannel, type RuntimeControlSocket } from "./runtime-control-channel";
import { createRuntimeHttpApiHandler } from "./runtime-http-api";
import { createRuntimeInventoryStore } from "./runtime-inventory-store";
import { createRuntimeWorkStateStore } from "./runtime-work-state-store";

class MemorySocket implements RuntimeControlSocket {
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("runtime HTTP API", () => {
  it("serves liveness and reports readiness as unavailable without Postgres", async () => {
    const { baseUrl } = await startRuntimeApi();

    const healthResponse = await fetch(`${baseUrl}/healthz`);
    const readyResponse = await fetch(`${baseUrl}/readyz`);

    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({ ok: true });
    expect(readyResponse.status).toBe(503);
    await expect(readyResponse.json()).resolves.toMatchObject({ ok: false, error: "postgres_store_unavailable" });
  });

  it("does not expose legacy latest snapshot APIs", async () => {
    const { baseUrl, store } = await startRuntimeApi();
    const snapshot = {
      ...(fixtureSnapshot as RuntimeInventorySnapshot),
      device: { ...(fixtureSnapshot as RuntimeInventorySnapshot).device, name: "Backend Device" },
    };
    store.writeLatestSnapshot(snapshot);

    const inventoryResponse = await fetch(`${baseUrl}/api/runtime-inventory/latest`);
    const workStateResponse = await fetch(`${baseUrl}/api/runtime-work-state/latest`);

    expect(inventoryResponse.status).toBe(404);
    expect(workStateResponse.status).toBe(404);
  });

  it("dispatches a refresh command to a connected device", async () => {
    const { baseUrl, channel } = await startRuntimeApi({ createCommandId: () => "cmd-refresh-1" });
    const socket = new MemorySocket();
    channel.attach(socket);
    channel.receive(socket, JSON.stringify({ type: "hello", deviceId: "fixture-mac" }));

    const response = await fetch(`${baseUrl}/api/devices/fixture-mac/refresh`, { method: "POST" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      ok: true,
      commandId: "cmd-refresh-1",
      status: "sent",
    });
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: "inventory.refresh",
      commandId: "cmd-refresh-1",
    }));
  });

  it("returns a clear refresh error when the device is disconnected", async () => {
    const { baseUrl } = await startRuntimeApi();

    const response = await fetch(`${baseUrl}/api/devices/missing-device/refresh`, { method: "POST" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: "device_not_connected",
      deviceId: "missing-device",
    });
  });

  it("returns command status by device and command id", async () => {
    const { baseUrl, channel } = await startRuntimeApi({ createCommandId: () => "cmd-refresh-1" });
    const socket = new MemorySocket();
    channel.attach(socket);
    channel.receive(socket, JSON.stringify({ type: "hello", deviceId: "fixture-mac" }));
    await fetch(`${baseUrl}/api/devices/fixture-mac/refresh`, { method: "POST" });

    const response = await fetch(`${baseUrl}/api/devices/fixture-mac/commands/cmd-refresh-1`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      commandId: "cmd-refresh-1",
      deviceId: "fixture-mac",
      status: "sent",
    });
  });

  it("accepts runtime work state snapshots without exposing a latest GET API", async () => {
    const { baseUrl, workStateStore } = await startRuntimeApi();
    const snapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: "fixture-device",
      workItems: [],
      conversations: [],
      executions: [],
      capabilities: [],
    };

    const postResponse = await fetch(`${baseUrl}/api/runtime-work-state-snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const latestResponse = await fetch(`${baseUrl}/api/runtime-work-state/latest`);

    expect(postResponse.status).toBe(201);
    expect(latestResponse.status).toBe(404);
    expect(workStateStore.readLatestSnapshot()).toEqual(snapshot);
  });

  it("rejects runtime read APIs when the configured session guard fails", async () => {
    const { baseUrl } = await startRuntimeApi({
      auth: {
        requireDeviceToken: async () => true,
        requireUserSession: async () => null,
      },
    });

    const response = await fetch(`${baseUrl}/api/runtime-fleet`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rejects collector ingestion when the configured device-token guard fails", async () => {
    const { baseUrl } = await startRuntimeApi({
      auth: {
        requireDeviceToken: async () => null,
        requireUserSession: async () => ({ userId: "user-1" }),
      },
    });

    const response = await fetch(`${baseUrl}/api/device-snapshots`, {
      body: JSON.stringify(fixtureSnapshot),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_device_token" });
  });

  it("returns normalized collector ingestion errors with readable messages", async () => {
    const { baseUrl } = await startRuntimeApi();

    const response = await fetch(`${baseUrl}/api/device-snapshots`, {
      body: JSON.stringify({ observedAt: "2026-05-12T09:59:30.000Z" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: "invalid_collector_snapshot",
      message: "设备采集数据无效，请检查 Lorume CLI 版本或上报结构。",
    });
  });

  it("accepts real-sized runtime work state snapshots from remote collectors", async () => {
    const { baseUrl, workStateStore } = await startRuntimeApi();
    const snapshot = {
      observedAt: "2026-05-10T02:44:20.000Z",
      deviceId: "remote-device",
      workItems: Array.from({ length: 2_200 }, (_, index) => ({
        id: `remote-device:openclaw:work-item:${index}`,
        title: `真实远端工作项 ${index}`,
        description: "x".repeat(1_024),
      })),
      conversations: [],
      executions: [],
      capabilities: [],
    };
    const payload = JSON.stringify(snapshot);

    expect(payload.length).toBeGreaterThan(2_000_000);

    const postResponse = await fetch(`${baseUrl}/api/runtime-work-state-snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    expect(postResponse.status).toBe(201);
    expect(workStateStore.readLatestSnapshot()?.workItems).toHaveLength(2_200);
  });
});

async function startRuntimeApi(options: {
  auth?: Parameters<typeof createRuntimeHttpApiHandler>[0]["auth"];
  createCommandId?: () => string;
} = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-runtime-api-"));
  const store = createRuntimeInventoryStore({
    snapshotPath: path.join(dataDir, "latest.json"),
    staleAfterMs: 24 * 60 * 60 * 1000,
  });
  const workStateStore = createRuntimeWorkStateStore({
    snapshotPath: path.join(dataDir, "work-state-latest.json"),
  });
  const channel = createRuntimeControlChannel({
    store,
    createCommandId: options.createCommandId,
    now: () => new Date("2026-05-08T08:00:00.000Z"),
  });
  const handler = createRuntimeHttpApiHandler({ auth: options.auth, store, controlChannel: channel, workStateStore });
  const server = createServer((request, response) => {
    void handler(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    workStateStore,
    channel,
  };
}
