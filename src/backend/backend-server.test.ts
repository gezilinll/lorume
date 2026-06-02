import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import deviceStateFixture from "../../fixtures/runtime/runtime-fleet-device-state.sample.json";
import { hashSecret } from "../auth/auth-crypto";
import { createPostgresAuthStore, type AuthStore } from "../auth/auth-store";
import { createPostgresNotificationStore } from "../notifications/notification-store";
import { createPostgresOperationStore } from "../operations/operation-store";
import { createDeviceStateSnapshot } from "../runtime/runtime-model";
import { createRuntimeTaskBatches } from "../runtime/runtime-task-sync";
import { createTemporaryPostgresDatabase, runDatabaseSchemaScript, shouldRunPostgresTests } from "../test/postgres";
import { createLorumeBackendServer, type LorumeBackendServer } from "./backend-server";
import {
  createCollectorPackageManifest,
  deviceInstallerPackageManifest,
  deviceInstallerRuntimeFiles,
} from "./device-installer-manifest";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;
const backends: LorumeBackendServer[] = [];

afterEach(async () => {
  await Promise.all(backends.map((backend) => backend.close()));
  backends.length = 0;
});

describe("standalone Lorume backend server", () => {
  it("keeps installer manifest paths repository-relative and present", () => {
    expect(deviceInstallerPackageManifest.map((entry) => entry.fileName)).toEqual([
      "install-device-collector.sh",
      "lorume-device-collector.mjs",
      "lorume-runtime-adapters.mjs",
      "local-ip-normalization.mjs",
      "lorume.mjs",
    ]);
    for (const entry of deviceInstallerPackageManifest) {
      expect(path.isAbsolute(entry.sourcePath)).toBe(false);
      expect(readFileSync(path.join(process.cwd(), entry.sourcePath), "utf8").length).toBeGreaterThan(0);
    }
    expect(deviceInstallerRuntimeFiles.map((entry) => entry.fileName)).toEqual([
      "lorume-device-collector.mjs",
      "lorume-runtime-adapters.mjs",
      "local-ip-normalization.mjs",
      "lorume.mjs",
    ]);
  });

  it("creates a collector package manifest from runtime files", async () => {
    const manifest = await createCollectorPackageManifest({
      createdAt: "2026-06-02T00:00:00.000Z",
      version: "0.1.2",
    });

    expect(manifest).toMatchObject({
      schemaVersion: "collector-package-v1",
      version: "0.1.2",
      createdAt: "2026-06-02T00:00:00.000Z",
      minUpgradeProtocolVersion: 1,
    });
    expect(manifest.files.map((file) => file.fileName)).toEqual(deviceInstallerRuntimeFiles.map((file) => file.fileName));
    for (const file of manifest.files) {
      expect(file.path).toBe(file.fileName);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.bytes).toBeGreaterThan(0);
    }
  });

  it("keeps the device control websocket available outside Vite", async () => {
    const backend = await startBackend();
    const socket = new WebSocket(`${backend.wsUrl}/api/device-control/ws`);
    await waitForOpen(socket);

    const helloAckPromise = waitForMessage(socket);
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "standalone-device",
      collectorVersion: "0.1.0",
    }));
    const helloAck = await helloAckPromise;
    expect(helloAck).toMatchObject({ type: "hello.ack", deviceId: "standalone-device" });

    socket.send(JSON.stringify({
      type: "heartbeat",
      deviceId: "standalone-device",
      summary: { deviceStateUploadedAt: "2026-05-20T08:00:00.000Z" },
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

  it("serves the remote device collector installer bundle", async () => {
    const backend = await startBackend();

    const installerResponse = await fetch(`${backend.url}/api/device-collector/install.sh`);
    expect(installerResponse.status).toBe(200);
    expect(installerResponse.headers.get("content-type")).toContain("text/x-shellscript");
    const installerScript = await installerResponse.text();
    expect(installerScript).toContain("api/device-collector/files/$name");
    expect(installerScript).toContain('download "install-device-collector.sh"');
    expect(installerScript).toContain('download "lorume-device-collector.mjs"');
    expect(installerScript).toContain("--source-dir");

    const cliResponse = await fetch(`${backend.url}/api/device-collector/files/lorume.mjs`);
    expect(cliResponse.status).toBe(200);
    expect(cliResponse.headers.get("content-type")).toContain("text/javascript");
    await expect(cliResponse.text()).resolves.toContain("Unsupported lorume command");

    const missingResponse = await fetch(`${backend.url}/api/device-collector/files/not-allowed.txt`);
    expect(missingResponse.status).toBe(404);
  });

  it("serves the collector package manifest", async () => {
    const backend = await startBackend();

    const response = await fetch(`${backend.url}/api/device-collector/manifest.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: "collector-package-v1",
      version: "0.1.0",
      files: expect.arrayContaining([
        expect.objectContaining({
          fileName: "lorume-device-collector.mjs",
          path: "lorume-device-collector.mjs",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    });
  });
});

describeDb("standalone Lorume backend server with Postgres", () => {
  it("persists device-state collector posts and serves formal query APIs", async () => {
    const database = await createTemporaryPostgresDatabase();
    let backend: LorumeBackendServer | null = null;
    try {
      runDatabaseSchemaScript(database.url);
      backend = await startBackend({ databaseUrl: database.url });
      const snapshot = createDeviceStateSnapshot({
        ...deviceStateFixture,
        device: deviceStateFixture.devices[0],
      });

      const response = await postJson(`${backend.url}/api/device-state-snapshots`, { ...snapshot, tasks: [] });
      const taskBatchResponse = await postJson(`${backend.url}/api/device-task-batches`, createTaskBatch(snapshot));
      const fleetResponse = await fetch(`${backend.url}/api/runtime-fleet`);
      const tasksResponse = await fetch(`${backend.url}/api/runtime-tasks?status=in_progress&channelKind=dingtalk`);

      expect(response.status).toBe(201);
      expect(taskBatchResponse.status).toBe(201);
      await expect(fleetResponse.json()).resolves.toMatchObject({
        summary: { agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 2 },
        devices: [expect.objectContaining({ id: "fixture-mac" })],
      });
      await expect(tasksResponse.json()).resolves.toMatchObject({
        total: 1,
        items: [expect.objectContaining({
          agentId: "fixture-mac:runtime:openclaw:agent:main",
          id: "fixture-mac:runtime:openclaw:agent:main:task:running-1",
          status: "in_progress",
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
      runDatabaseSchemaScript(database.url);
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
          resourceId: "thread_1",
          resourceType: "notification_thread",
          summary: "Deliver query notification",
          type: "notification_delivery",
        });
        operationId = operation.id;
        await operationStore.enqueueJob({
          operationId: operation.id,
          organizationId: organization.id,
          payload: { threadId: "thread_1" },
          type: "notification_in_app",
        });
        await notificationStore.createNotificationEvent({
          actorUserId: user.id,
          dedupeKey: "operation:thread_1:notification_queued",
          eventType: "notification_delivery_queued",
          organizationId: organization.id,
          recipientUserIds: [user.id],
          resourceId: "thread_1",
          resourceType: "notification_thread",
          severity: "info",
          sourceModule: "system",
          summary: "通知投递已进入队列。",
          title: "通知投递排队中",
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
        operations: [expect.objectContaining({ id: operationId, summary: "Deliver query notification" })],
      });
      await expect(operationDetailResponse.json()).resolves.toMatchObject({
        jobs: [expect.objectContaining({ operationId })],
        operation: expect.objectContaining({ id: operationId }),
      });
      await expect(notificationsResponse.json()).resolves.toMatchObject({
        threads: expect.arrayContaining([expect.objectContaining({ title: "通知投递排队中" })]),
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
    deviceStateSnapshotPath: path.join(dataDir, "runtime-device-state.json"),
    port: 0,
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

function createTaskBatch(snapshot: ReturnType<typeof createDeviceStateSnapshot>) {
  const batch = createRuntimeTaskBatches(snapshot.tasks, {
    batchMaxBytes: 1_000_000,
    batchMaxTasks: 1_000,
    collectedAt: snapshot.collectedAt,
    deviceId: snapshot.device.id,
  })[0];
  if (!batch) throw new Error("backend test task batch should not be empty");
  return batch;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
