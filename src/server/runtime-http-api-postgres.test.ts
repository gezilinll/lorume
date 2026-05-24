import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresAuthStore } from "../auth/auth-store";
import { createPostgresNotificationStore } from "../notifications/notification-store";
import { createRuntimeTaskBatches } from "../runtime/runtime-task-sync";
import { createTemporaryPostgresDatabase, runDatabaseSchemaScript, shouldRunPostgresTests } from "../test/postgres";
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
      runDatabaseSchemaScript(database.url);
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
      runDatabaseSchemaScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);
        const deviceStateSnapshot = createDeviceStateSnapshot();

        const noIngestionHealthResponse = await fetch(`${baseUrl}/api/devices/openclaw-device/collection-health`);
        const response = await postJson(`${baseUrl}/api/device-state-snapshots`, { ...deviceStateSnapshot, tasks: [] });
        const taskBatchResponse = await postJson(`${baseUrl}/api/device-task-batches`, createTaskBatch(deviceStateSnapshot));
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
          collectedAt: "2026-05-21T03:00:00.000Z",
          deviceId: "openclaw-device",
          ok: true,
        });
        expect(taskBatchResponse.status).toBe(201);
        await expect(taskBatchResponse.json()).resolves.toMatchObject({
          acked: [{ id: "openclaw-device:runtime:openclaw:agent:main:task:task-1", hash: expect.any(String) }],
          deviceId: "openclaw-device",
          ok: true,
        });
        expect(counts).toEqual({
          agentSkillProbeSnapshots: 0,
          agents: 1,
          collectorIngestions: 2,
          devices: 1,
          runtimes: 1,
          tasks: 1,
        });
        const fleetBody = await fleetResponse.json();
        expect(fleetBody).toMatchObject({
          agents: [expect.objectContaining({ id: "openclaw-device:runtime:openclaw:agent:main", collectionStatus: "online" })],
          devices: [expect.objectContaining({ id: "openclaw-device", collectionStatus: "online" })],
          runtimes: [expect.objectContaining({ id: "openclaw-device:runtime:openclaw", collectionStatus: "online" })],
          summary: { agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 1 },
          taskSummary: {
            byAgentId: {
              "openclaw-device:runtime:openclaw:agent:main": expect.objectContaining({
                in_progress: 1,
                total: 1,
              }),
            },
            byDeviceId: {
              "openclaw-device": expect.objectContaining({
                in_progress: 1,
                total: 1,
              }),
            },
            byRuntimeId: {
              "openclaw-device:runtime:openclaw": expect.objectContaining({
                in_progress: 1,
                total: 1,
              }),
            },
          },
        });
        expect(fleetBody).not.toHaveProperty("tasks");
        const tasksBody = await tasksResponse.json();
        expect(tasksBody).toMatchObject({
          facets: {
            channels: [{ count: 1, kind: "dingtalk", label: "DingTalk" }],
          },
          items: [
            expect.objectContaining({
              agentId: "openclaw-device:runtime:openclaw:agent:main",
              channel: expect.objectContaining({ kind: "dingtalk" }),
              id: "openclaw-device:runtime:openclaw:agent:main:task:task-1",
              status: "in_progress",
            }),
          ],
          summary: {
            byStatus: expect.objectContaining({
              in_progress: 1,
              total: 1,
            }),
            total: 1,
          },
          total: 1,
        });
        expect(tasksBody.items[0]).not.toHaveProperty("runtimeId");
        expect(tasksBody.items[0]).not.toHaveProperty("lastRun");
        await expect(scheduledTasksResponse.json()).resolves.toMatchObject({
          items: [],
          total: 0,
        });
        await expect(ingestionsResponse.json()).resolves.toMatchObject({
          ingestions: expect.arrayContaining([
            expect.objectContaining({
              counts: expect.objectContaining({ tasks: 1 }),
              snapshotType: "task_batch",
              status: "succeeded",
            }),
          ]),
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

  it("accepts task removal batches and hides stale tasks from query endpoints", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);
        const deviceStateSnapshot = createDeviceStateSnapshot();
        const taskId = `${deviceStateSnapshot.agents[0].id}:task:task-1`;

        await postJson(`${baseUrl}/api/device-state-snapshots`, { ...deviceStateSnapshot, tasks: [] });
        await postJson(`${baseUrl}/api/device-task-batches`, createTaskBatch(deviceStateSnapshot));
        const removalResponse = await postJson(`${baseUrl}/api/device-task-batches`, {
          schemaVersion: "device-state-v3",
          deviceId: deviceStateSnapshot.device.id,
          collectedAt: "2026-05-21T03:05:00.000Z",
          batchId: "remove-task-1",
          batchIndex: 0,
          batchCount: 1,
          tasks: [],
          removedTaskIds: [taskId],
        });
        const fleetResponse = await fetch(`${baseUrl}/api/runtime-fleet`);
        const tasksResponse = await fetch(`${baseUrl}/api/runtime-tasks`);

        expect(removalResponse.status).toBe(201);
        await expect(removalResponse.json()).resolves.toMatchObject({
          ok: true,
          removed: [{ id: taskId }],
          counts: { batches: 1, removedTasks: 1, tasks: 0 },
        });
        await expect(fleetResponse.json()).resolves.toMatchObject({
          summary: { taskCount: 0 },
          taskSummary: {
            byAgentId: {},
            byDeviceId: {},
            byRuntimeId: {},
          },
        });
        await expect(tasksResponse.json()).resolves.toMatchObject({
          items: [],
          total: 0,
        });
        await expect(postgresStore.readEntityCounts()).resolves.toMatchObject({ tasks: 1 });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("persists Slock task batches and serves Slock task queries", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);
        const deviceStateSnapshot = createSlockDeviceStateSnapshot();

        const response = await postJson(`${baseUrl}/api/device-state-snapshots`, { ...deviceStateSnapshot, tasks: [] });
        const taskBatchResponse = await postJson(`${baseUrl}/api/device-task-batches`, createTaskBatch(deviceStateSnapshot));
        const tasksResponse = await fetch(`${baseUrl}/api/runtime-tasks?channelKind=slock`);

        expect(response.status).toBe(201);
        expect(taskBatchResponse.status).toBe(201);
        await expect(taskBatchResponse.json()).resolves.toMatchObject({
          acked: [{ id: "slock-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1", hash: expect.any(String) }],
          deviceId: "slock-device",
          ok: true,
        });
        await expect(tasksResponse.json()).resolves.toMatchObject({
          items: [
            expect.objectContaining({
              adapter: { kind: "slock" },
              agentId: "slock-device:runtime:codex:agent:slock:agent-local-1",
              channel: { kind: "slock", externalId: "#daily-work" },
              id: "slock-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1",
              raw: { slock: expect.objectContaining({ messageId: "msg-local-1", status: "done" }) },
              status: "done",
            }),
          ],
          total: 1,
        });
      } finally {
        await postgresStore.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("persists Codex task batches and serves Codex task queries without channel context", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);
        const deviceStateSnapshot = createCodexDeviceStateSnapshot();

        const response = await postJson(`${baseUrl}/api/device-state-snapshots`, { ...deviceStateSnapshot, tasks: [] });
        const taskBatchResponse = await postJson(`${baseUrl}/api/device-task-batches`, createTaskBatch(deviceStateSnapshot));
        const tasksResponse = await fetch(`${baseUrl}/api/runtime-tasks?status=done`);

        expect(response.status).toBe(201);
        expect(taskBatchResponse.status).toBe(201);
        await expect(taskBatchResponse.json()).resolves.toMatchObject({
          acked: [{ id: "codex-device:runtime:codex:agent:codex:local:task:thread-native-done", hash: expect.any(String) }],
          deviceId: "codex-device",
          ok: true,
        });
        const tasksBody = await tasksResponse.json();
        expect(tasksBody).toMatchObject({
          items: [
            expect.objectContaining({
              adapter: { kind: "codex" },
              agentId: "codex-device:runtime:codex:agent:codex:local",
              id: "codex-device:runtime:codex:agent:codex:local:task:thread-native-done",
              raw: { codex: expect.objectContaining({ threadId: "thread-native-done", source: "exec" }) },
              status: "done",
            }),
          ],
          total: 1,
        });
        expect(tasksBody.items[0]).not.toHaveProperty("runtimeId");
        expect(tasksBody.items[0]).not.toHaveProperty("toolCalls");
        expect(tasksBody.items[0]).not.toHaveProperty("title");
        expect(tasksBody.items[0]).not.toHaveProperty("description");
        expect(tasksBody.items[0]).not.toHaveProperty("channel");
        expect(tasksBody.items[0]).not.toHaveProperty("conversation");
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
      runDatabaseSchemaScript(database.url);
      const postgresStore = createPostgresStore({ connectionString: database.url });
      try {
        const { baseUrl } = await startRuntimeApi(postgresStore);

        const response = await postJson(`${baseUrl}/api/device-state-snapshots`, {
          collectedAt: "2026-05-10T10:00:00.000Z",
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
              collectedAt: expect.any(String),
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
      runDatabaseSchemaScript(database.url);
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
          collectedAt: currentTime,
          deviceId: "diagnostic-device",
          hostname: "diagnostic.local",
          tasks: [],
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

  it("marks diagnostics error after invalid device-state ingestion", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
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
          collectedAt: "2026-05-21T08:59:30.000Z",
          device: { id: "broken-diagnostic-device" },
        });
        const response = await fetch(`${baseUrl}/api/devices/broken-diagnostic-device/diagnostics?now=2026-05-21T09:00:00.000Z`);

        expect(uploadResponse.status).toBe(400);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          deviceId: "broken-diagnostic-device",
          label: "异常",
          reason: "last_device_state_failed",
          status: "error",
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
      runDatabaseSchemaScript(database.url);
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
          collectedAt: "2026-05-10T10:00:00.000Z",
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
  collectedAt?: string;
  tasks?: Array<Record<string, unknown>>;
} = {}) {
  const deviceId = options.deviceId ?? "openclaw-device";
  const runtimeId = `${deviceId}:runtime:openclaw`;
  const agentId = `${runtimeId}:agent:main`;
  const collectedAt = options.collectedAt ?? "2026-05-21T03:00:00.000Z";
  return {
    collectedAt,
    device: {
      architecture: "arm64",
      collectionStatus: "online",
      collector: { version: "0.1.0" },
      hostname: options.hostname ?? "openclaw.local",
      id: deviceId,
      lastSeenAt: collectedAt,
      network: { localIps: ["192.168.1.10"] },
      os: "darwin",
      user: { username: "tester" },
    },
    runtimes: [{
      collectionStatus: "online",
      deviceId,
      id: runtimeId,
      kind: "openclaw",
      lastSeenAt: collectedAt,
      name: "OpenClaw Gateway",
      version: "openclaw 1.0.0",
    }],
    agents: [{
      collectionStatus: "online",
      id: agentId,
      lastSeenAt: collectedAt,
      name: "main",
      runtimeId,
    }],
    tasks: options.tasks ?? [{
      agentId,
      adapter: { kind: "openclaw" },
      channel: { externalId: "group-live", kind: "dingtalk" },
      createdAt: "2026-05-21T02:55:00.000Z",
      creator: { name: "PMO" },
      id: `${agentId}:task:task-1`,
      userMessage: "PMO asked OpenClaw to inspect the handoff.",
      agentReply: "The handoff is ready for review.",
      status: "in_progress",
      updatedAt: collectedAt,
    }],
  };
}

function createSlockDeviceStateSnapshot() {
  const collectedAt = "2026-05-23T01:10:00.000Z";
  return {
    collectedAt,
    device: {
      architecture: "arm64",
      collectionStatus: "online",
      collector: { version: "0.1.0" },
      hostname: "slock.local",
      id: "slock-device",
      lastSeenAt: collectedAt,
      os: "darwin",
      user: { username: "tester" },
    },
    runtimes: [{
      collectionStatus: "online",
      deviceId: "slock-device",
      id: "slock-device:runtime:codex",
      kind: "codex",
      lastSeenAt: collectedAt,
      name: "Codex",
    }],
    agents: [{
      collectionStatus: "online",
      id: "slock-device:runtime:codex:agent:slock:agent-local-1",
      lastSeenAt: collectedAt,
      name: "大卷Bot",
      runtimeId: "slock-device:runtime:codex",
    }],
    tasks: [{
      adapter: { kind: "slock" },
      agentId: "slock-device:runtime:codex:agent:slock:agent-local-1",
      agentReply: "今天的主要风险是接口稳定性和排期收敛。",
      assignee: { name: "大卷Bot", externalId: "agent-local-1" },
      channel: { kind: "slock", externalId: "#daily-work" },
      conversation: { title: "日常工作", externalId: "#daily-work", lastActivityAt: "2026-05-23T01:05:00.000Z" },
      createdAt: "2026-05-23T01:00:00.000Z",
      creator: { name: "张良", externalId: "user-1" },
      id: "slock-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1",
      raw: { slock: { messageId: "msg-local-1", status: "done", taskNumber: "1001" } },
      status: "done",
      taskType: "conversation",
      updatedAt: "2026-05-23T01:05:00.000Z",
      userMessage: "帮我整理今天的项目风险",
    }],
  };
}

function createCodexDeviceStateSnapshot() {
  const collectedAt = "2026-05-24T01:10:00.000Z";
  return {
    collectedAt,
    device: {
      architecture: "arm64",
      collectionStatus: "online",
      collector: { version: "0.1.0" },
      hostname: "codex.local",
      id: "codex-device",
      lastSeenAt: collectedAt,
      os: "darwin",
      user: { username: "tester" },
    },
    runtimes: [{
      collectionStatus: "online",
      deviceId: "codex-device",
      id: "codex-device:runtime:codex",
      kind: "codex",
      lastSeenAt: collectedAt,
      name: "Codex",
    }],
    agents: [{
      collectionStatus: "online",
      id: "codex-device:runtime:codex:agent:codex:local",
      lastSeenAt: collectedAt,
      name: "Codex",
      runtimeId: "codex-device:runtime:codex",
    }],
    tasks: [{
      adapter: { kind: "codex" },
      agentId: "codex-device:runtime:codex:agent:codex:local",
      agentReply: "仓库状态正常，没有发现阻塞。",
      createdAt: "2026-05-24T01:00:00.000Z",
      id: "codex-device:runtime:codex:agent:codex:local:task:thread-native-done",
      raw: {
        codex: {
          threadId: "thread-native-done",
          rolloutPath: "sessions/native-done.jsonl",
          source: "exec",
          model: "gpt-5.4",
          cwdKind: "codex-native-or-other",
          tokensUsed: 1280,
        },
      },
      status: "done",
      taskType: "conversation",
      updatedAt: "2026-05-24T01:05:00.000Z",
      userMessage: "帮我总结一下当前仓库状态",
    }],
  };
}

function createTaskBatch(snapshot: ReturnType<typeof createDeviceStateSnapshot> | ReturnType<typeof createSlockDeviceStateSnapshot> | ReturnType<typeof createCodexDeviceStateSnapshot>) {
  const batch = createRuntimeTaskBatches(snapshot.tasks as any, {
    batchMaxBytes: 1_000_000,
    batchMaxTasks: 1_000,
    collectedAt: snapshot.collectedAt,
    deviceId: snapshot.device.id,
  })[0];
  if (!batch) throw new Error("test task batch should not be empty");
  return batch;
}
