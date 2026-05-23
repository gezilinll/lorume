import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deviceInstallerRuntimeFiles } from "../backend/device-installer-manifest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const collectorScript = path.join(repoRoot, "scripts", "lorume-device-collector.mjs");
const installerScript = path.join(repoRoot, "scripts", "install-device-collector.sh");
const fixturePath = path.join(repoRoot, "fixtures", "runtime", "runtime-fleet-device-state.sample.json");

describe("device collector scripts", () => {
  it("prints a device-state snapshot from a fixture in once mode", () => {
    const output = execFileSync(process.execPath, [
      collectorScript,
      "--once",
      "--fixture",
      fixturePath,
      "--print-only",
    ], { encoding: "utf8" });

    const snapshot = JSON.parse(output);

    expect(snapshot.device.id).toBe("fixture-mac");
    expect(snapshot.runtimes.map((runtime: { kind: string }) => runtime.kind)).toEqual(["openclaw"]);
    expect(snapshot.agents.map((agent: { name: string }) => agent.name)).toEqual(["main"]);
    expect(snapshot.tasks).toHaveLength(2);
  });

  it("collects device state by invoking the Lorume CLI contract", () => {
    const fakeDir = mkdtempSync(path.join(tmpdir(), "lorume-cli-boundary-"));
    const fakeCli = path.join(fakeDir, "lorume.mjs");
    const callsPath = path.join(fakeDir, "calls.jsonl");
    writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({
  command: "collect.device-state",
  collectedAt: "2026-05-19T00:00:00.000Z",
  device: { id: "cli-device", hostname: "cli.local", os: "darwin", architecture: "arm64", collectionStatus: "online", lastSeenAt: "2026-05-19T00:00:00.000Z", collector: { version: "test" } },
  runtimes: [],
  agents: [],
  tasks: []
}));
`);
    chmodSync(fakeCli, 0o755);

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--once",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_CLI_PATH: fakeCli },
    });

    const snapshot = JSON.parse(output);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(snapshot.device.id).toBe("cli-device");
    expect(snapshot.device).not.toHaveProperty("name");
    expect(snapshot.device).not.toHaveProperty("status");
    expect(snapshot.device).not.toHaveProperty("connectionMode");
    expect(calls).toContainEqual(["collect", "device-state", "--json"]);
  });

  it("installs the collector from a local source path and runs a once check", () => {
    const installDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-"));

    const output = execFileSync("bash", [
      installerScript,
      "--source-dir",
      repoRoot,
      "--install-dir",
      installDir,
      "--device-id",
      "test-device",
      "--ws-url",
      "ws://lorume.local/api/device-control/ws",
      "--once",
      "--no-service",
      "--fixture",
      fixturePath,
    ], { encoding: "utf8" });

    const configPath = path.join(installDir, "config.json");
    const installedCollector = path.join(installDir, "lorume-device-collector.mjs");
    const installedAdapters = path.join(installDir, "lorume-runtime-adapters.mjs");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const snapshot = JSON.parse(output.slice(output.indexOf("{")));

    expect(existsSync(installedCollector)).toBe(true);
    expect(existsSync(installedAdapters)).toBe(true);
    expect(config).toMatchObject({
      deviceId: "test-device",
      wsUrl: "ws://lorume.local/api/device-control/ws",
    });
    expect(config).not.toHaveProperty("slockServerUrl");
    expect(snapshot.device.id).toBe("test-device");
    expect(snapshot.device).not.toHaveProperty("name");
    expect(snapshot.device).not.toHaveProperty("status");
    expect(snapshot.device).not.toHaveProperty("connectionMode");
    expect(snapshot.tasks.every((task: { agentId: string }) => task.agentId.startsWith("test-device:"))).toBe(true);
  });

  it("uninstalls the collector through the installer without manual file removal", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-home-"));
    const installDir = path.join(homeDir, ".lorume", "collector");
    const logDir = path.join(homeDir, ".lorume", "logs");
    const taskSyncCachePath = path.join(homeDir, ".lorume", "task-sync-cache.json");

    execFileSync("bash", [
      installerScript,
      "--source-dir",
      repoRoot,
      "--install-dir",
      installDir,
      "--device-id",
      "test-device",
      "--no-service",
    ], { encoding: "utf8", env: { ...process.env, HOME: homeDir } });

    expect(existsSync(path.join(installDir, "install-device-collector.sh"))).toBe(true);
    expect(existsSync(path.join(installDir, "lorume-device-collector.mjs"))).toBe(true);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "collector.jsonl"), "{}\n");
    writeFileSync(taskSyncCachePath, "{\"tasks\":{}}\n");

    execFileSync(process.execPath, [
      path.join(installDir, "lorume.mjs"),
      "collector",
      "uninstall",
      "--json",
      "--install-dir",
      installDir,
    ], { encoding: "utf8", env: { ...process.env, HOME: homeDir } });

    expect(existsSync(installDir)).toBe(false);
    expect(existsSync(logDir)).toBe(false);
    expect(existsSync(taskSyncCachePath)).toBe(false);
    expect(existsSync(path.join(homeDir, ".lorume"))).toBe(false);
    rmSync(homeDir, { force: true, recursive: true });
  });

  it("stops the collector through the installer without removing installed files", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-home-"));
    const installDir = path.join(homeDir, "collector");

    execFileSync("bash", [
      installerScript,
      "--source-dir",
      repoRoot,
      "--install-dir",
      installDir,
      "--device-id",
      "test-device",
      "--no-service",
    ], { encoding: "utf8", env: { ...process.env, HOME: homeDir } });

    expect(existsSync(path.join(installDir, "lorume-device-collector.mjs"))).toBe(true);

    execFileSync("bash", [
      installerScript,
      "--install-dir",
      installDir,
      "--stop",
    ], { encoding: "utf8", env: { ...process.env, HOME: homeDir } });

    expect(existsSync(path.join(installDir, "lorume-device-collector.mjs"))).toBe(true);
    rmSync(homeDir, { force: true, recursive: true });
  });

  it("installs runtime files from local manifest paths with matching content", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "lorume-local-installer-home-"));
    const installDir = path.join(homeDir, "collector");

    try {
      execFileSync("bash", [
        installerScript,
        "--source-dir",
        repoRoot,
        "--install-dir",
        installDir,
        "--server-url",
        "http://127.0.0.1:4184",
        "--device-id",
        "manifest-device",
        "--device-token",
        "local-test-token",
        "--interval-ms",
        "60000",
        "--no-service",
      ], { encoding: "utf8", env: { ...process.env, HOME: homeDir } });

      for (const file of deviceInstallerRuntimeFiles) {
        const source = readFileSync(path.join(repoRoot, file.sourcePath), "utf8");
        const installedPath = path.join(installDir, file.fileName);
        expect(readFileSync(installedPath, "utf8")).toBe(source);
        const mode = (statSync(installedPath).mode & 0o777).toString(8).padStart(4, "0");
        expect(mode).toBe(file.mode);
      }

      const config = JSON.parse(readFileSync(path.join(installDir, "config.json"), "utf8"));
      expect(config).toMatchObject({
        deviceId: "manifest-device",
        installDir,
        intervalMs: 60000,
        serverUrl: "http://127.0.0.1:4184",
      });
      expect(config.deviceToken).toBe("local-test-token");
      expect(config).not.toHaveProperty("deviceName");
      expect(config).not.toHaveProperty("name");
      expect(config).not.toHaveProperty("connectionMode");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("posts during installer once mode when a server url is configured", async () => {
    const installDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-"));
    const { server, receivedSnapshot, baseUrl } = await startSnapshotServer();

    try {
      const output = await runCommand("bash", [
        installerScript,
        "--source-dir",
        repoRoot,
        "--install-dir",
        installDir,
        "--server-url",
        baseUrl,
        "--once",
        "--no-service",
        "--fixture",
        fixturePath,
      ]);
      const configPath = path.join(installDir, "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const snapshot = await receivedSnapshot;

      expect(output).toBe("");
      expect(config.serverUrl).toBe(baseUrl);
      expect((snapshot.device as { id: string }).id).toBe("fixture-mac");
    } finally {
      server.close();
    }
  });

  it("posts device-state snapshots with the configured Lorume device token", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-token-config-"));
    const configPath = path.join(configDir, "config.json");
    const { server, receivedSnapshot, baseUrl } = await startSnapshotServer({
      expectedAuthorization: "Bearer device-token-test",
    });
    writeFileSync(configPath, JSON.stringify({
      deviceToken: "device-token-test",
      serverUrl: baseUrl,
    }));

    try {
      const output = await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--config",
        configPath,
      ]);
      const snapshot = await receivedSnapshot;

      expect(output).toBe("");
      expect((snapshot.device as { id: string }).id).toBe("fixture-mac");
    } finally {
      server.close();
    }
  });

  it("posts changed tasks as acknowledged batches and caches their hashes", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-task-batch-config-"));
    const configPath = path.join(configDir, "config.json");
    const cachePath = path.join(configDir, "task-cache.json");
    const { server, receivedSnapshot, receivedTaskBatch, baseUrl } = await startSnapshotServer({
      expectedAuthorization: "Bearer device-token-test",
    });
    writeFileSync(configPath, JSON.stringify({
      deviceToken: "device-token-test",
      serverUrl: baseUrl,
      taskSyncCachePath: cachePath,
    }));

    try {
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--config",
        configPath,
      ]);
      const snapshot = await receivedSnapshot;
      const taskBatch = await receivedTaskBatch as {
        tasks: Array<{ hash: string; task?: { id?: string } }>;
      };
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));

      expect((snapshot.tasks as unknown[])).toEqual([]);
      expect(taskBatch).toMatchObject({
        deviceId: "fixture-mac",
        schemaVersion: "device-state-v3",
        tasks: expect.arrayContaining([
          expect.objectContaining({
            hash: expect.any(String),
            task: expect.objectContaining({ id: "fixture-mac:runtime:openclaw:agent:main:task:todo-1" }),
          }),
        ]),
      });
      const todoEntry = taskBatch.tasks.find((entry) =>
        entry.task?.id === "fixture-mac:runtime:openclaw:agent:main:task:todo-1"
      );
      expect(todoEntry).toBeDefined();
      expect(cache.tasks["fixture-mac:runtime:openclaw:agent:main:task:todo-1"]).toMatchObject({
        hash: todoEntry?.hash,
        lastAckedAt: expect.any(String),
      });
    } finally {
      server.close();
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("posts Slock tasks through task batches instead of metadata snapshots", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-slock-task-batch-config-"));
    const configPath = path.join(configDir, "config.json");
    const cachePath = path.join(configDir, "task-cache.json");
    const slockFixturePath = path.join(configDir, "slock-snapshot.json");
    const { server, receivedSnapshot, receivedTaskBatch, baseUrl } = await startSnapshotServer({
      expectedAuthorization: "Bearer device-token-test",
    });
    writeFileSync(configPath, JSON.stringify({
      deviceToken: "device-token-test",
      serverUrl: baseUrl,
      taskSyncCachePath: cachePath,
    }));
    writeFileSync(slockFixturePath, JSON.stringify(createSlockTaskSnapshot()));

    try {
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        slockFixturePath,
        "--config",
        configPath,
      ]);
      const snapshot = await receivedSnapshot;
      const taskBatch = await receivedTaskBatch as {
        tasks: Array<{ hash: string; task?: { id?: string; adapter?: { kind?: string }; channel?: { kind?: string }; raw?: { slock?: unknown } } }>;
      };
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));

      expect(snapshot.tasks).toEqual([]);
      expect(taskBatch).toMatchObject({
        deviceId: "slock-device",
        schemaVersion: "device-state-v3",
        tasks: [expect.objectContaining({
          hash: expect.any(String),
          task: expect.objectContaining({
            id: "slock-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1",
            adapter: { kind: "slock" },
            channel: { kind: "slock", externalId: "#daily-work" },
            raw: { slock: expect.objectContaining({ messageId: "msg-local-1", status: "done" }) },
          }),
        })],
      });
      const entry = taskBatch.tasks[0];
      expect(cache.tasks["slock-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1"]).toMatchObject({
        hash: entry.hash,
        lastAckedAt: expect.any(String),
      });
    } finally {
      server.close();
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("resends tasks when the task sync cache belongs to a different registration scope", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-task-cache-scope-"));
    const configPath = path.join(configDir, "config.json");
    const cachePath = path.join(configDir, "task-cache.json");
    const firstServer = await startRecordingSnapshotServer({
      expectedAuthorization: "Bearer first-device-token",
    });
    let secondServer: Awaited<ReturnType<typeof startRecordingSnapshotServer>> | undefined;

    try {
      writeFileSync(configPath, JSON.stringify({
        deviceToken: "first-device-token",
        serverUrl: firstServer.baseUrl,
        taskSyncCachePath: cachePath,
      }));
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--config",
        configPath,
      ]);

      expect(firstServer.taskBatches()).toHaveLength(1);

      secondServer = await startRecordingSnapshotServer({
        expectedAuthorization: "Bearer second-device-token",
      });
      writeFileSync(configPath, JSON.stringify({
        deviceToken: "second-device-token",
        serverUrl: secondServer.baseUrl,
        taskSyncCachePath: cachePath,
      }));
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--config",
        configPath,
      ]);

      expect(secondServer.taskBatches()).toHaveLength(1);
      expect(JSON.stringify(readFileSync(cachePath, "utf8"))).not.toContain("second-device-token");
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({
        schemaVersion: "device-state-v3",
        scope: {
          deviceId: "fixture-mac",
          tokenPrefix: "second-devic",
        },
      });
    } finally {
      firstServer.server.close();
      secondServer?.server.close();
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("reports previously acknowledged tasks that disappear from a reliable snapshot", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-task-removal-"));
    const configPath = path.join(configDir, "config.json");
    const cachePath = path.join(configDir, "task-cache.json");
    const staleTaskId = "fixture-mac:runtime:openclaw:agent:main:task:stale-1";
    const collectorServer = await startRecordingSnapshotServer({
      expectedAuthorization: "Bearer device-token-test",
    });

    try {
      writeFileSync(configPath, JSON.stringify({
        deviceToken: "device-token-test",
        serverUrl: collectorServer.baseUrl,
        taskSyncCachePath: cachePath,
      }));
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--config",
        configPath,
      ]);

      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      cache.tasks[staleTaskId] = {
        adapterKind: "openclaw",
        hash: "previously-acked-hash",
        lastAckedAt: "2026-05-21T00:00:00.000Z",
      };
      writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--config",
        configPath,
      ]);

      const batches = collectorServer.taskBatches();
      expect(batches).toHaveLength(2);
      expect(batches[1]).toMatchObject({
        deviceId: "fixture-mac",
        removedTaskIds: [staleTaskId],
        tasks: [],
      });
      expect(JSON.parse(readFileSync(cachePath, "utf8")).tasks).not.toHaveProperty(staleTaskId);
    } finally {
      collectorServer.server.close();
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("does not report tasks from another adapter as removed during partial adapter collection", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-partial-task-removal-"));
    const configPath = path.join(configDir, "config.json");
    const cachePath = path.join(configDir, "task-cache.json");
    const slockFixturePath = path.join(configDir, "slock-only-snapshot.json");
    const collectorServer = await startRecordingSnapshotServer({
      expectedAuthorization: "Bearer device-token-test",
    });

    try {
      writeFileSync(configPath, JSON.stringify({
        deviceToken: "device-token-test",
        serverUrl: collectorServer.baseUrl,
        taskSyncCachePath: cachePath,
      }));
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--config",
        configPath,
      ]);

      writeFileSync(slockFixturePath, `${JSON.stringify(createSlockTaskSnapshot("fixture-mac"), null, 2)}\n`);
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        slockFixturePath,
        "--config",
        configPath,
      ]);

      const secondRunBatches = collectorServer.taskBatches().slice(1);
      expect(secondRunBatches).not.toHaveLength(0);
      expect(secondRunBatches.flatMap((batch) => Array.isArray(batch.removedTaskIds) ? batch.removedTaskIds : [])).toEqual([]);
      expect(secondRunBatches.some((batch) => Array.isArray(batch.tasks) && batch.tasks.some((entry) => (
        (entry as { task?: { adapter?: { kind?: string } } }).task?.adapter?.kind === "slock"
      )))).toBe(true);
    } finally {
      collectorServer.server.close();
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("retries transient backend failures when posting device-state snapshots", async () => {
    const { server, receivedSnapshot, baseUrl, requestCount } = await startFlakySnapshotServer();

    try {
      const output = await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--server-url",
        baseUrl,
      ]);
      const snapshot = await receivedSnapshot;

      expect(output).toBe("");
      expect(requestCount()).toBe(2);
      expect((snapshot.device as { id: string }).id).toBe("fixture-mac");
    } finally {
      server.close();
    }
  });

  it("writes lightweight collector diagnostics for successful local once uploads", async () => {
    const { server, receivedSnapshot, baseUrl } = await startSnapshotServer();
    const logDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-success-logs-"));
    const logPath = path.join(logDir, "collector.jsonl");

    try {
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--server-url",
        baseUrl,
        "--device-token",
        "secret-device-token",
      ], { env: { ...process.env, LORUME_COLLECTOR_LOG_PATH: logPath } });
      await receivedSnapshot;

      const records = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "device_state_collected", level: "info" }),
        expect.objectContaining({ event: "device_state_upload_succeeded", level: "info" }),
      ]));
      expect(JSON.stringify(records)).not.toContain("secret-device-token");
    } finally {
      server.close();
      rmSync(logDir, { force: true, recursive: true });
    }
  });

  it("writes structured collector failure logs without leaking device tokens", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 503;
      response.end("unavailable");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const logDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-logs-"));
    const logPath = path.join(logDir, "collector.jsonl");

    try {
      await expect(runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        fixturePath,
        "--server-url",
        baseUrl,
        "--device-token",
        "secret-device-token",
      ], { env: { ...process.env, LORUME_COLLECTOR_LOG_PATH: logPath } })).rejects.toThrow("Device state snapshot post failed");

      const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const record = records.find((entry) => entry.event === "collector_run_failed");
      expect(record).toMatchObject({
        errorCode: "collector_post_failed",
        event: "collector_run_failed",
        level: "error",
        service: "lorume-device-collector",
      });
      expect(JSON.stringify(records)).not.toContain("secret-device-token");
    } finally {
      server.close();
    }
  });
});

function createSlockTaskSnapshot(deviceId = "slock-device") {
  const collectedAt = "2026-05-23T01:10:00.000Z";
  const runtimeId = `${deviceId}:runtime:codex`;
  const agentId = `${runtimeId}:agent:slock:agent-local-1`;
  return {
    collectedAt,
    device: {
      architecture: "arm64",
      collectionStatus: "online",
      collector: { version: "0.1.0" },
      hostname: "slock.local",
      id: deviceId,
      lastSeenAt: collectedAt,
      os: "darwin",
    },
    runtimes: [{
      collectionStatus: "online",
      deviceId,
      id: runtimeId,
      kind: "codex",
      lastSeenAt: collectedAt,
      name: "Codex",
    }],
    agents: [{
      collectionStatus: "online",
      id: agentId,
      lastSeenAt: collectedAt,
      name: "大卷Bot",
      runtimeId,
    }],
    tasks: [{
      adapter: { kind: "slock" },
      agentId,
      agentReply: "今天的主要风险是接口稳定性和排期收敛。",
      assignee: { name: "大卷Bot", externalId: "agent-local-1" },
      channel: { kind: "slock", externalId: "#daily-work" },
      conversation: { title: "日常工作", externalId: "#daily-work", lastActivityAt: "2026-05-23T01:05:00.000Z" },
      createdAt: "2026-05-23T01:00:00.000Z",
      creator: { name: "张良", externalId: "user-1" },
      id: `${agentId}:task:msg-local-1`,
      raw: { slock: { messageId: "msg-local-1", status: "done", taskNumber: "1001" } },
      status: "done",
      taskType: "conversation",
      updatedAt: "2026-05-23T01:05:00.000Z",
      userMessage: "帮我整理今天的项目风险",
    }],
  };
}

function runNodeScript(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return runCommand(process.execPath, args, options);
}

function runCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.on("close", (status) => {
      if (status === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error((stderr || stdout).trim()));
    });
  });
}

async function startRecordingSnapshotServer(options: { expectedAuthorization?: string } = {}): Promise<{
  baseUrl: string;
  server: Server;
  snapshots: () => Array<Record<string, unknown>>;
  taskBatches: () => Array<Record<string, unknown>>;
}> {
  const snapshots: Array<Record<string, unknown>> = [];
  const taskBatches: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    if (request.url !== "/api/device-state-snapshots" && request.url !== "/api/device-task-batches") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    if (options.expectedAuthorization && request.headers.authorization !== options.expectedAuthorization) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      if (request.url === "/api/device-state-snapshots") snapshots.push(parsed);
      else taskBatches.push(parsed);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        acked: Array.isArray(parsed.tasks)
          ? parsed.tasks.map((entry: { hash?: string; task?: { id?: string } }) => ({ hash: entry.hash, id: entry.task?.id }))
          : [],
        removed: Array.isArray(parsed.removedTaskIds)
          ? parsed.removedTaskIds.map((id: string) => ({ id }))
          : [],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    snapshots: () => [...snapshots],
    taskBatches: () => [...taskBatches],
  };
}

async function startSnapshotServer(options: { expectedAuthorization?: string } = {}): Promise<{
  baseUrl: string;
  receivedSnapshot: Promise<Record<string, unknown>>;
  receivedTaskBatch: Promise<Record<string, unknown>>;
  server: Server;
}> {
  let resolveSnapshot: (snapshot: Record<string, unknown>) => void = () => undefined;
  let resolveTaskBatch: (batch: Record<string, unknown>) => void = () => undefined;
  const receivedSnapshot = new Promise<Record<string, unknown>>((resolve) => {
    resolveSnapshot = resolve;
  });
  const receivedTaskBatch = new Promise<Record<string, unknown>>((resolve) => {
    resolveTaskBatch = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url !== "/api/device-state-snapshots" && request.url !== "/api/device-task-batches") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    if (options.expectedAuthorization && request.headers.authorization !== options.expectedAuthorization) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      if (request.url === "/api/device-state-snapshots") {
        resolveSnapshot(parsed);
      } else {
        resolveTaskBatch(parsed);
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        acked: Array.isArray(parsed.tasks)
          ? parsed.tasks.map((entry: { hash?: string; task?: { id?: string } }) => ({ hash: entry.hash, id: entry.task?.id }))
          : [],
        removed: Array.isArray(parsed.removedTaskIds)
          ? parsed.removedTaskIds.map((id: string) => ({ id }))
          : [],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    receivedSnapshot,
    receivedTaskBatch,
    server,
  };
}

async function startFlakySnapshotServer(): Promise<{
  baseUrl: string;
  receivedSnapshot: Promise<Record<string, unknown>>;
  requestCount: () => number;
  server: Server;
}> {
  let count = 0;
  let resolveSnapshot: (snapshot: Record<string, unknown>) => void = () => undefined;
  const receivedSnapshot = new Promise<Record<string, unknown>>((resolve) => {
    resolveSnapshot = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url !== "/api/device-state-snapshots" && request.url !== "/api/device-task-batches") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    if (request.url === "/api/device-task-batches") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          acked: Array.isArray(parsed.tasks)
            ? parsed.tasks.map((entry: { hash?: string; task?: { id?: string } }) => ({ hash: entry.hash, id: entry.task?.id }))
            : [],
        }));
      });
      return;
    }
    count += 1;
    if (count === 1) {
      response.statusCode = 503;
      response.end("retry");
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      resolveSnapshot(JSON.parse(body));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    receivedSnapshot,
    requestCount: () => count,
    server,
  };
}
