import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fixtureSnapshot from "../../fixtures/runtime/collector-snapshot.sample.json";
import { createPostgresAuthStore } from "../auth/auth-store";
import type { RuntimeInventorySnapshot, RuntimeWorkStateSnapshot } from "../runtime";
import { createPostgresNotificationStore } from "../notifications/notification-store";
import { createTemporaryPostgresDatabase, runMigrationsScript, shouldRunPostgresTests } from "../test/postgres";
import { createPostgresStore, type PostgresStore } from "./postgres-store";
import { createRuntimeControlChannel } from "./runtime-control-channel";
import { createRuntimeHttpApiHandler } from "./runtime-http-api";
import { createRuntimeInventoryStore } from "./runtime-inventory-store";
import { createRuntimeWorkStateStore } from "./runtime-work-state-store";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describeDb("runtime HTTP API with Postgres store", () => {
  it("serves readiness when Postgres is available", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);

        const response = await fetch(`${baseUrl}/readyz`);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ ok: true });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("persists collector posts and serves backend query endpoints", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);
        const inventorySnapshot = fixtureSnapshot as RuntimeInventorySnapshot;
        const workStateSnapshot = createWorkStateSnapshot(inventorySnapshot);

        const noIngestionHealthResponse = await fetch(`${baseUrl}/api/devices/fixture-mac/collection-health`);
        const inventoryResponse = await postJson(`${baseUrl}/api/device-snapshots`, inventorySnapshot);
        const workStateResponse = await postJson(`${baseUrl}/api/runtime-work-state-snapshots`, workStateSnapshot);
        const fleetResponse = await fetch(`${baseUrl}/api/runtime-fleet`);
        const workItemsResponse = await fetch(`${baseUrl}/api/runtime-work-items?source=slock&stage=processing`);
        const workItemDetailResponse = await fetch(`${baseUrl}/api/runtime-work-items/${encodeURIComponent(workStateSnapshot.workItems[0].id)}`);
        const ingestionsResponse = await fetch(`${baseUrl}/api/devices/fixture-mac/ingestions`);
        const healthResponse = await fetch(`${baseUrl}/api/devices/fixture-mac/collection-health`);

        await expect(noIngestionHealthResponse.json()).resolves.toMatchObject({
          deviceId: "fixture-mac",
          status: "failed",
          checks: [
            expect.objectContaining({ id: "inventory", message: "尚未收到采集记录", status: "failed" }),
            expect.objectContaining({ id: "work_state", message: "尚未收到采集记录", status: "failed" }),
          ],
        });
        expect(inventoryResponse.status).toBe(201);
        expect(workStateResponse.status).toBe(201);
        await expect(fleetResponse.json()).resolves.toMatchObject({
          summary: { agentCount: 2, deviceCount: 1, runtimeCount: 2 },
          devices: [expect.objectContaining({ id: "fixture-mac" })],
        });
        await expect(workItemsResponse.json()).resolves.toMatchObject({
          items: [expect.objectContaining({
            id: workStateSnapshot.workItems[0].id,
            source: "slock",
            stage: "processing",
            title: "AGTD-001 Fix queue handoff",
          })],
          total: 1,
        });
        expect(workItemDetailResponse.status).toBe(200);
        await expect(workItemDetailResponse.json()).resolves.toMatchObject({
          id: workStateSnapshot.workItems[0].id,
          source: "slock",
          stage: "processing",
        });
        await expect(ingestionsResponse.json()).resolves.toMatchObject({
          ingestions: [
            expect.objectContaining({
              observedAt: expect.any(String),
              receivedAt: expect.any(String),
              snapshotType: "work_state",
            }),
            expect.objectContaining({
              observedAt: expect.any(String),
              receivedAt: expect.any(String),
              snapshotType: "inventory",
            }),
          ],
        });
        await expect(healthResponse.json()).resolves.toMatchObject({
          deviceId: "fixture-mac",
          status: "healthy",
          summary: "设备资产与工作态采集正常",
          checks: [
            expect.objectContaining({ id: "inventory", status: "healthy" }),
            expect.objectContaining({ id: "work_state", status: "healthy" }),
          ],
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("records failed collector ingestions for invalid snapshots", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);

        const inventoryResponse = await postJson(`${baseUrl}/api/device-snapshots`, {
          observedAt: "2026-05-10T10:00:00.000Z",
          device: { id: "broken-device" },
        });
        const workStateResponse = await postJson(`${baseUrl}/api/runtime-work-state-snapshots`, {
          observedAt: "2026-05-10T10:01:00.000Z",
          deviceId: "broken-device",
        });
        const ingestionsResponse = await fetch(`${baseUrl}/api/devices/broken-device/ingestions`);
        const healthResponse = await fetch(`${baseUrl}/api/devices/broken-device/collection-health`);

        expect(inventoryResponse.status).toBe(400);
        expect(workStateResponse.status).toBe(400);
        await expect(ingestionsResponse.json()).resolves.toMatchObject({
          ingestions: [
            expect.objectContaining({
              deviceId: "broken-device",
              observedAt: expect.any(String),
              receivedAt: expect.any(String),
              snapshotType: "work_state",
              status: "failed",
              error: expect.stringContaining("invalid_work_state_snapshot: 工作态采集数据无效"),
            }),
            expect.objectContaining({
              deviceId: "broken-device",
              observedAt: expect.any(String),
              receivedAt: expect.any(String),
              snapshotType: "inventory",
              status: "failed",
              error: expect.stringContaining("invalid_collector_snapshot: 设备采集数据无效"),
            }),
          ],
        });
        await expect(healthResponse.json()).resolves.toMatchObject({
          deviceId: "broken-device",
          status: "failed",
          checks: [
            expect.objectContaining({ id: "inventory", message: "采集失败", status: "failed" }),
            expect.objectContaining({ id: "work_state", message: "采集失败", status: "failed" }),
          ],
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("derives device diagnostics from local connection and inventory ingestion", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl, store } = await startRuntimeApi(postgresStore);
        const currentTime = new Date().toISOString();
        store.writeDeviceConnection({
          deviceId: "diagnostic-device",
          status: "online",
          connectedAt: currentTime,
          lastHeartbeatAt: currentTime,
        });

        const inventoryResponse = await postJson(`${baseUrl}/api/device-snapshots`, {
          observedAt: "2026-05-21T08:59:30.000Z",
          collector: { version: "0.1.0", status: "online" },
          device: {
            id: "diagnostic-device",
            hostname: "diagnostic.local",
            os: "darwin",
            architecture: "arm64",
            lastSeenAt: "2026-05-21T08:59:30.000Z",
          },
          runtimes: [],
          agents: [],
          reports: [],
        });
        const response = await fetch(`${baseUrl}/api/devices/diagnostic-device/diagnostics`);

        expect(inventoryResponse.status).toBe(201);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          deviceId: "diagnostic-device",
          status: "online",
          label: "在线",
          reason: "heartbeat_and_inventory_fresh",
          message: "设备在线且采集正常",
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("marks diagnostics abnormal after invalid inventory ingestion", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl, store } = await startRuntimeApi(postgresStore);
        store.writeDeviceConnection({
          deviceId: "broken-diagnostic-device",
          status: "online",
          connectedAt: "2026-05-21T08:59:00.000Z",
          lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
        });

        const inventoryResponse = await postJson(`${baseUrl}/api/device-snapshots`, {
          observedAt: "2026-05-21T08:59:30.000Z",
          device: { id: "broken-diagnostic-device" },
        });
        const response = await fetch(`${baseUrl}/api/devices/broken-diagnostic-device/diagnostics?now=2026-05-21T09:00:00.000Z`);

        expect(inventoryResponse.status).toBe(400);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          deviceId: "broken-diagnostic-device",
          status: "abnormal",
          label: "异常",
          reason: "last_inventory_failed",
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("creates a runtime notification when authenticated collector ingestion fails", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const notificationStore = createPostgresNotificationStore({ connectionString: database.url });
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("collector-owner@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Collector Owner Team",
          slug: "collector-owner-team",
        });
        const { baseUrl } = await startRuntimeApi(postgresStore, {
          auth: {
            requireDeviceToken: async () => ({ organizationId: organization.id }),
          },
          collectorNotifications: {
            createNotificationEvent: notificationStore.createNotificationEvent,
            listRecipientUserIds: (organizationId) => authStore.listOrganizationAdminUserIds(organizationId),
          },
        });

        const response = await postJson(`${baseUrl}/api/device-snapshots`, {
          observedAt: "2026-05-10T10:00:00.000Z",
          device: { id: "broken-device" },
        });
        const threads = await notificationStore.listThreads({
          organizationId: organization.id,
          recipientUserId: user.id,
        });
        const deliveries = threads[0]
          ? await notificationStore.listDeliveries({ threadId: threads[0].id })
          : [];

        expect(response.status).toBe(400);
        expect(threads).toEqual([
          expect.objectContaining({
            dedupeKey: "runtime:collector:broken-device:inventory:failed",
            eventType: "collector_inventory_failed",
            resourceId: "broken-device",
            resourceType: "device",
            title: "设备资产采集失败",
          }),
        ]);
        expect(deliveries).toEqual(expect.arrayContaining([
          expect.objectContaining({ channel: "in_app", recipientUserId: user.id, status: "sent" }),
          expect.objectContaining({ channel: "email", recipientUserId: user.id, status: "pending" }),
        ]));
      } finally {
        await Promise.all([authStore.close(), notificationStore.close(), postgresStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });
});

async function startRuntimeApi(
  postgresStore: PostgresStore,
  options: Pick<Parameters<typeof createRuntimeHttpApiHandler>[0], "auth" | "collectorNotifications"> = {},
) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-runtime-api-postgres-"));
  const store = createRuntimeInventoryStore({
    snapshotPath: path.join(dataDir, "latest.json"),
  });
  const workStateStore = createRuntimeWorkStateStore({
    snapshotPath: path.join(dataDir, "work-state-latest.json"),
  });
  const controlChannel = createRuntimeControlChannel({ store });
  const handler = createRuntimeHttpApiHandler({
    auth: options.auth,
    store,
    controlChannel,
    workStateStore,
    postgresStore,
    collectorNotifications: options.collectorNotifications,
  });
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
  return { baseUrl: `http://127.0.0.1:${address.port}`, store };
}

function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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
    warnings: ["fixture warning"],
  };
}
