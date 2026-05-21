import { expect, test, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { DeviceStateSnapshot } from "../src/runtime/runtime-model";
import { resetE2eDatabase } from "./db";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendBaseUrl = process.env.LORUME_BACKEND_E2E_BASE_URL ?? "http://127.0.0.1:4184";
const loginCodePath = path.join(repoRoot, ".lorume", "backend-e2e", "latest-login-code.json");
const collectorScriptPath = path.join(repoRoot, "scripts", "lorume-device-collector.mjs");
const fixtureSnapshotPath = path.join(repoRoot, "fixtures", "runtime", "collector-snapshot.sample.json");
const deviceStateFixturePath = path.join(repoRoot, "fixtures", "runtime", "runtime-fleet-device-state.sample.json");
const deviceStateFixture = JSON.parse(readFileSync(deviceStateFixturePath, "utf8")) as {
  agents: DeviceStateSnapshot["agents"];
  devices: DeviceStateSnapshot["device"][];
  observedAt: string;
  runtimes: DeviceStateSnapshot["runtimes"];
  tasks: DeviceStateSnapshot["tasks"];
};

const deviceStateSnapshot: DeviceStateSnapshot = {
  agents: deviceStateFixture.agents,
  device: deviceStateFixture.devices[0],
  observedAt: "2026-05-20T08:00:00.000Z",
  runtimes: deviceStateFixture.runtimes,
  tasks: deviceStateFixture.tasks,
};

test.describe("Runtime backend API", () => {
  test.beforeEach(async () => {
    rmSync(loginCodePath, { force: true });
    await resetE2eDatabase();
  });

  test("authenticates, creates a device token, ingests device state, serves queries, and accepts heartbeat websocket", async ({ request }) => {
    await expect((await request.get("/healthz")).ok()).toBe(true);
    await expect((await request.get("/readyz")).ok()).toBe(true);

    const { deviceToken } = await createLoggedInOrganizationAndDeviceToken(request);

    const unauthorizedIngest = await request.post("/api/device-state-snapshots", { data: deviceStateSnapshot });
    expect(unauthorizedIngest.status()).toBe(401);

    const authHeaders = { authorization: `Bearer ${deviceToken}` };
    const deviceStateResponse = await request.post("/api/device-state-snapshots", {
      data: deviceStateSnapshot,
      headers: authHeaders,
    });
    expect(deviceStateResponse.status()).toBe(201);
    await expect(deviceStateResponse.json()).resolves.toMatchObject({
      deviceId: "fixture-mac",
      ok: true,
    });

    const fleetResponse = await request.get("/api/runtime-fleet");
    expect(fleetResponse.status()).toBe(200);
    await expect(fleetResponse.json()).resolves.toMatchObject({
      agents: [expect.objectContaining({ id: "fixture-mac:runtime:openclaw:agent:main" })],
      devices: [expect.objectContaining({ id: "fixture-mac", hostname: "fixture-mac.local" })],
      runtimes: [expect.objectContaining({ id: "fixture-mac:runtime:openclaw", kind: "openclaw" })],
      summary: { agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 2 },
      tasks: expect.arrayContaining([
        expect.objectContaining({ id: "fixture-mac:runtime:openclaw:agent:main:task:todo-1" }),
      ]),
    });

    const tasksResponse = await request.get("/api/runtime-tasks?status=todo&channelKind=dingtalk");
    expect(tasksResponse.status()).toBe(200);
    await expect(tasksResponse.json()).resolves.toMatchObject({
      items: [expect.objectContaining({
        id: "fixture-mac:runtime:openclaw:agent:main:task:todo-1",
        status: "todo",
        title: "Review DingTalk request",
      })],
      total: 1,
    });

    const healthResponse = await request.get("/api/devices/fixture-mac/collection-health");
    expect(healthResponse.status()).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      deviceId: "fixture-mac",
      status: "healthy",
      checks: [
        expect.objectContaining({ id: "device_state", message: "采集正常" }),
      ],
    });

    await expectDeviceHeartbeatAccepted(deviceToken);
    await expectDeviceDiagnostics(request, "fixture-mac");
  });

  test("accepts device-state uploaded by a real collector process", async ({ request }) => {
    await expect((await request.get("/healthz")).ok()).toBe(true);
    const deviceId = "collector-e2e-device";
    const { deviceToken } = await createLoggedInOrganizationAndDeviceToken(request, {
      deviceId,
      name: "Collector E2E Token",
    });

    const collectorHome = mkdtempSync(path.join(tmpdir(), "lorume-backend-e2e-collector-"));
    const collector = spawn(process.execPath, [
      collectorScriptPath,
      "--server-url",
      backendBaseUrl,
      "--device-id",
      deviceId,
      "--device-token",
      deviceToken,
      "--fixture",
      fixtureSnapshotPath,
      "--once",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        LORUME_COLLECTOR_HOME: collectorHome,
        LORUME_COLLECTOR_LOG_PATH: path.join(collectorHome, "collector.jsonl"),
      },
    });

    try {
      await waitForCollectorDevice(request, collector, deviceId);
      await waitForCollectorHealth(request, collector, deviceId);
      await expectDeviceDiagnostics(request, deviceId);
    } finally {
      await stopCollector(collector);
      rmSync(collectorHome, { force: true, recursive: true });
    }
  });
});

async function createLoggedInOrganizationAndDeviceToken(
  request: APIRequestContext,
  input: { deviceId?: string; name?: string } = {},
): Promise<{ deviceToken: string; organizationId: string }> {
  const email = input.deviceId ? `backend-e2e-${input.deviceId}@example.com` : "backend-e2e-owner@example.com";
  const emailCodeResponse = await request.post("/api/auth/email-code", { data: { email } });
  expect(emailCodeResponse.status()).toBe(202);
  const code = await readLatestLoginCode(email);

  const loginResponse = await request.post("/api/auth/login", { data: { code, email } });
  expect(loginResponse.status()).toBe(200);

  const organizationResponse = await request.post("/api/organizations", {
    data: { name: "Backend E2E Team", slug: "backend-e2e" },
  });
  expect(organizationResponse.status()).toBe(201);
  const organizationBody = await organizationResponse.json() as { organization: { id: string } };
  const organizationId = organizationBody.organization.id;

  const tokenResponse = await request.post(`/api/organizations/${organizationId}/device-tokens`, {
    data: { deviceId: input.deviceId ?? "fixture-mac", name: input.name ?? "Backend E2E Collector" },
  });
  expect(tokenResponse.status()).toBe(201);
  const tokenBody = await tokenResponse.json() as {
    deviceToken: { token: string; tokenHash?: string; tokenPrefix: string };
  };
  expect(tokenBody.deviceToken.token).toMatch(/^agt_device_/);
  expect(tokenBody.deviceToken.tokenPrefix).toBe(tokenBody.deviceToken.token.slice(0, 12));
  expect(tokenBody.deviceToken.tokenHash).toBeUndefined();

  return { deviceToken: tokenBody.deviceToken.token, organizationId };
}

async function expectDeviceDiagnostics(
  request: APIRequestContext,
  deviceId: string,
): Promise<{ deviceId?: string; status?: string; label?: string }> {
  const response = await request.get(`/api/devices/${encodeURIComponent(deviceId)}/diagnostics`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { deviceId?: string; status?: string; label?: string };
  expect(body.deviceId).toBe(deviceId);
  expect(["syncing", "online", "offline", "abnormal"]).toContain(body.status);
  expect(["同步中", "在线", "离线", "异常"]).toContain(body.label);
  return body;
}

async function waitForCollectorDevice(
  request: APIRequestContext,
  collector: ChildProcessWithoutNullStreams,
  deviceId: string,
): Promise<void> {
  await pollCollector("collector device-state upload", collector, async () => {
    const fleetResponse = await request.get("/api/runtime-fleet");
    if (!fleetResponse.ok()) return false;
    const body = await fleetResponse.json() as { devices?: Array<{ id?: string; hostname?: string }> };
    return body.devices?.some((device) => device.id === deviceId && Boolean(device.hostname)) ?? false;
  });
}

async function waitForCollectorHealth(
  request: APIRequestContext,
  collector: ChildProcessWithoutNullStreams,
  deviceId: string,
): Promise<void> {
  let lastHealthBody: unknown = null;
  await pollCollector("collector device-state health", collector, async () => {
    const healthResponse = await request.get(`/api/devices/${encodeURIComponent(deviceId)}/collection-health`);
    if (!healthResponse.ok()) return false;
    const body = await healthResponse.json() as { checks?: Array<{ id?: string; status?: string }> };
    lastHealthBody = body;
    return Boolean(
      body.checks?.some((check) => check.id === "device_state" && check.status === "healthy"),
    );
  }).catch((error) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nlast health:\n${JSON.stringify(lastHealthBody, null, 2)}`);
  });
}

async function pollCollector(
  label: string,
  collector: ChildProcessWithoutNullStreams,
  predicate: () => Promise<boolean>,
): Promise<void> {
  let stdout = "";
  let stderr = "";
  collector.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  collector.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (await predicate()) return;
    if (collector.exitCode !== null) {
      throw new Error(`${label} failed before completion: exit ${collector.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function stopCollector(collector: ChildProcessWithoutNullStreams): Promise<void> {
  if (collector.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      collector.kill("SIGKILL");
      resolve();
    }, 2_000);
    collector.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    collector.kill("SIGTERM");
  });
}

async function readLatestLoginCode(email: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    try {
      const payload = JSON.parse(readFileSync(loginCodePath, "utf8")) as { code?: string; email?: string };
      if (payload.email === email && payload.code) return payload.code;
    } catch {
      // Keep polling until the test email provider writes the code.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("login code was not written by backend E2E email provider");
}

async function expectDeviceHeartbeatAccepted(deviceToken: string): Promise<void> {
  const wsUrl = backendBaseUrl.replace(/^http/, "ws") + "/api/device-control/ws";
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("device websocket hello ack timed out"));
    }, 5_000);

    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "hello",
        deviceId: "fixture-mac",
        deviceToken,
        collectorVersion: "0.1.0",
      }));
    });

    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: string; deviceId?: string };
      if (message.type !== "hello.ack") return;
      expect(message.deviceId).toBe("fixture-mac");
      socket.send(JSON.stringify({
        type: "heartbeat",
        deviceId: "fixture-mac",
        summary: { deviceStateUploadedAt: deviceStateSnapshot.observedAt },
      }));
      clearTimeout(timeout);
      socket.close();
      resolve();
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
