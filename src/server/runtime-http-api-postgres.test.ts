import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresAuthStore } from "../auth/auth-store";
import { createPostgresNotificationStore } from "../notifications/notification-store";
import { createTemporaryPostgresDatabase, runMigrationsScript, shouldRunPostgresTests } from "../test/postgres";
import { createPostgresStore, type PostgresStore } from "./postgres-store";
import { createRuntimeControlChannel } from "./runtime-control-channel";
import { createRuntimeHttpApiHandler } from "./runtime-http-api";
import { createRuntimeDeviceStateStore } from "./runtime-device-state-store";

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

  it("persists unified device-state snapshots and serves current query endpoints", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);
        const deviceStateSnapshot = createDeviceStateSnapshot();

        const noIngestionHealthResponse = await fetch(`${baseUrl}/api/devices/openclaw-device/collection-health`);
        const response = await postJson(`${baseUrl}/api/device-state-snapshots`, deviceStateSnapshot);
        const counts = await postgresStore.readEntityCounts();
        const fleetResponse = await fetch(`${baseUrl}/api/runtime-fleet`);
        const tasksResponse = await fetch(`${baseUrl}/api/runtime-tasks?status=in_progress&channelKind=dingtalk`);
        const scheduledTasksResponse = await fetch(`${baseUrl}/api/runtime-tasks?taskType=scheduled`);
        const ingestionsResponse = await fetch(`${baseUrl}/api/devices/openclaw-device/ingestions`);
        const healthResponse = await fetch(`${baseUrl}/api/devices/openclaw-device/collection-health`);

        await expect(noIngestionHealthResponse.json()).resolves.toMatchObject({
          checks: [expect.objectContaining({ id: "device_state", message: "尚未收到采集记录", status: "failed" })],
          deviceId: "openclaw-device",
          status: "failed",
        });
        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toMatchObject({
          deviceId: "openclaw-device",
          observedAt: "2026-05-21T03:00:00.000Z",
          ok: true,
        });
        expect(counts).toEqual({
          agentSkillProbeSnapshots: 0,
          agents: 1,
          collectorIngestions: 1,
          devices: 1,
          runtimes: 1,
          tasks: 1,
        });
        await expect(fleetResponse.json()).resolves.toMatchObject({
          agents: [expect.objectContaining({ id: "openclaw-device:runtime:openclaw:agent:main", collectionStatus: "online" })],
          devices: [expect.objectContaining({ id: "openclaw-device", collectionStatus: "online" })],
          runtimes: [expect.objectContaining({ id: "openclaw-device:runtime:openclaw", collectionStatus: "online" })],
          summary: { agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 1 },
          tasks: [expect.objectContaining({ id: "openclaw-device:runtime:openclaw:agent:main:task:task-1" })],
        });
        const tasksBody = await tasksResponse.json();
        expect(tasksBody).toMatchObject({
          items: [
            expect.objectContaining({
              agentId: "openclaw-device:runtime:openclaw:agent:main",
              channel: expect.objectContaining({ kind: "dingtalk" }),
              id: "openclaw-device:runtime:openclaw:agent:main:task:task-1",
              status: "in_progress",
            }),
          ],
          total: 1,
        });
        expect(tasksBody.items[0]).not.toHaveProperty("runtimeId");
        expect(tasksBody.items[0]).not.toHaveProperty("lastRun");
        await expect(scheduledTasksResponse.json()).resolves.toMatchObject({
          items: [],
          total: 0,
        });
        await expect(ingestionsResponse.json()).resolves.toMatchObject({
          ingestions: [
            expect.objectContaining({
              counts: expect.objectContaining({ tasks: 1 }),
              snapshotType: "device_state",
              status: "succeeded",
            }),
          ],
        });
        await expect(healthResponse.json()).resolves.toMatchObject({
          checks: [expect.objectContaining({ id: "device_state", status: "healthy" })],
          deviceId: "openclaw-device",
          status: "healthy",
          summary: "设备状态采集正常",
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("records failed collector ingestions for invalid device-state snapshots", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);

        const response = await postJson(`${baseUrl}/api/device-state-snapshots`, {
          observedAt: "2026-05-10T10:00:00.000Z",
          device: { id: "broken-device" },
        });
        const ingestionsResponse = await fetch(`${baseUrl}/api/devices/broken-device/ingestions`);
        const healthResponse = await fetch(`${baseUrl}/api/devices/broken-device/collection-health`);

        expect(response.status).toBe(400);
        await expect(ingestionsResponse.json()).resolves.toMatchObject({
          ingestions: [
            expect.objectContaining({
              deviceId: "broken-device",
              error: expect.stringContaining("invalid_device_state_snapshot: 设备状态采集数据无效"),
              observedAt: expect.any(String),
              receivedAt: expect.any(String),
              snapshotType: "device_state",
              status: "failed",
            }),
          ],
        });
        await expect(healthResponse.json()).resolves.toMatchObject({
          checks: [expect.objectContaining({ id: "device_state", message: "采集失败", status: "failed" })],
          deviceId: "broken-device",
          status: "failed",
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("derives device diagnostics from local connection and device-state ingestion", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl, store } = await startRuntimeApi(postgresStore);
        const currentTime = new Date().toISOString();
        store.writeDeviceConnection({
          connectedAt: currentTime,
          deviceId: "diagnostic-device",
          lastHeartbeatAt: currentTime,
          status: "online",
        });

        const uploadResponse = await postJson(`${baseUrl}/api/device-state-snapshots`, createDeviceStateSnapshot({
          deviceId: "diagnostic-device",
          hostname: "diagnostic.local",
          observedAt: currentTime,
        }));
        const response = await fetch(`${baseUrl}/api/devices/diagnostic-device/diagnostics`);

        expect(uploadResponse.status).toBe(201);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          deviceId: "diagnostic-device",
          label: "在线",
          message: "设备在线且采集正常",
          reason: "heartbeat_and_device_state_fresh",
          status: "online",
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("marks diagnostics abnormal after invalid device-state ingestion", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runMigrationsScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl, store } = await startRuntimeApi(postgresStore);
        store.writeDeviceConnection({
          connectedAt: "2026-05-21T08:59:00.000Z",
          deviceId: "broken-diagnostic-device",
          lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
          status: "online",
        });

        const uploadResponse = await postJson(`${baseUrl}/api/device-state-snapshots`, {
          observedAt: "2026-05-21T08:59:30.000Z",
          device: { id: "broken-diagnostic-device" },
        });
        const response = await fetch(`${baseUrl}/api/devices/broken-diagnostic-device/diagnostics?now=2026-05-21T09:00:00.000Z`);

        expect(uploadResponse.status).toBe(400);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          deviceId: "broken-diagnostic-device",
          label: "异常",
          reason: "last_device_state_failed",
          status: "abnormal",
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("creates a runtime notification when authenticated device-state ingestion fails", async () => {
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

        const response = await postJson(`${baseUrl}/api/device-state-snapshots`, {
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
            dedupeKey: "runtime:collector:broken-device:device_state:failed",
            eventType: "collector_device_state_failed",
            resourceId: "broken-device",
            resourceType: "device",
            title: "设备状态采集失败",
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
  const store = createRuntimeDeviceStateStore({
    snapshotPath: path.join(dataDir, "latest.json"),
  });
  const controlChannel = createRuntimeControlChannel({ store });
  const handler = createRuntimeHttpApiHandler({
    auth: options.auth,
    store,
    controlChannel,
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

function createDeviceStateSnapshot(options: {
  deviceId?: string;
  hostname?: string;
  observedAt?: string;
} = {}) {
  const deviceId = options.deviceId ?? "openclaw-device";
  const runtimeId = `${deviceId}:runtime:openclaw`;
  const agentId = `${runtimeId}:agent:main`;
  const observedAt = options.observedAt ?? "2026-05-21T03:00:00.000Z";
  return {
    observedAt,
    device: {
      architecture: "arm64",
      collectionStatus: "online",
      collector: { version: "0.1.0" },
      hostname: options.hostname ?? "openclaw.local",
      id: deviceId,
      lastSeenAt: observedAt,
      network: { localIps: ["192.168.1.10"] },
      os: "darwin",
      user: { username: "tester" },
    },
    runtimes: [{
      collectionStatus: "online",
      deviceId,
      id: runtimeId,
      kind: "openclaw",
      lastSeenAt: observedAt,
      name: "OpenClaw Gateway",
      version: "openclaw 1.0.0",
    }],
    agents: [{
      collectionStatus: "online",
      id: agentId,
      lastSeenAt: observedAt,
      name: "main",
      runtimeId,
    }],
    tasks: [{
      agentId,
      channel: { externalId: "group-live", kind: "dingtalk", name: "DingTalk 群聊" },
      createdAt: "2026-05-21T02:55:00.000Z",
      creator: { name: "PMO" },
      description: "PMO asked OpenClaw to inspect the handoff.",
      id: `${agentId}:task:task-1`,
      lastSeenAt: observedAt,
      status: "in_progress",
      title: "Review DingTalk request",
      updatedAt: observedAt,
    }],
  };
}
