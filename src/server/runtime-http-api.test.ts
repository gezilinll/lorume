import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fixtureSnapshot from "../../fixtures/runtime/collector-snapshot.sample.json";
import { createDeviceStateSnapshot } from "../runtime/runtime-model";
import { createRuntimeTaskBatches } from "../runtime/runtime-task-sync";
import type { PostgresStore } from "./postgres-store";
import { createRuntimeControlChannel } from "./runtime-control-channel";
import { createRuntimeHttpApiHandler } from "./runtime-http-api";
import { createRuntimeDeviceStateStore } from "./runtime-device-state-store";

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

    const response = await fetch(`${baseUrl}/api/device-state-snapshots`, {
      body: JSON.stringify(fixtureSnapshot),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_device_token" });
  });

  it("normalizes task batch write failures with the task batch error code", async () => {
    const { baseUrl } = await startRuntimeApi({
      auth: {
        requireDeviceToken: async () => true,
        requireUserSession: async () => ({ userId: "user-1" }),
      },
      postgresStore: {
        recordFailedCollectorIngestion: async () => undefined,
        upsertRuntimeTaskBatch: async () => {
          throw new Error("backend validation failed");
        },
      } as Partial<PostgresStore> as PostgresStore,
    });
    const snapshot = createDeviceStateSnapshot(fixtureSnapshot);
    const batch = createRuntimeTaskBatches(snapshot.tasks, {
      batchMaxBytes: 1_000_000,
      batchMaxTasks: 1_000,
      collectedAt: snapshot.collectedAt,
      deviceId: snapshot.device.id,
    })[0];
    if (!batch) throw new Error("fixture should create one task batch");

    const response = await fetch(`${baseUrl}/api/device-task-batches`, {
      body: JSON.stringify(batch),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_runtime_task_batch" });
  });

});

async function startRuntimeApi(options: {
  auth?: Parameters<typeof createRuntimeHttpApiHandler>[0]["auth"];
  postgresStore?: PostgresStore;
} = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-runtime-api-"));
  const store = createRuntimeDeviceStateStore({
    snapshotPath: path.join(dataDir, "latest.json"),
    staleAfterMs: 24 * 60 * 60 * 1000,
  });
  const channel = createRuntimeControlChannel({
    store,
    now: () => new Date("2026-05-08T08:00:00.000Z"),
  });
  const handler = createRuntimeHttpApiHandler({
    auth: options.auth,
    controlChannel: channel,
    postgresStore: options.postgresStore,
    store,
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
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
  };
}
