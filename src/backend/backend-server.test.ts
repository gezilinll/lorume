import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import fixtureSnapshot from "../../fixtures/runtime/collector-snapshot.sample.json";
import { hashSecret } from "../auth/auth-crypto";
import { createPostgresAuthStore, type AuthStore } from "../auth/auth-store";
import { createPostgresNotificationStore } from "../notifications/notification-store";
import { createPostgresOperationStore } from "../operations/operation-store";
import type { RuntimeInventorySnapshot, RuntimeWorkStateSnapshot } from "../runtime";
import { createTemporaryPostgresDatabase, runMigrationsScript, shouldRunPostgresTests } from "../test/postgres";
import { createLorumeBackendServer, type LorumeBackendServer } from "./backend-server";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;
const backends: LorumeBackendServer[] = [];

afterEach(async () => {
  await Promise.all(backends.map((backend) => backend.close()));
  backends.length = 0;
});

describe("standalone Lorume backend server", () => {
  it("keeps the device control websocket available outside Vite", async () => {
    const backend = await startBackend();
    const socket = new WebSocket(`${backend.wsUrl}/api/device-control/ws`);
    await waitForOpen(socket);

    const helloAckPromise = waitForMessage(socket);
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "standalone-device",
      deviceName: "Standalone Device",
      collectorVersion: "0.1.0",
    }));
    const helloAck = await helloAckPromise;
    expect(helloAck).toMatchObject({ type: "hello.ack", deviceId: "standalone-device" });

    socket.send(JSON.stringify({
      type: "heartbeat",
      deviceId: "standalone-device",
      summary: { inventoryUploadedAt: "2026-05-20T08:00:00.000Z" },
    }));
    await sleep(10);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.close();
  });

  it("authenticates device control websocket with the hello device token", async () => {
    const backend = await startBackend({
      authPepper: "test-pepper",
      authStore: createDeviceTokenAuthStore("device-token-ok"),
      deviceTokenRequired: true,
    });
    const socket = new WebSocket(`${backend.wsUrl}/api/device-control/ws`);
    await waitForOpen(socket);

    const helloAckPromise = waitForMessage(socket);
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "secured-device",
      deviceToken: "device-token-ok",
    }));
    const helloAck = await helloAckPromise;

    expect(helloAck).toMatchObject({ type: "hello.ack", deviceId: "secured-device" });

    socket.close();
  });

  it("keeps authenticated control messages sent during token verification", async () => {
    const backend = await startBackend({
      authPepper: "test-pepper",
      authStore: createDeviceTokenAuthStore("device-token-ok", { verifyDelayMs: 20 }),
      deviceTokenRequired: true,
    });
    const socket = new WebSocket(`${backend.wsUrl}/api/device-control/ws`);
    await waitForOpen(socket);

    const helloAckPromise = waitForMessage(socket);
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "secured-device",
      deviceToken: "device-token-ok",
    }));
    socket.send(JSON.stringify({
      type: "heartbeat",
      deviceId: "secured-device",
      observedAt: "2026-05-17T00:00:00.000Z",
    }));
    const helloAck = await helloAckPromise;

    expect(helloAck).toMatchObject({ type: "hello.ack", deviceId: "secured-device" });
    await sleep(10);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.close();
  });

  it("closes device control websocket when the hello device token is invalid", async () => {
    const backend = await startBackend({
      authPepper: "test-pepper",
      authStore: createDeviceTokenAuthStore("device-token-ok"),
      deviceTokenRequired: true,
    });
    const socket = new WebSocket(`${backend.wsUrl}/api/device-control/ws`);
    await waitForOpen(socket);

    const closePromise = waitForClose(socket);
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "secured-device",
      deviceToken: "wrong-token",
    }));

    await expect(closePromise).resolves.toBe(1008);
  });

  it("requires a user session for Runtime read APIs in production mode", async () => {
    const backend = await startBackend({ appMode: "production" });

    const response = await fetch(`${backend.url}/api/runtime-fleet`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });
});

describeDb("standalone Lorume backend server with Postgres", () => {
  it("persists collector posts and serves formal query APIs", async () => {
    const database = await createTemporaryPostgresDatabase();
    let backend: LorumeBackendServer | null = null;
    try {
      runMigrationsScript(database.url);
      backend = await startBackend({ databaseUrl: database.url });
      const inventorySnapshot = fixtureSnapshot as RuntimeInventorySnapshot;
      const workStateSnapshot = createWorkStateSnapshot(inventorySnapshot);

      const inventoryResponse = await postJson(`${backend.url}/api/device-snapshots`, inventorySnapshot);
      const workStateResponse = await postJson(`${backend.url}/api/runtime-work-state-snapshots`, workStateSnapshot);
      const fleetResponse = await fetch(`${backend.url}/api/runtime-fleet`);
      const workItemsResponse = await fetch(`${backend.url}/api/runtime-work-items?source=slock&stage=processing`);

      expect(inventoryResponse.status).toBe(201);
      expect(workStateResponse.status).toBe(201);
      await expect(fleetResponse.json()).resolves.toMatchObject({
        summary: { agentCount: 2, deviceCount: 1, runtimeCount: 2 },
        devices: [expect.objectContaining({ id: "fixture-mac" })],
      });
      await expect(workItemsResponse.json()).resolves.toMatchObject({
        total: 1,
        items: [expect.objectContaining({
          id: workStateSnapshot.workItems[0].id,
          source: "slock",
          stage: "processing",
          title: "AGTD-001 Fix queue handoff",
        })],
      });
    } finally {
      if (backend) await closeRegisteredBackend(backend);
      await database.drop();
    }
  });

  it("serves authenticated Operation and Notification query APIs", async () => {
    const database = await createTemporaryPostgresDatabase();
    let backend: LorumeBackendServer | null = null;
    try {
      runMigrationsScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      const notificationStore = createPostgresNotificationStore({ connectionString: database.url });
      let organizationId = "";
      let operationId = "";
      try {
        const user = await authStore.upsertUserForEmail("backend-query@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Backend Query Team",
          slug: "backend-query-team",
        });
        organizationId = organization.id;
        await authStore.createSession({
          expiresAt: new Date("2026-06-14T10:00:00.000Z"),
          sessionHash: hashSecret("backend-query-session", "session-token", "test-pepper"),
          userId: user.id,
        });
        const operation = await operationStore.createOperation({
          organizationId: organization.id,
          requestedByUserId: user.id,
          resourceId: "gezilinll-claw",
          resourceType: "device",
          summary: "Refresh query device",
          type: "device_refresh",
        });
        operationId = operation.id;
        await operationStore.enqueueJob({
          operationId: operation.id,
          organizationId: organization.id,
          payload: { deviceId: "gezilinll-claw" },
          type: "notification_in_app",
        });
        await notificationStore.createNotificationEvent({
          actorUserId: user.id,
          dedupeKey: "runtime:gezilinll-claw:refresh_queued",
          eventType: "device_refresh_queued",
          organizationId: organization.id,
          recipientUserIds: [user.id],
          resourceId: "gezilinll-claw",
          resourceType: "device",
          severity: "info",
          sourceModule: "runtime",
          summary: "设备刷新已进入队列。",
          title: "设备刷新排队中",
        });
      } finally {
        await Promise.all([authStore.close(), operationStore.close(), notificationStore.close()]);
      }

      backend = await startBackend({
        authPepper: "test-pepper",
        databaseUrl: database.url,
      });
      const cookie = "lorume_session=backend-query-session";
      const operationsResponse = await fetch(`${backend.url}/api/operations?organizationId=${organizationId}`, {
        headers: { cookie },
      });
      const operationDetailResponse = await fetch(`${backend.url}/api/operations/${operationId}`, {
        headers: { cookie },
      });
      const notificationsResponse = await fetch(`${backend.url}/api/notifications?organizationId=${organizationId}`, {
        headers: { cookie },
      });

      expect(operationsResponse.status).toBe(200);
      expect(operationDetailResponse.status).toBe(200);
      expect(notificationsResponse.status).toBe(200);
      await expect(operationsResponse.json()).resolves.toMatchObject({
        operations: [expect.objectContaining({ id: operationId, summary: "Refresh query device" })],
      });
      await expect(operationDetailResponse.json()).resolves.toMatchObject({
        jobs: [expect.objectContaining({ operationId })],
        operation: expect.objectContaining({ id: operationId }),
      });
      await expect(notificationsResponse.json()).resolves.toMatchObject({
        threads: expect.arrayContaining([expect.objectContaining({ title: "设备刷新排队中" })]),
      });
    } finally {
      if (backend) await closeRegisteredBackend(backend);
      await database.drop();
    }
  });
});

async function startBackend(options: {
  appMode?: "production" | "development" | "agent";
  authPepper?: string;
  authStore?: AuthStore;
  databaseUrl?: string;
  deviceTokenRequired?: boolean;
} = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-standalone-backend-"));
  const backend = createLorumeBackendServer({
    appMode: options.appMode ?? "agent",
    databaseUrl: options.databaseUrl,
    authPepper: options.authPepper,
    authStore: options.authStore,
    deviceTokenRequired: options.deviceTokenRequired,
    host: "127.0.0.1",
    inventorySnapshotPath: path.join(dataDir, "runtime-inventory.json"),
    port: 0,
    workStateSnapshotPath: path.join(dataDir, "runtime-work-state.json"),
  });
  backends.push(backend);
  await backend.listen();
  return backend;
}

function createDeviceTokenAuthStore(validToken: string, options: { verifyDelayMs?: number } = {}): AuthStore {
  const validHash = hashSecret(validToken, "device-token", "test-pepper");
  return {
    verifyDeviceToken: async (tokenHash: string) => {
      if (options.verifyDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.verifyDelayMs));
      }
      return tokenHash === validHash
        ? { id: "devtok_1", organizationId: "org_1", tokenPrefix: "agt_device_" }
        : null;
    },
  } as unknown as AuthStore;
}

async function closeRegisteredBackend(backend: LorumeBackendServer): Promise<void> {
  await backend.close();
  const index = backends.indexOf(backend);
  if (index >= 0) backends.splice(index, 1);
}

function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function createWorkStateSnapshot(snapshot: RuntimeInventorySnapshot): RuntimeWorkStateSnapshot {
  const runtime = snapshot.runtimes.find((item) => item.kind === "slock");
  const agent = snapshot.agents.find((item) => item.origin === "slock");
  if (!runtime || !agent) throw new Error("fixture must include slock runtime and agent");

  const workItemId = `${runtime.id}:work-item:task-1`;
  const conversationId = `${runtime.id}:conversation:thread-1`;
  return {
    observedAt: "2026-05-10T10:00:00.000Z",
    deviceId: snapshot.device.id,
    workItems: [{
      id: workItemId,
      source: "slock",
      externalId: "task-1",
      title: "AGTD-001 Fix queue handoff",
      description: "PMO asked the Slock agent to inspect queue handoff.",
      status: "in_progress",
      channel: { kind: "other", label: "#AjisGTD", externalId: "AjisGTD" },
      creator: { kind: "human", label: "PMO" },
      assignee: { kind: "agent", label: "tester", objectId: agent.id },
      agentId: agent.id,
      runtimeId: runtime.id,
      conversationId,
      createdAt: "2026-05-10T09:50:00.000Z",
      updatedAt: "2026-05-10T09:58:00.000Z",
      lastSeenAt: "2026-05-10T10:00:00.000Z",
      sourceRefs: [{ source: "slock", externalId: "task-1" }],
    }],
    conversations: [{
      id: conversationId,
      source: "slock",
      externalId: "thread-1",
      status: "active",
      channel: { kind: "other", label: "#AjisGTD", externalId: "AjisGTD" },
      title: "#AjisGTD",
      workItemId,
      agentId: agent.id,
      runtimeId: runtime.id,
      lastSeenAt: "2026-05-10T10:00:00.000Z",
      sourceRefs: [{ source: "slock", externalId: "thread-1" }],
    }],
    executions: [{
      id: `${runtime.id}:execution:run-1`,
      source: "slock",
      externalId: "run-1",
      runtimeId: runtime.id,
      agentId: agent.id,
      workItemId,
      conversationId,
      status: "running",
      startedAt: "2026-05-10T09:51:00.000Z",
      lastSeenAt: "2026-05-10T10:00:00.000Z",
      sourceRefs: [{ source: "slock", externalId: "run-1" }],
    }],
    capabilities: [],
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}
