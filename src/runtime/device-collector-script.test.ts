import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { deviceInstallerRuntimeFiles } from "../backend/device-installer-manifest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const collectorScript = path.join(repoRoot, "scripts", "lorume-device-collector.mjs");
const installerScript = path.join(repoRoot, "scripts", "install-device-collector.sh");
const fixturePath = path.join(repoRoot, "fixtures", "runtime", "runtime-fleet-device-state.sample.json");

describe("device collector scripts", () => {
  it("normalizes collector local IPs for user-facing device network fields", async () => {
    // @ts-expect-error Test imports the collector-owned .mjs helper directly.
    const { normalizeLocalIpsForDisplay } = await import("../../scripts/local-ip-normalization.mjs") as {
      normalizeLocalIpsForDisplay: (entries: Array<{ address: string; internal: boolean }>) => string[];
    };

    expect(normalizeLocalIpsForDisplay([
      { address: "127.0.0.1", internal: true },
      { address: "10.1.67.125", internal: false },
      { address: "192.168.107.0", internal: false },
      { address: "192.168.139.3", internal: false },
      { address: "172.17.0.1", internal: false },
      { address: "fe80::2d47:7ef3:5ff2:3f4a", internal: false },
      { address: "fd07:b51a:cc66:0:a617:db5e:ab7:e9f1", internal: false },
    ])).toEqual(["10.1.67.125", "192.168.139.3"]);
    expect(normalizeLocalIpsForDisplay([
      { address: "fe80::2d47:7ef3:5ff2:3f4a", internal: false },
      { address: "fd07:b51a:cc66:0:a617:db5e:ab7:e9f1", internal: false },
      { address: "2601:646:8f80:6180::1", internal: false },
      { address: "2601:646:8f80:6180::2", internal: false },
    ])).toEqual(["2601:646:8f80:6180::1"]);
  });

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

  it("uses a safer default service interval when the installer interval is not provided", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "lorume-default-interval-home-"));
    const installDir = path.join(homeDir, "collector");

    try {
      execFileSync("bash", [
        installerScript,
        "--source-dir",
        repoRoot,
        "--install-dir",
        installDir,
        "--device-id",
        "interval-device",
        "--no-service",
      ], { encoding: "utf8", env: { ...process.env, HOME: homeDir } });

      const config = JSON.parse(readFileSync(path.join(installDir, "config.json"), "utf8"));
      expect(config.intervalMs).toBe(300000);
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

  it("keeps sending control heartbeats while device-state collection is in progress", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lorume-heartbeat-during-collection-"));
    const fakeCli = path.join(tempDir, "lorume.mjs");
    const configPath = path.join(tempDir, "config.json");
    const controlServer = await startControlAndSnapshotServer();
    const collector = createCollectorProcessTracker();

    writeFileSync(fakeCli, `await new Promise((resolve) => setTimeout(resolve, 900));
console.log(JSON.stringify(${JSON.stringify(createMinimalSnapshot("heartbeat-device"))}));
`);
    writeFileSync(configPath, JSON.stringify({
      deviceId: "heartbeat-device",
      deviceToken: "heartbeat-token",
      serverUrl: controlServer.baseUrl,
    }));

    try {
      collector.child = spawn(process.execPath, [
        collectorScript,
        "--config",
        configPath,
        "--interval-ms",
        "100",
      ], {
        cwd: repoRoot,
        env: { ...process.env, LORUME_CLI_PATH: fakeCli },
        stdio: ["ignore", "pipe", "pipe"],
      });

      await waitForCondition(
        () => controlServer.heartbeatBeforeFirstSnapshot(),
        "heartbeat before first device-state snapshot",
        2_000,
      );
    } finally {
      await collector.stop();
      controlServer.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("uses a bundled fallback control client when the Node runtime has no global WebSocket", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lorume-heartbeat-fallback-"));
    const fakeCli = path.join(tempDir, "lorume.mjs");
    const configPath = path.join(tempDir, "config.json");
    const wrapperPath = path.join(tempDir, "run-without-global-websocket.mjs");
    const controlServer = await startControlAndSnapshotServer();
    const collector = createCollectorProcessTracker();

    writeFileSync(fakeCli, `console.log(JSON.stringify(${JSON.stringify(createMinimalSnapshot("fallback-device"))}));\n`);
    writeFileSync(configPath, JSON.stringify({
      deviceId: "fallback-device",
      deviceToken: "fallback-token",
      serverUrl: controlServer.baseUrl,
    }));
    writeFileSync(wrapperPath, `globalThis.WebSocket = undefined;
process.argv = [process.execPath, ${JSON.stringify(collectorScript)}, "--config", ${JSON.stringify(configPath)}, "--interval-ms", "100"];
await import(${JSON.stringify(pathToFileURL(collectorScript).href)});
`);

    try {
      collector.child = spawn(process.execPath, [wrapperPath], {
        cwd: repoRoot,
        env: { ...process.env, LORUME_CLI_PATH: fakeCli },
        stdio: ["ignore", "pipe", "pipe"],
      });

      await waitForCondition(
        () => controlServer.messages().some((message) => message.type === "heartbeat" && message.deviceId === "fallback-device"),
        "fallback heartbeat",
        2_000,
      );
    } finally {
      await collector.stop();
      controlServer.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("self-upgrades from a restricted collector upgrade request", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lorume-self-upgrade-"));
    const installDir = path.join(tempDir, "collector");
    const fakeCli = path.join(tempDir, "lorume.mjs");
    const configPath = path.join(installDir, "config.json");
    const taskSyncCachePath = path.join(tempDir, "task-cache.json");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(fakeCli, `console.log(JSON.stringify(${JSON.stringify(createMinimalSnapshot("upgrade-device"))}));\n`);
    chmodSync(fakeCli, 0o755);
    for (const file of deviceInstallerRuntimeFiles) {
      writeFileSync(path.join(installDir, file.fileName), `// old ${file.fileName}\n`);
    }
    writeFileSync(configPath, JSON.stringify({
      deviceId: "upgrade-device",
      deviceToken: "upgrade-token",
      installDir,
      serverUrl: "http://127.0.0.1:0",
      taskSyncCachePath,
    }));
    writeFileSync(taskSyncCachePath, "{\"tasks\":{}}\n");
    const packageFiles = createUpgradePackageFiles("0.1.5");
    const upgradeServer = await startCollectorUpgradeServer({
      deviceId: "upgrade-device",
      packageFiles,
      targetVersion: "0.1.5",
    });
    const collector = createCollectorProcessTracker();

    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(configPath, JSON.stringify({ ...config, serverUrl: upgradeServer.baseUrl }, null, 2));
      collector.child = spawn(process.execPath, [
        collectorScript,
        "--config",
        configPath,
        "--interval-ms",
        "100",
      ], {
        cwd: repoRoot,
        env: { ...process.env, LORUME_CLI_PATH: fakeCli },
        stdio: ["ignore", "pipe", "pipe"],
      });

      await waitForCondition(
        () => upgradeServer.progressMessages().some((message) => message.stage === "restart_pending"),
        "collector restart_pending upgrade progress",
        4_000,
      );
      await waitForProcessExit(collector.child, 2_000);

      for (const file of deviceInstallerRuntimeFiles) {
        expect(readFileSync(path.join(installDir, file.fileName), "utf8")).toBe(packageFiles[file.fileName]);
        expect(existsSync(path.join(installDir, ".previous", "opjob_upgrade", file.fileName))).toBe(true);
      }
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        deviceId: "upgrade-device",
        deviceToken: "upgrade-token",
        installDir,
      });
      expect(readFileSync(taskSyncCachePath, "utf8")).toContain("\"tasks\"");
      expect(JSON.parse(readFileSync(path.join(installDir, "upgrade-state.json"), "utf8"))).toMatchObject({
        jobId: "opjob_upgrade",
        stage: "restart_pending",
        targetVersion: "0.1.5",
      });
    } finally {
      await collector.stop();
      upgradeServer.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("runs a restricted OpenClaw Agent analysis request and returns parsed JSON result", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lorume-agent-analysis-"));
    const installDir = path.join(tempDir, "collector");
    const binDir = path.join(tempDir, ".local", "state", "fnm_multishells", "session_9999999999999", "bin");
    const fakeCli = path.join(tempDir, "lorume.mjs");
    const configPath = path.join(installDir, "config.json");
    const openclawPath = path.join(binDir, "openclaw");
    const openclawCallsPath = path.join(tempDir, "openclaw-calls.jsonl");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(fakeCli, `console.log(JSON.stringify(${JSON.stringify(createMinimalSnapshot("analysis-device"))}));\n`);
    chmodSync(fakeCli, 0o755);
    writeFileSync(openclawPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(openclawCallsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({
  runId: "run_123",
  status: "ok",
  result: {
    payloads: [{
      text: JSON.stringify({
        schemaVersion: "agent-analysis-v1",
        promptKind: "daily_operation_review",
        summary: "Queue triage dominated the day.",
        taskTypeBreakdown: [],
        typicalCases: [],
        risks: [],
        dataQualityNotes: ["Only sampled tasks were reviewed."]
      })
    }],
    meta: {
      durationMs: 10842,
      agentMeta: {
        provider: "openai",
        model: "gpt-test",
        usage: { input: 1, output: 2, cacheRead: 0, total: 3 }
      },
      systemPromptReport: { shouldNotLeak: true }
    }
  }
}));
`);
    chmodSync(openclawPath, 0o755);
    writeFileSync(configPath, JSON.stringify({
      deviceId: "analysis-device",
      deviceToken: "analysis-token",
      installDir,
    }));
    const analysisServer = await startCollectorAnalysisServer({ deviceId: "analysis-device" });
    const collector = createCollectorProcessTracker();

    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(configPath, JSON.stringify({ ...config, serverUrl: analysisServer.baseUrl }, null, 2));
      collector.child = spawn(process.execPath, [
        collectorScript,
        "--config",
        configPath,
        "--interval-ms",
        "100",
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          LORUME_COLLECTOR_HOME: tempDir,
          LORUME_CLI_PATH: fakeCli,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      await waitForCondition(
        () => analysisServer.resultMessages().some((message) => message.status === "succeeded"),
        "collector agent analysis result",
        4_000,
      );

      const hello = analysisServer.controlMessages().find((message) => message.type === "hello");
      const result = analysisServer.resultMessages()[0];
      const progressStages = analysisServer.progressMessages().map((message) => message.stage);
      const openclawArgs = readFileSync(openclawCallsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

      expect(hello).toMatchObject({
        analysis: {
          promptKinds: ["daily_operation_review"],
          protocolVersion: 1,
          runtimes: ["openclaw"],
          supported: true,
        },
      });
      expect(progressStages).toEqual(expect.arrayContaining(["accepted", "executing", "result_received"]));
      expect(result).toMatchObject({
        analysis: {
          schemaVersion: "agent-analysis-v1",
          summary: "Queue triage dominated the day.",
        },
        deviceId: "analysis-device",
        durationMs: 10842,
        jobId: "opjob_analysis",
        modelMetadata: {
          model: "gpt-test",
          provider: "openai",
          usage: { input: 1, output: 2, cacheRead: 0, total: 3 },
        },
        nonce: "analysis_nonce",
        operationId: "op_analysis",
        runtimeRunId: "run_123",
        status: "succeeded",
        type: "agent.analysis.result",
      });
      expect(openclawArgs).toHaveLength(1);
      expect(openclawArgs[0]).toEqual([
        "agent",
        "--agent",
        "main",
        "--session-id",
        "lorume-analysis-opjob_analysis",
        "--message",
        "Return JSON only.",
        "--json",
        "--thinking",
        "off",
        "--timeout",
        "120",
      ]);
      expect(openclawArgs[0]).not.toContain("--deliver");
    } finally {
      await collector.stop();
      analysisServer.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects unsafe collector package manifest paths without replacing files", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lorume-self-upgrade-unsafe-"));
    const installDir = path.join(tempDir, "collector");
    const fakeCli = path.join(tempDir, "lorume.mjs");
    const configPath = path.join(installDir, "config.json");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(fakeCli, `console.log(JSON.stringify(${JSON.stringify(createMinimalSnapshot("unsafe-upgrade-device"))}));\n`);
    chmodSync(fakeCli, 0o755);
    for (const file of deviceInstallerRuntimeFiles) {
      writeFileSync(path.join(installDir, file.fileName), `// old ${file.fileName}\n`);
    }
    writeFileSync(configPath, JSON.stringify({
      deviceId: "unsafe-upgrade-device",
      deviceToken: "upgrade-token",
      installDir,
    }));
    const packageFiles = createUpgradePackageFiles("0.1.5");
    const upgradeServer = await startCollectorUpgradeServer({
      deviceId: "unsafe-upgrade-device",
      manifestOverride: {
        fileName: "lorume-device-collector.mjs",
        path: "../config.json",
      },
      packageFiles,
      targetVersion: "0.1.5",
    });
    const collector = createCollectorProcessTracker();

    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(configPath, JSON.stringify({ ...config, serverUrl: upgradeServer.baseUrl }, null, 2));
      collector.child = spawn(process.execPath, [
        collectorScript,
        "--config",
        configPath,
        "--interval-ms",
        "100",
      ], {
        cwd: repoRoot,
        env: { ...process.env, LORUME_CLI_PATH: fakeCli },
        stdio: ["ignore", "pipe", "pipe"],
      });

      await waitForCondition(
        () => upgradeServer.progressMessages().some((message) => message.stage === "failed"),
        "collector failed upgrade progress",
        4_000,
      );

      expect(readFileSync(path.join(installDir, "lorume-device-collector.mjs"), "utf8")).toBe("// old lorume-device-collector.mjs\n");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        deviceId: "unsafe-upgrade-device",
        deviceToken: "upgrade-token",
      });
    } finally {
      await collector.stop();
      upgradeServer.close();
      rmSync(tempDir, { force: true, recursive: true });
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

  it("posts runtime Skill and schedule snapshots separately from device metadata", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-runtime-skill-probe-config-"));
    const fakeCli = path.join(configDir, "lorume.mjs");
    const configPath = path.join(configDir, "config.json");
    const collectorServer = await startRecordingSnapshotServer({
      expectedAuthorization: "Bearer device-token-test",
    });
    const snapshot = {
      ...createMinimalSnapshot("skill-probe-device"),
      runtimes: [{
        collectionStatus: "online",
        deviceId: "skill-probe-device",
        id: "skill-probe-device:runtime:openclaw",
        kind: "openclaw",
        name: "OpenClaw Gateway",
      }],
      agents: [{
        collectionStatus: "online",
        id: "skill-probe-device:runtime:openclaw:agent:main",
        name: "main",
        runtimeId: "skill-probe-device:runtime:openclaw",
      }],
      runtimeSkillProbes: [{
        deviceId: "skill-probe-device",
        runtimeId: "skill-probe-device:runtime:openclaw",
        runtimeKind: "openclaw",
        status: "succeeded",
        observedAt: "2026-05-27T08:00:00.000Z",
        skills: [{
          name: "weather",
          description: "Weather lookup",
          scope: "runtime",
          available: true,
          builtIn: true,
          agentIds: [],
        }],
      }],
      runtimeScheduleProbes: [{
        deviceId: "skill-probe-device",
        runtimeId: "skill-probe-device:runtime:openclaw",
        runtimeKind: "openclaw",
        status: "succeeded",
        observedAt: "2026-05-29T08:00:00.000Z",
        schedules: [{
          key: "skill-probe-device:runtime:openclaw:schedule:daily-summary",
          sourceId: "daily-summary",
          name: "Daily summary",
          agentIds: ["skill-probe-device:runtime:openclaw:agent:main"],
          enabled: true,
          expression: "0 9 * * *",
          timezone: "Asia/Shanghai",
        }],
      }],
    };
    writeFileSync(fakeCli, `#!/usr/bin/env node
console.log(JSON.stringify({
  command: "collect.device-state",
  ...${JSON.stringify(snapshot)}
}));
`);
    chmodSync(fakeCli, 0o755);
    writeFileSync(configPath, JSON.stringify({
      deviceToken: "device-token-test",
      lorumeCliPath: fakeCli,
      serverUrl: collectorServer.baseUrl,
    }));

    try {
      await runNodeScript([
        collectorScript,
        "--once",
        "--config",
        configPath,
      ]);

      expect(collectorServer.snapshots()[0]).not.toHaveProperty("runtimeSkillProbes");
      expect(collectorServer.snapshots()[0]).not.toHaveProperty("runtimeScheduleProbes");
      expect(collectorServer.runtimeSkillProbes()).toEqual([
        expect.objectContaining({
          deviceId: "skill-probe-device",
          runtimeId: "skill-probe-device:runtime:openclaw",
          status: "succeeded",
        }),
      ]);
      expect(collectorServer.runtimeScheduleProbes()).toEqual([
        expect.objectContaining({
          deviceId: "skill-probe-device",
          runtimeId: "skill-probe-device:runtime:openclaw",
          status: "succeeded",
          schedules: [expect.objectContaining({ sourceId: "daily-summary" })],
        }),
      ]);
    } finally {
      collectorServer.server.close();
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

  it("posts Codex tasks through task batches instead of metadata snapshots", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-codex-task-batch-config-"));
    const configPath = path.join(configDir, "config.json");
    const cachePath = path.join(configDir, "task-cache.json");
    const codexFixturePath = path.join(configDir, "codex-snapshot.json");
    const { server, receivedSnapshot, receivedTaskBatch, baseUrl } = await startSnapshotServer({
      expectedAuthorization: "Bearer device-token-test",
    });
    writeFileSync(configPath, JSON.stringify({
      deviceToken: "device-token-test",
      serverUrl: baseUrl,
      taskSyncCachePath: cachePath,
    }));
    writeFileSync(codexFixturePath, JSON.stringify(createCodexTaskSnapshot()));

    try {
      await runNodeScript([
        collectorScript,
        "--once",
        "--fixture",
        codexFixturePath,
        "--config",
        configPath,
      ]);
      const snapshot = await receivedSnapshot;
      const taskBatch = await receivedTaskBatch as {
        tasks: Array<{ hash: string; task?: { id?: string; adapter?: { kind?: string }; channel?: unknown; conversation?: unknown; raw?: { codex?: unknown } } }>;
      };
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));

      expect(snapshot.tasks).toEqual([]);
      expect(taskBatch).toMatchObject({
        deviceId: "codex-device",
        schemaVersion: "device-state-v3",
        tasks: [expect.objectContaining({
          hash: expect.any(String),
          task: expect.objectContaining({
            id: "codex-device:runtime:codex:agent:codex:local:task:thread-native-done",
            adapter: { kind: "codex" },
            raw: { codex: expect.objectContaining({ threadId: "thread-native-done", source: "exec" }) },
          }),
        })],
      });
      expect(taskBatch.tasks[0].task).not.toHaveProperty("channel");
      expect(taskBatch.tasks[0].task).not.toHaveProperty("conversation");
      const entry = taskBatch.tasks[0];
      expect(cache.tasks["codex-device:runtime:codex:agent:codex:local:task:thread-native-done"]).toMatchObject({
        adapterKind: "codex",
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
        expect.objectContaining({ event: "collector_run_started", level: "info", runId: expect.any(String) }),
        expect.objectContaining({ event: "device_state_collected", level: "info" }),
        expect.objectContaining({ event: "device_state_upload_succeeded", level: "info" }),
        expect.objectContaining({
          batchCount: expect.any(Number),
          changedTaskCount: expect.any(Number),
          cliDurationMs: expect.any(Number),
          event: "collector_run_finished",
          level: "info",
          metadataPostDurationMs: expect.any(Number),
          removedTaskCount: expect.any(Number),
          taskBatchPostDurationMs: expect.any(Number),
          totalDurationMs: expect.any(Number),
        }),
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

  it("skips overlapping collector runs across processes using a shared lock", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-lock-"));
    const fakeCli = path.join(configDir, "lorume.mjs");
    const configPath = path.join(configDir, "config.json");
    const callsPath = path.join(configDir, "calls.jsonl");
    const lockPath = path.join(configDir, "run.lock");
    const logPath = path.join(configDir, "collector.jsonl");
    writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + "\\n");
await new Promise((resolve) => setTimeout(resolve, 800));
console.log(JSON.stringify({
  command: "collect.device-state",
  collectedAt: "2026-05-19T00:00:00.000Z",
  device: { id: "locked-device", hostname: "locked.local", os: "darwin", collectionStatus: "online", lastSeenAt: "2026-05-19T00:00:00.000Z", collector: { version: "test" } },
  runtimes: [],
  agents: [],
  tasks: []
}));
`);
    chmodSync(fakeCli, 0o755);
    writeFileSync(configPath, JSON.stringify({
      collectorLockPath: lockPath,
      logPath,
      lorumeCliPath: fakeCli,
    }));

    try {
      const firstRun = runNodeScript([
        collectorScript,
        "--once",
        "--print-only",
        "--config",
        configPath,
      ]);
      await waitForCondition(() => existsSync(callsPath), "fake CLI to start");

      const secondOutput = await runNodeScript([
        collectorScript,
        "--once",
        "--print-only",
        "--config",
        configPath,
      ]);
      const firstOutput = await firstRun;
      const calls = readFileSync(callsPath, "utf8").trim().split("\n");
      const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

      expect(JSON.parse(firstOutput).device.id).toBe("locked-device");
      expect(secondOutput.trim()).toBe("");
      expect(calls).toHaveLength(1);
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: "collector_run_skipped",
          level: "info",
          reason: "collector_run_in_progress",
          runId: expect.any(String),
        }),
      ]));
    } finally {
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("reclaims a stale collector lock when the recorded process is gone", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-stale-lock-"));
    const fakeCli = path.join(configDir, "lorume.mjs");
    const configPath = path.join(configDir, "config.json");
    const callsPath = path.join(configDir, "calls.jsonl");
    const lockPath = path.join(configDir, "run.lock");
    writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({
  command: "collect.device-state",
  collectedAt: "2026-05-19T00:00:00.000Z",
  device: { id: "stale-lock-device", hostname: "stale.local", os: "darwin", collectionStatus: "online", lastSeenAt: "2026-05-19T00:00:00.000Z", collector: { version: "test" } },
  runtimes: [],
  agents: [],
  tasks: []
}));
`);
    chmodSync(fakeCli, 0o755);
    writeFileSync(lockPath, `${JSON.stringify({
      collectorVersion: "0.1.0",
      mode: "service",
      pid: 99999999,
      runId: "stale-run",
      startedAt: new Date().toISOString(),
    })}\n`);
    writeFileSync(configPath, JSON.stringify({
      collectorLockPath: lockPath,
      lorumeCliPath: fakeCli,
    }));

    try {
      const output = await runNodeScript([
        collectorScript,
        "--once",
        "--print-only",
        "--config",
        configPath,
      ]);
      const calls = readFileSync(callsPath, "utf8").trim().split("\n");

      expect(JSON.parse(output).device.id).toBe("stale-lock-device");
      expect(calls).toHaveLength(1);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("uses configured collection timeout for the CLI subprocess", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-timeout-"));
    const fakeCli = path.join(configDir, "lorume.mjs");
    const configPath = path.join(configDir, "config.json");
    const logPath = path.join(configDir, "collector.jsonl");
    writeFileSync(fakeCli, `#!/usr/bin/env node
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({
  command: "collect.device-state",
  collectedAt: "2026-05-19T00:00:00.000Z",
  device: { id: "timeout-device", hostname: "timeout.local", os: "darwin", collectionStatus: "online", lastSeenAt: "2026-05-19T00:00:00.000Z", collector: { version: "test" } },
  runtimes: [],
  agents: [],
  tasks: []
}));
`);
    chmodSync(fakeCli, 0o755);
    writeFileSync(configPath, JSON.stringify({
      collectionTimeoutMs: 20,
      logPath,
      lorumeCliPath: fakeCli,
    }));

    try {
      await expect(runNodeScript([
        collectorScript,
        "--once",
        "--config",
        configPath,
      ])).rejects.toThrow(/ETIMEDOUT|timed out/i);
      const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          durationMs: expect.any(Number),
          errorCode: "collector_run_failed",
          event: "collector_run_failed",
        }),
      ]));
    } finally {
      rmSync(configDir, { force: true, recursive: true });
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

function createCodexTaskSnapshot(deviceId = "codex-device") {
  const collectedAt = "2026-05-24T01:10:00.000Z";
  const runtimeId = `${deviceId}:runtime:codex`;
  const agentId = `${runtimeId}:agent:codex:local`;
  return {
    collectedAt,
    device: {
      architecture: "arm64",
      collectionStatus: "online",
      collector: { version: "0.1.0" },
      hostname: "codex.local",
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
      name: "Codex",
      runtimeId,
    }],
    tasks: [{
      adapter: { kind: "codex" },
      agentId,
      agentReply: "仓库状态正常，没有发现阻塞。",
      createdAt: "2026-05-24T01:00:00.000Z",
      id: `${agentId}:task:thread-native-done`,
      raw: {
        codex: {
          threadId: "thread-native-done",
          rolloutPath: "sessions/native-done.jsonl",
          source: "exec",
          model: "gpt-5.4",
          cwdKind: "codex-native-or-other",
          tokensUsed: 1280,
          git: { branch: "main", sha: "abc1234", origin: "git@example.com:fixture/lorume.git" },
        },
      },
      status: "done",
      taskType: "conversation",
      updatedAt: "2026-05-24T01:05:00.000Z",
      userMessage: "帮我总结一下当前仓库状态",
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

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createMinimalSnapshot(deviceId: string): Record<string, unknown> {
  const collectedAt = "2026-05-26T01:00:00.000Z";
  return {
    collectedAt,
    device: {
      architecture: "arm64",
      collectionStatus: "online",
      collector: { version: "test" },
      hostname: `${deviceId}.local`,
      id: deviceId,
      lastSeenAt: collectedAt,
      os: "darwin",
    },
    runtimes: [],
    agents: [],
    tasks: [],
  };
}

function createCollectorProcessTracker(): {
  child?: ReturnType<typeof spawn>;
  stop: () => Promise<void>;
} {
  return {
    child: undefined,
    stop() {
      if (!this.child || this.child.killed || this.child.exitCode !== null) return Promise.resolve();
      const child = this.child;
      child.kill("SIGTERM");
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          resolve();
        }, 500);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function startControlAndSnapshotServer(): Promise<{
  baseUrl: string;
  close: () => void;
  heartbeatBeforeFirstSnapshot: () => boolean;
  messages: () => Array<Record<string, unknown>>;
}> {
  const controlMessages: Array<Record<string, unknown>> = [];
  let firstSnapshotReceived = false;
  let heartbeatBeforeSnapshot = false;

  const server = createServer((request, response) => {
    if (request.url !== "/api/device-state-snapshots" && request.url !== "/api/device-task-batches") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    request.resume();
    request.on("end", () => {
      if (request.url === "/api/device-state-snapshots") firstSnapshotReceived = true;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, acked: [] }));
    });
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/device-control/ws") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (webSocket) => {
    webSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      controlMessages.push(message);
      if (message.type === "hello") {
        webSocket.send(JSON.stringify({ type: "hello.ack", deviceId: message.deviceId }));
      }
      if (message.type === "heartbeat" && !firstSnapshotReceived) heartbeatBeforeSnapshot = true;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close() {
      webSocketServer.close();
      server.close();
    },
    heartbeatBeforeFirstSnapshot: () => heartbeatBeforeSnapshot,
    messages: () => [...controlMessages],
  };
}

function createUpgradePackageFiles(version: string): Record<string, string> {
  return {
    "local-ip-normalization.mjs": `export function normalizeLocalIpsForDisplay(entries) { return entries.map((entry) => entry.address).filter(Boolean); }\n// upgraded ${version}\n`,
    "lorume-device-collector.mjs": `#!/usr/bin/env node\nconsole.log("upgraded collector ${version}");\n`,
    "lorume-runtime-adapters.mjs": `export function createRuntimeAdapters() { return []; }\n// upgraded ${version}\n`,
    "lorume.mjs": `#!/usr/bin/env node\nconsole.log("upgraded lorume ${version}");\n`,
  };
}

async function startCollectorUpgradeServer(options: {
  deviceId: string;
  manifestOverride?: { fileName: string; path: string };
  packageFiles: Record<string, string>;
  targetVersion: string;
}): Promise<{
  baseUrl: string;
  close: () => void;
  progressMessages: () => Array<Record<string, unknown>>;
}> {
  const progressMessages: Array<Record<string, unknown>> = [];
  let baseUrl = "";
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/api/device-state-snapshots" || requestUrl.pathname === "/api/device-task-batches") {
      request.resume();
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, acked: [] }));
      });
      return;
    }
    if (requestUrl.pathname === "/api/device-collector/manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(createUpgradeManifest(options)));
      return;
    }
    const fileMatch = requestUrl.pathname.match(/^\/api\/device-collector\/files\/([^/]+)$/);
    if (fileMatch) {
      const fileName = decodeURIComponent(fileMatch[1] ?? "");
      const body = options.packageFiles[fileName];
      if (!body) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(body);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/device-control/ws") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (webSocket) => {
    webSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "hello") {
        webSocket.send(JSON.stringify({ type: "hello.ack", deviceId: message.deviceId }));
        webSocket.send(JSON.stringify({
          type: "collector.upgrade.request",
          currentVersion: "0.1.2",
          deadlineAt: "2026-06-02T09:05:00.000Z",
          deviceId: options.deviceId,
          jobId: "opjob_upgrade",
          manifestUrl: `${baseUrl}/api/device-collector/manifest.json`,
          nonce: "upgrade_nonce",
          operationId: "op_upgrade",
          packageBaseUrl: `${baseUrl}/api/device-collector/files`,
          protocolVersion: 1,
          targetVersion: options.targetVersion,
        }));
      } else if (message.type === "collector.upgrade.progress") {
        progressMessages.push(message);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close() {
      webSocketServer.close();
      server.close();
    },
    progressMessages: () => [...progressMessages],
  };
}

async function startCollectorAnalysisServer(options: { deviceId: string }): Promise<{
  baseUrl: string;
  close: () => void;
  controlMessages: () => Array<Record<string, unknown>>;
  progressMessages: () => Array<Record<string, unknown>>;
  resultMessages: () => Array<Record<string, unknown>>;
}> {
  const controlMessages: Array<Record<string, unknown>> = [];
  const progressMessages: Array<Record<string, unknown>> = [];
  const resultMessages: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    if (request.url !== "/api/device-state-snapshots" && request.url !== "/api/device-task-batches") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, acked: [] }));
    });
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/device-control/ws") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (webSocket) => {
    webSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      controlMessages.push(message);
      if (message.type === "hello") {
        webSocket.send(JSON.stringify({ type: "hello.ack", deviceId: message.deviceId }));
        const request = {
          type: "agent.analysis.request",
          protocolVersion: 1,
          operationId: "op_analysis",
          jobId: "opjob_analysis",
          deviceId: options.deviceId,
          runtimeId: `${options.deviceId}:runtime:openclaw`,
          agentId: `${options.deviceId}:runtime:openclaw:agent:main`,
          openclawAgentId: "main",
          promptKind: "daily_operation_review",
          promptVersion: "openclaw-agent-analysis-v1",
          periodStart: "2026-06-01T16:00:00.000Z",
          periodEnd: "2026-06-02T16:00:00.000Z",
          prompt: "Return JSON only.",
          deadlineAt: "2026-06-03T08:05:00.000Z",
          timeoutSeconds: 120,
          nonce: "analysis_nonce",
        };
        webSocket.send(JSON.stringify(request));
        webSocket.send(JSON.stringify(request));
      } else if (message.type === "agent.analysis.progress") {
        progressMessages.push(message);
      } else if (message.type === "agent.analysis.result") {
        resultMessages.push(message);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close() {
      webSocketServer.close();
      server.close();
    },
    controlMessages: () => [...controlMessages],
    progressMessages: () => [...progressMessages],
    resultMessages: () => [...resultMessages],
  };
}

function createUpgradeManifest(options: {
  manifestOverride?: { fileName: string; path: string };
  packageFiles: Record<string, string>;
  targetVersion: string;
}) {
  return {
    schemaVersion: "collector-package-v1",
    version: options.targetVersion,
    createdAt: "2026-06-02T09:00:00.000Z",
    minUpgradeProtocolVersion: 1,
    files: deviceInstallerRuntimeFiles.map((file) => {
      const body = options.packageFiles[file.fileName];
      const pathOverride = options.manifestOverride?.fileName === file.fileName
        ? options.manifestOverride.path
        : file.fileName;
      return {
        bytes: Buffer.byteLength(body),
        fileName: file.fileName,
        mode: file.mode,
        path: pathOverride,
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    }),
  };
}

function waitForProcessExit(child: ReturnType<typeof spawn> | undefined, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("collector process did not exit"));
    }, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startRecordingSnapshotServer(options: { expectedAuthorization?: string } = {}): Promise<{
  baseUrl: string;
  runtimeScheduleProbes: () => Array<Record<string, unknown>>;
  runtimeSkillProbes: () => Array<Record<string, unknown>>;
  server: Server;
  snapshots: () => Array<Record<string, unknown>>;
  taskBatches: () => Array<Record<string, unknown>>;
}> {
  const snapshots: Array<Record<string, unknown>> = [];
  const taskBatches: Array<Record<string, unknown>> = [];
  const runtimeSkillProbes: Array<Record<string, unknown>> = [];
  const runtimeScheduleProbes: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    if (
      request.url !== "/api/device-state-snapshots" &&
      request.url !== "/api/device-task-batches" &&
      request.url !== "/api/runtime-skill-probe-snapshots" &&
      request.url !== "/api/runtime-schedule-probe-snapshots"
    ) {
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
      else if (request.url === "/api/runtime-skill-probe-snapshots") runtimeSkillProbes.push(parsed);
      else if (request.url === "/api/runtime-schedule-probe-snapshots") runtimeScheduleProbes.push(parsed);
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
    runtimeScheduleProbes: () => [...runtimeScheduleProbes],
    runtimeSkillProbes: () => [...runtimeSkillProbes],
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
