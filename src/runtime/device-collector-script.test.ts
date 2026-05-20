import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const collectorScript = path.join(repoRoot, "scripts", "lorume-device-collector.mjs");
const installerScript = path.join(repoRoot, "scripts", "install-device-collector.sh");
const fixturePath = path.join(repoRoot, "fixtures", "runtime", "collector-snapshot.sample.json");

describe("device collector scripts", () => {
  it("prints a normalized snapshot from a fixture in once mode", () => {
    const output = execFileSync(process.execPath, [
      collectorScript,
      "--once",
      "--fixture",
      fixturePath,
      "--print-only",
    ], { encoding: "utf8" });

    const snapshot = JSON.parse(output);

    expect(snapshot.device.id).toBe("fixture-mac");
    expect(snapshot.runtimes.map((runtime: { kind: string }) => runtime.kind)).toContain("openclaw");
    expect(snapshot.agents.map((agent: { name: string }) => agent.name)).toContain("tester");
  });

  it("collects inventory by invoking the Lorume CLI contract", () => {
    const fakeDir = mkdtempSync(path.join(tmpdir(), "lorume-cli-boundary-"));
    const fakeCli = path.join(fakeDir, "lorume.mjs");
    const callsPath = path.join(fakeDir, "calls.jsonl");
    writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({
  command: "collect.inventory",
  observedAt: "2026-05-19T00:00:00.000Z",
  collector: { version: "test", status: "online" },
  device: { id: "cli-device", hostname: "cli.local", os: "darwin", architecture: "arm64", lastSeenAt: "2026-05-19T00:00:00.000Z" },
  runtimes: [],
  agents: [],
  reports: []
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
    expect(calls).toContainEqual(["collect", "inventory", "--json"]);
  });

  it("collects work-state by invoking the Lorume CLI contract", () => {
    const fakeDir = mkdtempSync(path.join(tmpdir(), "lorume-cli-work-state-"));
    const fakeCli = path.join(fakeDir, "lorume.mjs");
    const callsPath = path.join(fakeDir, "calls.jsonl");
    writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({
  command: "collect.work-state",
  observedAt: "2026-05-19T00:00:00.000Z",
  deviceId: "cli-device",
  workItems: [],
  conversations: [],
  executions: [],
  capabilities: []
}));
`);
    chmodSync(fakeCli, 0o755);

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--print-only",
      "--device-id",
      "cli-device",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_CLI_PATH: fakeCli },
    });

    const snapshot = JSON.parse(output);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(snapshot.deviceId).toBe("cli-device");
    expect(calls).toContainEqual(["collect", "work-state", "--json", "--device-id", "cli-device"]);
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
      "--slock-server-url",
      "https://api.slock.ai",
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
      slockServerUrl: "https://api.slock.ai",
    });
    expect(snapshot.device.id).toBe("test-device");
    expect(snapshot.device).not.toHaveProperty("name");
    expect(snapshot.device).not.toHaveProperty("status");
    expect(snapshot.device).not.toHaveProperty("connectionMode");
  });

  it("uninstalls the collector through the installer without manual file removal", () => {
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
      "--uninstall",
    ], { encoding: "utf8", env: { ...process.env, HOME: homeDir } });

    expect(existsSync(installDir)).toBe(false);
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

  it("uses config device identity during live once collection", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-empty-home-"));
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-collector-config-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      deviceId: "config-device",
      intervalMs: 60_000,
    }));

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--once",
      "--config",
      configPath,
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });

    const snapshot = JSON.parse(output);

    expect(snapshot.device.id).toBe("config-device");
    expect(snapshot.device).not.toHaveProperty("name");
    expect(snapshot.device).not.toHaveProperty("status");
    expect(snapshot.device).not.toHaveProperty("connectionMode");
  });

  it("posts a once snapshot to the Lorume backend when server url is configured", async () => {
    const { server, receivedSnapshot, baseUrl } = await startSnapshotServer();

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
      expect((snapshot.device as { id: string }).id).toBe("fixture-mac");
      expect((snapshot.runtimes as Array<{ kind: string }>).map((runtime) => runtime.kind)).toContain("slock");
    } finally {
      server.close();
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
      ], { env: { ...process.env, LORUME_COLLECTOR_LOG_PATH: logPath } })).rejects.toThrow("Snapshot post failed");

      const record = JSON.parse(readFileSync(logPath, "utf8").trim());
      expect(record).toMatchObject({
        errorCode: "collector_post_failed",
        event: "collector_run_failed",
        level: "error",
        service: "lorume-device-collector",
      });
      expect(JSON.stringify(record)).not.toContain("secret-device-token");
    } finally {
      server.close();
    }
  });

  it("posts inventory snapshots with the configured Lorume device token", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-token-config-"));
    const configPath = path.join(configDir, "config.json");
    const { server, receivedSnapshot, baseUrl } = await startSnapshotServer({
      expectedAuthorization: "Bearer device-token-test",
    });
    writeFileSync(configPath, JSON.stringify({
      serverUrl: baseUrl,
      deviceToken: "device-token-test",
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

  it("retries transient backend failures when posting inventory snapshots", async () => {
    const { server, receivedSnapshot, baseUrl, requestCount } = await startFlakySnapshotServer(
      "/api/device-snapshots",
    );

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

  it("does not fabricate runtime work-state when live probes are unavailable", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-work-state-empty-home-"));

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "live-empty-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });

    const snapshot = JSON.parse(output);

    expect(snapshot.deviceId).toBe("live-empty-device");
    expect(snapshot.workItems).toEqual([]);
    expect(snapshot.conversations).toEqual([]);
    expect(snapshot.executions).toEqual([]);
    expect(snapshot.capabilities.map((capability: { source: string }) => capability.source)).toEqual([
      "openclaw",
      "multica",
      "slock",
    ]);
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("OpenClaw work-state probe unavailable"),
      expect.stringContaining("Multica work-state probe unavailable"),
      expect.stringContaining("Slock work-state probe unavailable"),
    ]));
  });

  it("maps live OpenClaw DingTalk message context into work items linked to executions", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-work-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-work-bin-"));
    writeOpenClawDingTalkState(fakeHome, {
      conversationId: "group-live",
      groupTitle: "研发值班群",
      msgId: "msg-live-1",
      senderId: "user-live-1",
      senderName: "张三",
      text: "帮我检查今天的线上异常，给出结论和下一步建议",
      createdAt: "2026-05-09T06:40:30.000Z",
    });
    writeFakeOpenClaw(fakeBin, {
      health: {
        ok: true,
        agents: [{
          id: "main",
          sessions: {
            recent: [{
              sessionKey: "agent:main:dingtalk:group:group-live",
              updatedAt: "2026-05-09T06:41:00.000Z",
              status: "active",
            }],
          },
        }],
      },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: {
        tasks: [
          {
            taskId: "task-live-1",
            runId: "run-live-1",
            status: "running",
            agentId: "main",
            requesterSessionKey: "agent:main:dingtalk:group:group-live",
            requesterOriginJson: JSON.stringify({ messageId: "msg-live-1" }),
            createdAt: 1778308800000,
            startedAt: 1778308860000,
            lastEventAt: 1778308920000,
          },
          {
            taskId: "task-live-2",
            runId: "run-live-2",
            status: "lost",
            agentId: "main",
            createdAt: 1778308980000,
            startedAt: 1778309040000,
            endedAt: 1778309100000,
            lastEventAt: 1778309100000,
          },
        ],
      },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-live-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const openclawWorkItem = snapshot.workItems.find((item: { source: string }) => item.source === "openclaw");
    const runningExecution = snapshot.executions.find((execution: { externalId: string }) => execution.externalId === "run-live-1");
    const failedExecution = snapshot.executions.find((execution: { externalId: string }) => execution.externalId === "run-live-2");

    expect(openclawWorkItem).toMatchObject({
      source: "openclaw",
      title: "帮我检查今天的线上异常",
      description: "帮我检查今天的线上异常，给出结论和下一步建议",
      status: "in_progress",
      creator: { kind: "human", label: "张三", externalId: "user-live-1" },
      channel: { kind: "dingtalk", label: "研发值班群", externalId: "group-live" },
      conversationId: "openclaw-live-device:openclaw:gateway-ws-127.0.0.1-18789:conversation:agent-main-dingtalk-group-group-live",
    });
    expect(runningExecution).toMatchObject({
      source: "openclaw",
      status: "running",
      queuedAt: "2026-05-09T06:40:00.000Z",
      startedAt: "2026-05-09T06:41:00.000Z",
      workItemId: openclawWorkItem.id,
      conversationId: openclawWorkItem.conversationId,
    });
    expect(failedExecution).toMatchObject({ source: "openclaw", status: "failed" });
    expect(snapshot.conversations).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "agent:main:dingtalk:group:group-live",
      status: "active",
      title: "研发值班群",
    }));
  }, 10_000);

  it("uses unlinked OpenClaw DingTalk message context as conversation evidence only", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-map-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-map-bin-"));
    writeOpenClawDingTalkTargetDirectory(fakeHome, {
      conversationId: "group-map",
      groupTitle: "Lorume 研发群",
      lastSeenAt: "2026-05-09T08:10:00.000Z",
    });
    const stateDir = path.join(fakeHome, ".openclaw", "agents", "default", "sessions", "dingtalk-state");
    writeFileSync(path.join(stateDir, "messages.context.default.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-05-09T08:10:30.000Z",
      records: {
        "msg-map-1": {
          msgId: "msg-map-1",
          direction: "inbound",
          conversationId: "group-map",
          createdAt: "2026-05-09T08:10:00.000Z",
          updatedAt: "2026-05-09T08:10:30.000Z",
          messageType: "text",
          text: "张良发起的真实消息应该能展示发起人",
          senderId: "100854680226406967",
          senderName: "张良",
        },
      },
    }));
    writeFakeOpenClaw(fakeBin, {
      health: { ok: true },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: { tasks: [] },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-map-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);

    expect(snapshot.workItems).not.toContainEqual(expect.objectContaining({
      source: "openclaw",
      title: "张良发起的真实消息应该能展示发起人",
    }));
    expect(snapshot.conversations).toContainEqual(expect.objectContaining({
      source: "openclaw",
      title: "Lorume 研发群",
      channel: { kind: "dingtalk", label: "Lorume 研发群", externalId: "group-map" },
      participants: [{ kind: "human", label: "张良", externalId: "100854680226406967" }],
    }));
  });

  it("maps live OpenClaw DingTalk direct session ids to readable channel labels", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-direct-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-direct-bin-"));
    const stateDir = path.join(fakeHome, ".openclaw", "agents", "default", "sessions", "dingtalk-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "targets.directory.account-default.json"), JSON.stringify({
      version: 1,
      groups: {},
      users: {
        "0403085742945013": {
          lastSeenAt: "2026-05-09T08:10:00.000Z",
        },
      },
    }));
    writeOpenClawDingTalkMessages(fakeHome, []);
    writeFakeOpenClaw(fakeBin, {
      health: {
        ok: true,
        agents: [{
          id: "main",
          sessions: {
            recent: [{
              sessionKey: "agent:main:dingtalk:direct:0403085742945013",
              updatedAt: "2026-05-09T08:10:00.000Z",
              status: "idle",
            }],
          },
        }],
      },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: {
        tasks: [
          {
            taskId: "direct-task-live-1",
            runId: "direct-run-live-1",
            task: "帮我检查私聊里的 Agent 回复",
            status: "succeeded",
            agentId: "main",
            requesterSessionKey: "agent:main:dingtalk:direct:0403085742945013",
            createdAt: 1778308800000,
            startedAt: 1778308860000,
            endedAt: 1778309100000,
          },
        ],
      },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-direct-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const workItem = snapshot.workItems.find((item: { externalId: string }) => item.externalId === "direct-task-live-1");

    expect(workItem).toMatchObject({
      source: "openclaw",
      channel: {
        kind: "dingtalk",
        label: "DingTalk 私聊",
        externalId: "0403085742945013",
      },
    });
    expect(snapshot.conversations).toContainEqual(expect.objectContaining({
      externalId: "agent:main:dingtalk:direct:0403085742945013",
      title: "DingTalk 私聊",
      channel: expect.objectContaining({
        kind: "dingtalk",
        label: "DingTalk 私聊",
      }),
    }));
  });

  it("maps live OpenClaw DingTalk task sessions into work items when message context is empty", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-origin-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-origin-bin-"));
    writeOpenClawDingTalkTargetDirectory(fakeHome, {
      conversationId: "Group-Origin",
      groupTitle: "研发值班群",
      lastSeenAt: "2026-05-09T06:40:30.000Z",
    });
    writeOpenClawDingTalkMessages(fakeHome, []);
    writeFakeOpenClaw(fakeBin, {
      health: {
        ok: true,
        agents: [{
          id: "main",
          sessions: {
            recent: [{
              sessionKey: "agent:main:dingtalk:group:group-origin",
              updatedAt: "2026-05-09T06:41:00.000Z",
              status: "active",
            }],
          },
        }],
      },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: {
        tasks: [
          {
            taskId: "task-origin-1",
            runId: "run-origin-1",
            task: "请在当前钉钉群上下文中检查 ai-toolkit 定时放量任务，给出处理结论",
            status: "succeeded",
            agentId: "main",
            requesterSessionKey: "agent:main:dingtalk:group:group-origin",
            sourceId: "source-message-1",
            createdAt: 1778308800000,
            startedAt: 1778308860000,
            endedAt: 1778309100000,
          },
          {
            taskId: "task-origin-followup",
            task: "[Fri May 09 2026] An async command the user already approved has completed.",
            status: "succeeded",
            agentId: "main",
            requesterOriginJson: JSON.stringify({ channel: "dingtalk", to: "group-origin" }),
            sourceId: "exec-approval-followup:task-origin-1",
          },
          {
            taskId: "task-system-recovery",
            task: "[Wed 2026-05-06 17:39 GMT+8] [System] Your previous turn was interrupted by a gateway restart.",
            status: "cancelled",
            agentId: "main",
            requesterSessionKey: "agent:main:dingtalk:group:group-origin",
            sourceId: "system-recovery",
          },
        ],
      },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-origin-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const openclawWorkItems = snapshot.workItems.filter((item: { source: string }) => item.source === "openclaw");
    const workItem = openclawWorkItems.find((item: { externalId: string }) => item.externalId === "task-origin-1");

    expect(openclawWorkItems).toHaveLength(1);
    expect(workItem).toMatchObject({
      source: "openclaw",
      title: "请在当前钉钉群上下文中检查 ai-toolkit 定时放量任务",
      description: "请在当前钉钉群上下文中检查 ai-toolkit 定时放量任务，给出处理结论",
      status: "done",
      creator: { kind: "unknown", label: "不支持采集", externalId: "source-message-1" },
      channel: { kind: "dingtalk", label: "研发值班群", externalId: "group-origin" },
      conversationId: "openclaw-origin-device:openclaw:gateway-ws-127.0.0.1-18789:conversation:agent-main-dingtalk-group-group-origin",
    });
    expect(snapshot.executions).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "run-origin-1",
      workItemId: workItem.id,
      conversationId: workItem.conversationId,
      status: "succeeded",
    }));
    expect(snapshot.workItems.map((item: { externalId: string }) => item.externalId)).not.toContain("task-origin-followup");
    expect(snapshot.workItems.map((item: { externalId: string }) => item.externalId)).not.toContain("task-system-recovery");
  });

  it("maps OpenClaw DingTalk trajectory runs when session JSONL is unavailable", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-bin-"));
    writeOpenClawDingTalkTargetDirectory(fakeHome, {
      conversationId: "group-trajectory",
      groupTitle: "研发值班群",
      lastSeenAt: "2026-05-09T08:00:00.000Z",
    });
    writeOpenClawTrajectory(fakeHome, "main", "trajectory-session", [
      {
        runId: "trajectory-run-1",
        sessionKey: "agent:main:dingtalk:group:group-trajectory",
        prompt: "请总结昨天的告警，并给出后续动作",
        finalStatus: "success",
        endedStatus: "success",
        assistantTexts: ["已完成"],
        startedAt: "2026-05-09T08:01:00.000Z",
        endedAt: "2026-05-09T08:02:00.000Z",
      },
      {
        runId: "trajectory-run-heartbeat",
        sessionKey: "agent:main:dingtalk:group:group-trajectory",
        prompt: "[OpenClaw heartbeat poll]",
        finalStatus: "success",
        endedStatus: "success",
        assistantTexts: ["HEARTBEAT_OK"],
        startedAt: "2026-05-09T08:03:00.000Z",
        endedAt: "2026-05-09T08:03:05.000Z",
      },
    ]);
    writeFakeOpenClaw(fakeBin, {
      health: { ok: true, agents: [{ id: "main" }] },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: { tasks: [] },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-trajectory-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const workItems = snapshot.workItems.filter((item: { source: string }) => item.source === "openclaw");
    const workItem = workItems[0];

    expect(workItems).toHaveLength(1);
    expect(workItem).toMatchObject({
      source: "openclaw",
      externalId: "trajectory-run-1",
      title: "请总结昨天的告警",
      description: "请总结昨天的告警，并给出后续动作",
      status: "done",
      creator: { kind: "unknown", label: "不支持采集" },
      channel: { kind: "dingtalk", label: "研发值班群", externalId: "group-trajectory" },
      conversationId: "openclaw-trajectory-device:openclaw:gateway-ws-127.0.0.1-18789:conversation:agent-main-dingtalk-group-group-trajectory",
    });
    expect(snapshot.executions).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "trajectory-run-1",
      status: "succeeded",
      workItemId: workItem.id,
      conversationId: workItem.conversationId,
    }));
    expect(snapshot.workItems.map((item: { externalId: string }) => item.externalId)).not.toContain("trajectory-run-heartbeat");
  });

  it("links OpenClaw trajectory runs to DingTalk message context from session runtime metadata", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-link-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-link-bin-"));
    const conversationId = "cidOQk/D4niJC8l2j8FlIA5Wg==";
    const sessionKey = `agent:main:dingtalk:group:${conversationId}`;

    writeOpenClawDingTalkState(fakeHome, {
      conversationId,
      groupTitle: "insMind工具数据日报和告警",
      msgId: "msgIv6wEOv4t9ONgYa21mfm1Q==",
      senderId: "023160384927511676",
      senderName: "tiger",
      text: "你个败家娘们，浪费token啊，退下吧",
      createdAt: "2026-05-09T09:10:00.000Z",
    });
    writeOpenClawTrajectoryWithSessionMetadata(fakeHome, {
      agentId: "main",
      sessionId: "trajectory-linked-session",
      runId: "trajectory-linked-run",
      sessionKey,
      prompt: "你个败家娘们，浪费token啊，退下吧",
      runtimeContext: {
        message_id: "msgIv6wEOv4t9ONgYa21mfm1Q==",
        sender_id: "023160384927511676",
        sender: "tiger",
        chat_id: conversationId,
        group_subject: "insMind工具数据日报和告警",
        group_channel: sessionKey,
      },
      startedAt: "2026-05-09T09:10:02.000Z",
      endedAt: "2026-05-09T09:11:00.000Z",
    });
    writeFakeOpenClaw(fakeBin, {
      health: { ok: true, agents: [{ id: "main" }] },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: { tasks: [] },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-trajectory-link-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const workItems = snapshot.workItems.filter((item: { title: string }) => item.title === "你个败家娘们");

    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toMatchObject({
      source: "openclaw",
      externalId: "msgIv6wEOv4t9ONgYa21mfm1Q==",
      status: "done",
      creator: { kind: "human", label: "tiger", externalId: "023160384927511676" },
      channel: {
        kind: "dingtalk",
        label: "insMind工具数据日报和告警",
        externalId: conversationId,
      },
    });
    expect(snapshot.executions).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "trajectory-linked-run",
      status: "succeeded",
      workItemId: workItems[0].id,
      conversationId: workItems[0].conversationId,
    }));
  });

  it("upgrades linked OpenClaw DingTalk messages to direct chat when trajectory session metadata proves DM", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-direct-link-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-direct-link-bin-"));
    const messageConversationId = "cidrYPQCCFAqjoPOplBhOADv8iE20fEdIk0LAOIWK8thfg=";
    const directConversationId = "0403085742945013";
    const sessionKey = `agent:main:dingtalk:direct:${directConversationId}`;

    writeOpenClawDingTalkMessages(fakeHome, [{
      msgId: "msgTcetRGuqtUW2ISdkEux5zg==",
      direction: "inbound",
      accountId: "default",
      conversationId: messageConversationId,
      createdAt: "2026-05-09T11:20:00.000Z",
      updatedAt: "2026-05-09T11:20:01.000Z",
      messageType: "text",
      text: "怎么解决",
      senderId: directConversationId,
      senderName: "林奈",
    }]);
    writeOpenClawTrajectoryWithSessionMetadata(fakeHome, {
      agentId: "main",
      sessionId: "trajectory-direct-linked-session",
      runId: "trajectory-direct-linked-run",
      sessionKey,
      prompt: "怎么解决",
      runtimeContext: {
        message_id: "msgTcetRGuqtUW2ISdkEux5zg==",
        sender_id: directConversationId,
        sender: "林奈",
        chat_id: directConversationId,
      },
      startedAt: "2026-05-09T11:20:02.000Z",
      endedAt: "2026-05-09T11:21:00.000Z",
    });
    writeFakeOpenClaw(fakeBin, {
      health: { ok: true, agents: [{ id: "main" }] },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: { tasks: [] },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-trajectory-direct-link-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const workItem = snapshot.workItems.find((item: { externalId: string }) => item.externalId === "msgTcetRGuqtUW2ISdkEux5zg==");

    expect(workItem).toMatchObject({
      source: "openclaw",
      title: "怎么解决",
      status: "done",
      creator: { kind: "human", label: "林奈", externalId: directConversationId },
      channel: {
        kind: "dingtalk",
        label: "DingTalk 私聊",
        externalId: directConversationId,
      },
      conversationId: "openclaw-trajectory-direct-link-device:openclaw:gateway-ws-127.0.0.1-18789:conversation:agent-main-dingtalk-direct-0403085742945013",
    });
    expect(snapshot.executions).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "trajectory-direct-linked-run",
      status: "succeeded",
      workItemId: workItem.id,
      conversationId: workItem.conversationId,
    }));
  });

  it("links direct OpenClaw trajectory runs to DingTalk message context by sender when message id is missing", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-direct-sender-link-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-direct-sender-link-bin-"));
    const directConversationId = "0403085742945013";
    const sessionKey = `agent:main:dingtalk:direct:${directConversationId}`;

    writeOpenClawDingTalkMessages(fakeHome, [{
      msgId: "msgDirectFallback",
      direction: "inbound",
      accountId: "default",
      conversationId: "cidDirectFallback",
      createdAt: "2026-05-09T05:58:00.000Z",
      updatedAt: "2026-05-09T05:58:01.000Z",
      messageType: "text",
      text: "为什么工具层没接住调用，怎么解决",
      senderId: directConversationId,
      senderName: "林奈",
    }]);
    writeOpenClawTrajectoryWithSessionMetadata(fakeHome, {
      agentId: "main",
      sessionId: "trajectory-direct-sender-linked-session",
      runId: "trajectory-direct-sender-linked-run",
      sessionKey,
      prompt: "为什么工具层没接住调用，怎么解决",
      runtimeContext: {
        sender_id: directConversationId,
        sender: "林奈",
        chat_id: directConversationId,
      },
      startedAt: "2026-05-09T05:58:10.000Z",
      endedAt: "2026-05-09T05:59:00.000Z",
    });
    writeFakeOpenClaw(fakeBin, {
      health: { ok: true, agents: [{ id: "main" }] },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: { tasks: [] },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-trajectory-direct-sender-link-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);

    expect(snapshot.workItems).toHaveLength(1);
    expect(snapshot.workItems[0]).toMatchObject({
      source: "openclaw",
      externalId: "msgDirectFallback",
      status: "done",
      creator: { kind: "human", label: "林奈", externalId: directConversationId },
      channel: {
        kind: "dingtalk",
        label: "DingTalk 私聊",
        externalId: directConversationId,
      },
      conversationId: "openclaw-trajectory-direct-sender-link-device:openclaw:gateway-ws-127.0.0.1-18789:conversation:agent-main-dingtalk-direct-0403085742945013",
    });
    expect(snapshot.executions).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "trajectory-direct-sender-linked-run",
      status: "succeeded",
      workItemId: snapshot.workItems[0].id,
      conversationId: snapshot.workItems[0].conversationId,
    }));
  });

  it("links OpenClaw trajectory runs to DingTalk message context by prompt and session when runtime metadata is missing", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-fallback-link-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-trajectory-fallback-link-bin-"));
    const conversationId = "cidOQk/D4niJC8l2j8FlIA5Wg==";
    const sessionKey = `agent:main:dingtalk:group:${conversationId}`;

    writeOpenClawDingTalkState(fakeHome, {
      conversationId,
      groupTitle: "insMind工具数据日报和告警",
      msgId: "msgIv6wEOv4t9ONgYa21mfm1Q==",
      senderId: "023160384927511676",
      senderName: "tiger",
      text: "你个败家娘们，浪费token啊，退下吧",
      createdAt: "2026-05-09T09:10:00.000Z",
    });
    writeOpenClawTrajectory(fakeHome, "main", "trajectory-fallback-linked-session", [{
      runId: "trajectory-fallback-linked-run",
      sessionKey,
      prompt: "你个败家娘们，浪费token啊，退下吧",
      finalStatus: "success",
      endedStatus: "success",
      assistantTexts: ["已回复"],
      startedAt: "2026-05-09T09:10:02.000Z",
      endedAt: "2026-05-09T09:11:00.000Z",
    }]);
    writeFakeOpenClaw(fakeBin, {
      health: { ok: true, agents: [{ id: "main" }] },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: { tasks: [] },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-trajectory-fallback-link-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const workItems = snapshot.workItems.filter((item: { title: string }) => item.title === "你个败家娘们");

    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toMatchObject({
      source: "openclaw",
      externalId: "msgIv6wEOv4t9ONgYa21mfm1Q==",
      status: "done",
      creator: { kind: "human", label: "tiger", externalId: "023160384927511676" },
    });
    expect(snapshot.executions).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "trajectory-fallback-linked-run",
      status: "succeeded",
      workItemId: workItems[0].id,
      conversationId: workItems[0].conversationId,
    }));
  });

  it("keeps OpenClaw execution ids unique when the platform repeats run ids", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-duplicate-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-duplicate-bin-"));
    writeFakeOpenClaw(fakeBin, {
      health: { ok: true, agents: [{ id: "main" }] },
      status: { gateway: { url: "ws://127.0.0.1:18789", reachable: true } },
      tasks: {
        tasks: [
          { taskId: "task-duplicate-1", runId: "reused-run", status: "succeeded", agentId: "main" },
          { taskId: "task-duplicate-2", runId: "reused-run", status: "failed", agentId: "main" },
        ],
      },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-duplicate-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const executionIds = snapshot.executions.map((execution: { id: string }) => execution.id);

    expect(snapshot.executions.map((execution: { externalId: string }) => execution.externalId)).toEqual([
      "reused-run",
      "reused-run",
    ]);
    expect(new Set(executionIds).size).toBe(executionIds.length);
    expect(executionIds.every((id: string) => id.includes("task-duplicate"))).toBe(true);
  });

  it("parses large OpenClaw JSON probe output without treating it as unavailable", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-large-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-large-bin-"));
    writeLargeOutputOpenClaw(fakeBin);

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-large-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);

    expect(snapshot.executions).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "large-run-1",
      status: "succeeded",
    }));
    expect(snapshot.warnings || []).not.toContainEqual(expect.stringContaining("openclaw tasks list --json failed"));
  });

  it("runs OpenClaw shims with an augmented probe PATH", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-shim-home-"));
    const fakeBin = path.join(fakeHome, ".local", "share", "fnm", "node-versions", "v-test", "installation", "bin");
    mkdirSync(fakeBin, { recursive: true });
    writeShimmedOpenClaw(fakeBin);

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "openclaw-shim-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });

    const snapshot = JSON.parse(output);

    expect(snapshot.executions).toContainEqual(expect.objectContaining({
      source: "openclaw",
      externalId: "shim-run-1",
      status: "succeeded",
    }));
    expect(snapshot.warnings || []).not.toContainEqual(expect.stringContaining("OpenClaw"));
  });

  it("maps live Multica issue and agent task probes into work items and executions", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-multica-work-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-multica-work-bin-"));
    writeFakeMultica(fakeBin, {
      runtimes: [{ id: "runtime-openclaw", provider: "openclaw", name: "Openclaw runtime", status: "online" }],
      agents: [{ id: "agent-1", name: "CMO", runtime_id: "runtime-openclaw", status: "idle" }],
      issues: {
        issues: [
          {
            id: "issue-1",
            identifier: "GDA-31",
            title: "Live Multica issue",
            status: "todo",
            assignee_id: "agent-1",
            assignee_type: "agent",
            creator_id: "member-1",
            creator_type: "member",
            created_at: "2026-05-09T06:30:00.000Z",
            updated_at: "2026-05-09T06:45:00.000Z",
          },
        ],
      },
      tasksByAgentId: {
        "agent-1": {
          tasks: [
            {
              id: "task-1",
              issue_id: "issue-1",
              agent_id: "agent-1",
              runtime_id: "runtime-openclaw",
              chat_session_id: "chat-1",
              status: "running",
              created_at: "2026-05-09T06:40:00.000Z",
              started_at: "2026-05-09T06:41:00.000Z",
            },
          ],
        },
      },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "multica-live-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const workItem = snapshot.workItems.find((item: { externalId: string }) => item.externalId === "issue-1");
    const execution = snapshot.executions.find((item: { externalId: string }) => item.externalId === "task-1");

    expect(workItem).toMatchObject({
      source: "multica",
      title: "Live Multica issue",
      status: "todo",
      agentId: "multica-live-device:multica:runtime-openclaw:agent:agent-1",
      runtimeId: "multica-live-device:multica:runtime-openclaw",
    });
    expect(execution).toMatchObject({
      source: "multica",
      status: "running",
      workItemId: workItem.id,
      conversationId: "multica-live-device:multica:runtime-openclaw:conversation:chat-1",
    });
    expect(snapshot.conversations).toContainEqual(expect.objectContaining({
      source: "multica",
      externalId: "chat-1",
      status: "active",
    }));
  });

  it("does not invent Slock board state when only workspace agent files are present", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-slock-work-home-"));
    const agentDir = path.join(fakeHome, ".slock", "agents", "tester");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "MEMORY.md"), "# tester\n");

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--device-id",
      "slock-work-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });

    const snapshot = JSON.parse(output);
    const slockCapability = snapshot.capabilities.find((capability: { source: string }) => capability.source === "slock");

    expect(snapshot.workItems.filter((item: { source: string }) => item.source === "slock")).toEqual([]);
    expect(snapshot.executions.filter((item: { source: string }) => item.source === "slock")).toEqual([]);
    expect(slockCapability).toMatchObject({
      source: "slock",
      workItems: { support: "unknown" },
      executions: { support: "unknown" },
    });
  });

  it("reports Slock CLI fallback capability for empty task channels without referencing undefined state", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-slock-cli-empty-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-slock-cli-empty-bin-"));
    const fakeSlock = path.join(fakeBin, "slock");
    writeFileSync(fakeSlock, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "task" && args[1] === "list") {
  console.log(JSON.stringify({ tasks: [] }));
  process.exit(0);
}
process.exit(1);
`);
    chmodSync(fakeSlock, 0o755);
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-slock-cli-empty-config-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      deviceId: "slock-cli-empty-device",
      slockTaskChannels: [{ label: "Team General", externalId: "team-general" }],
    }));

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--work-state-once",
      "--config",
      configPath,
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const slockCapability = snapshot.capabilities.find((capability: { source: string }) => capability.source === "slock");

    expect(snapshot.workItems.filter((item: { source: string }) => item.source === "slock")).toEqual([]);
    expect(slockCapability).toMatchObject({
      source: "slock",
      workItems: { support: "supported" },
    });
  });

  it("maps Slock internal agent API task board into work items without requiring a local CLI", async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-slock-api-home-"));
    const agentDir = path.join(fakeHome, ".slock", "agents", "tester", ".slock");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "agent-token"), "test-agent-token");
    const { server, baseUrl } = await startSlockInternalApiServer();
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-slock-api-config-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      deviceId: "slock-api-device",
      slockServerUrl: baseUrl,
    }));

    try {
      const output = await runNodeScript([
        collectorScript,
        "--work-state-once",
        "--config",
        configPath,
        "--print-only",
      ], {
        env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
      });

      const snapshot = JSON.parse(output);
      const workItem = snapshot.workItems.find((item: { source: string }) => item.source === "slock");
      const slockCapability = snapshot.capabilities.find((capability: { source: string }) => capability.source === "slock");

      expect(workItem).toMatchObject({
        source: "slock",
        title: "修复登录回调异常",
        status: "in_progress",
        creator: { kind: "human", label: "@zhangsan" },
        assignee: { kind: "agent", label: "@tester" },
        channel: { kind: "slock", label: "#研发项目群", externalId: "#研发项目群" },
        conversationId: "slock-api-device:slock:slock-daemon:conversation:thread-1",
      });
      expect(snapshot.conversations).toContainEqual(expect.objectContaining({
        source: "slock",
        externalId: "thread-1",
        title: "修复登录回调异常",
      }));
      expect(slockCapability).toMatchObject({
        source: "slock",
        workItems: { support: "supported" },
        conversations: { support: "partial" },
      });
    } finally {
      server.close();
    }
  });

  it("uses the default Slock server URL when local agent tokens exist and config omits it", async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-slock-default-api-home-"));
    const agentDir = path.join(fakeHome, ".slock", "agents", "tester", ".slock");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "agent-token"), "test-agent-token");
    const { server, baseUrl } = await startSlockInternalApiServer();
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-slock-default-api-config-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ deviceId: "slock-default-api-device" }));

    try {
      const output = await runNodeScript([
        collectorScript,
        "--work-state-once",
        "--config",
        configPath,
        "--print-only",
      ], {
        env: {
          ...process.env,
          LORUME_COLLECTOR_HOME: fakeHome,
          SLOCK_DEFAULT_SERVER_URL: baseUrl,
          PATH: "/usr/bin:/bin",
        },
      });

      const snapshot = JSON.parse(output);
      expect(snapshot.workItems).toContainEqual(expect.objectContaining({
        source: "slock",
        title: "修复登录回调异常",
        status: "in_progress",
      }));
    } finally {
      server.close();
    }
  });

  it("retries transient Slock task-board API failures before recording warnings", async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-slock-retry-home-"));
    const agentDir = path.join(fakeHome, ".slock", "agents", "tester", ".slock");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "agent-token"), "test-agent-token");
    let taskAttempts = 0;
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer test-agent-token");
      expect(request.headers["x-agent-id"]).toBe("tester");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/internal/agent/tester/server") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          channels: [{ id: "channel-retry", name: "重试群", type: "channel", joined: true }],
        }));
        return;
      }
      if (url.pathname === "/internal/agent/tester/tasks" && url.searchParams.get("channel") === "#重试群") {
        taskAttempts += 1;
        if (taskAttempts === 1) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "temporary unavailable" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          tasks: [{
            id: "retry-task-1",
            title: "Slock transient failure recovered",
            status: "IN PROGRESS",
            creator: { name: "@zhangsan" },
            assignee: { name: "@tester" },
            threadId: "retry-thread-1",
          }],
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-slock-retry-config-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      deviceId: "slock-retry-device",
      slockServerUrl: `http://127.0.0.1:${address.port}`,
    }));

    try {
      const output = await runNodeScript([
        collectorScript,
        "--work-state-once",
        "--config",
        configPath,
        "--print-only",
      ], {
        env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
      });

      const snapshot = JSON.parse(output);

      expect(taskAttempts).toBe(2);
      expect(snapshot.workItems).toContainEqual(expect.objectContaining({
        source: "slock",
        title: "Slock transient failure recovered",
        status: "in_progress",
      }));
      expect(snapshot.warnings || []).not.toContainEqual(expect.stringContaining("Slock task-board API probe failed"));
    } finally {
      server.close();
    }
  });

  it("does not warn when another Slock agent context collects the same channel", async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-slock-cross-context-home-"));
    for (const agentName of ["agent-fails", "agent-succeeds"]) {
      const agentDir = path.join(fakeHome, ".slock", "agents", agentName, ".slock");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "agent-token"), `${agentName}-token`);
    }
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.endsWith("/server")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          channels: [{ id: "channel-shared", name: "共享群", type: "channel", joined: true }],
        }));
        return;
      }
      if (url.pathname === "/internal/agent/agent-fails/tasks") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "temporary unavailable" }));
        return;
      }
      if (url.pathname === "/internal/agent/agent-succeeds/tasks" && url.searchParams.get("channel") === "#共享群") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          tasks: [{
            id: "shared-task-1",
            title: "Shared channel was collected by another context",
            status: "TODO",
            creator: { name: "@lisi" },
            assignee: { name: "@agent-succeeds" },
            threadId: "shared-thread-1",
          }],
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-slock-cross-context-config-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      deviceId: "slock-cross-context-device",
      slockServerUrl: `http://127.0.0.1:${address.port}`,
    }));

    try {
      const output = await runNodeScript([
        collectorScript,
        "--work-state-once",
        "--config",
        configPath,
        "--print-only",
      ], {
        env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
      });

      const snapshot = JSON.parse(output);

      expect(snapshot.workItems).toContainEqual(expect.objectContaining({
        source: "slock",
        title: "Shared channel was collected by another context",
      }));
      expect(snapshot.warnings || []).not.toContainEqual(expect.stringContaining("Slock task-board API probe failed"));
    } finally {
      server.close();
    }
  });

  it("posts a runtime work-state once snapshot to the Lorume backend when server url is configured", async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-work-state-post-home-"));
    const { server, receivedSnapshot, baseUrl } = await startWorkStateServer();

    try {
      const output = await runNodeScript([
        collectorScript,
        "--work-state-once",
        "--device-id",
        "fixture-device",
        "--server-url",
        baseUrl,
      ], { env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" } });
      const snapshot = await receivedSnapshot;

      expect(output).toBe("");
      expect(snapshot.deviceId).toBe("fixture-device");
      expect(Array.isArray(snapshot.workItems)).toBe(true);
      expect(Array.isArray(snapshot.executions)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("posts runtime work-state snapshots with the configured Lorume device token", async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-work-state-token-home-"));
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-work-state-token-config-"));
    const configPath = path.join(configDir, "config.json");
    const { server, receivedSnapshot, baseUrl } = await startWorkStateServer({
      expectedAuthorization: "Bearer device-token-test",
    });
    writeFileSync(configPath, JSON.stringify({
      serverUrl: baseUrl,
      deviceToken: "device-token-test",
    }));

    try {
      const output = await runNodeScript([
        collectorScript,
        "--work-state-once",
        "--device-id",
        "fixture-device",
        "--config",
        configPath,
      ], { env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" } });
      const snapshot = await receivedSnapshot;

      expect(output).toBe("");
      expect(snapshot.deviceId).toBe("fixture-device");
    } finally {
      server.close();
    }
  });

  it("uploads inventory and work-state on daemon startup while the control channel stays heartbeat-only", async () => {
    const controlServer = await startControlServer();
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-control-home-"));
    const child = spawn(process.execPath, [
      collectorScript,
      "--fixture",
      fixturePath,
      "--server-url",
      controlServer.baseUrl,
      "--interval-ms",
      "100000",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });

    try {
      const result = await controlServer.startupResult;

      expect(result.hello).toMatchObject({
        type: "hello",
        deviceId: "fixture-mac",
        collectorVersion: "0.1.0",
      });
      expect(result.heartbeat).toMatchObject({
        type: "heartbeat",
        deviceId: "fixture-mac",
        collectorVersion: "0.1.0",
      });
      expect(result.snapshots.map((snapshot) => (snapshot.device as { id: string }).id)).toEqual(["fixture-mac"]);
      expect(result.workStateSnapshots.map((snapshot) => snapshot.deviceId)).toEqual(["fixture-mac"]);
    } finally {
      child.kill();
      controlServer.close();
    }
  });

  it("uses the configured Lorume device token for heartbeat-only control connections", async () => {
    const controlServer = await startControlServer({
      expectedHelloDeviceToken: "device-token-test",
    });
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-control-token-home-"));
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-control-token-config-"));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      serverUrl: controlServer.baseUrl,
      deviceToken: "device-token-test",
      intervalMs: 100000,
    }));
    const child = spawn(process.execPath, [
      collectorScript,
      "--fixture",
      fixturePath,
      "--config",
      configPath,
      "--interval-ms",
      "100000",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });

    try {
      const result = await controlServer.startupResult;

      expect(result.hello.deviceId).toBe("fixture-mac");
      expect(result.heartbeat.deviceId).toBe("fixture-mac");
      expect(result.snapshots.map((snapshot) => (snapshot.device as { id: string }).id)).toEqual(["fixture-mac"]);
      expect(result.workStateSnapshots.map((snapshot) => snapshot.deviceId)).toEqual(["fixture-mac"]);
    } finally {
      child.kill();
      controlServer.close();
    }
  });

  it("discovers OpenClaw channel bindings from local config without requiring gateway health", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-home-"));
    const configDir = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-config-"));
    const openclawDir = path.join(fakeHome, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({
      agents: { list: [{ id: "main", default: true }] },
      bindings: [{ agentId: "main", match: { channel: "dingtalk", accountId: "default" } }],
      channels: { dingtalk: { enabled: true } },
    }));
    const configPath = path.join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ deviceId: "openclaw-config-device" }));

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--once",
      "--config",
      configPath,
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });

    const snapshot = JSON.parse(output);
    const openclawAgent = snapshot.agents.find((agent: { origin: string }) => agent.origin === "openclaw");

    expect(openclawAgent?.channelBindings).toContainEqual({
      kind: "dingtalk",
      label: "DingTalk default",
      externalId: "default",
      status: "enabled",
    });
  });

  it("maps OpenClaw historical sessions without treating them as active sessions", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-home-"));
    const fakeBin = mkdtempSync(path.join(tmpdir(), "lorume-openclaw-bin-"));
    writeFakeOpenClaw(fakeBin, {
      health: { ok: true, channels: { dingtalk: { enabled: true } } },
      status: {
        gateway: {
          url: "ws://127.0.0.1:18789",
          reachable: true,
          self: { version: "2026.4.27" },
        },
        agents: {
          agents: [{ id: "main", sessions: { count: 12 } }],
          totalSessions: 12,
        },
      },
    });

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--once",
      "--device-id",
      "openclaw-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    const snapshot = JSON.parse(output);
    const runtime = snapshot.runtimes.find((candidate: { kind: string }) => candidate.kind === "openclaw");
    const agent = snapshot.agents.find((candidate: { origin: string }) => candidate.origin === "openclaw");

    expect(runtime.health).toMatchObject({ historicalSessions: 12 });
    expect(runtime.health).not.toHaveProperty("activeSessions");
    expect(agent.status).toBe("idle");
    expect(agent.load).toMatchObject({ historicalSessions: 12 });
    expect(agent.load).not.toHaveProperty("activeSessions");
    expect(agent.lastSeenAt).toBe(snapshot.observedAt);
  });

  it("maps Slock workspace-only agents as unknown instead of active", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "lorume-slock-home-"));
    const agentDir = path.join(fakeHome, ".slock", "agents", "tester");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "MEMORY.md"), "# tester\n");

    const output = execFileSync(process.execPath, [
      collectorScript,
      "--once",
      "--device-id",
      "slock-device",
      "--print-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, LORUME_COLLECTOR_HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });

    const snapshot = JSON.parse(output);
    const agent = snapshot.agents.find((candidate: { origin: string }) => candidate.origin === "slock");

    expect(agent.status).toBe("unknown");
    expect(agent.lastSeenAt).toBe(snapshot.observedAt);
  });
});

function writeFakeOpenClaw(fakeBin: string, payload: { health: unknown; status: unknown; tasks?: unknown }): void {
  const executable = path.join(fakeBin, "openclaw");
  const script = path.join(fakeBin, "openclaw.js");
  writeFileSync(script, `
const payload = ${JSON.stringify(payload)};
const command = process.argv[2];
if (command === "health") {
  console.log(JSON.stringify(payload.health));
  process.exit(0);
}
if (command === "status") {
  console.log(JSON.stringify(payload.status));
  process.exit(0);
}
if (command === "tasks" && process.argv[3] === "list") {
  console.log(JSON.stringify(payload.tasks ?? { tasks: [] }));
  process.exit(0);
}
process.exit(1);
`);
  writeFileSync(executable, `#!/bin/sh
exec "${process.execPath}" "${script}" "$@"
`);
  chmodSync(executable, 0o755);
}

function writeLargeOutputOpenClaw(fakeBin: string): void {
  const executable = path.join(fakeBin, "openclaw");
  const script = path.join(fakeBin, "openclaw.js");
  writeFileSync(script, `
const command = process.argv[2];
if (command === "health") {
  console.log(JSON.stringify({ ok: true, agents: [{ id: "main" }] }));
  process.exit(0);
}
if (command === "status") {
  console.log(JSON.stringify({ gateway: { url: "ws://127.0.0.1:18789", reachable: true } }));
  process.exit(0);
}
if (command === "tasks" && process.argv[3] === "list") {
  process.stdout.write(JSON.stringify({
    padding: "x".repeat(1_200_000),
    tasks: [{
      taskId: "large-task-1",
      runId: "large-run-1",
      status: "succeeded",
      agentId: "main",
      requesterSessionKey: "agent:main:dingtalk:group:group-large",
      task: "大输出也应该保留 OpenClaw execution",
      createdAt: 1778308800000,
      startedAt: 1778308860000,
      endedAt: 1778309100000,
    }],
  }) + "\\n", () => process.exit(0));
  return;
}
process.exit(1);
`);
  writeFileSync(executable, `#!/bin/sh
exec "${process.execPath}" "${script}" "$@"
`);
  chmodSync(executable, 0o755);
}

function writeShimmedOpenClaw(fakeBin: string): void {
  const interpreter = path.join(fakeBin, "lorume-node-shim");
  const executable = path.join(fakeBin, "openclaw");
  writeFileSync(interpreter, `#!/bin/sh
exec "${process.execPath}" "$@"
`);
  chmodSync(interpreter, 0o755);
  writeFileSync(executable, `#!/usr/bin/env lorume-node-shim
const command = process.argv[2];
if (command === "health") {
  console.log(JSON.stringify({ ok: true, agents: [{ id: "main" }] }));
  process.exit(0);
}
if (command === "status") {
  console.log(JSON.stringify({ gateway: { url: "ws://127.0.0.1:18789", reachable: true } }));
  process.exit(0);
}
if (command === "tasks" && process.argv[3] === "list") {
  console.log(JSON.stringify({
    tasks: [{
      taskId: "shim-task-1",
      runId: "shim-run-1",
      status: "succeeded",
      agentId: "main",
      requesterSessionKey: "agent:main:dingtalk:group:group-shim",
      task: "OpenClaw shim should inherit a usable PATH",
      createdAt: 1778308800000,
      startedAt: 1778308860000,
      endedAt: 1778309100000,
    }],
  }));
  process.exit(0);
}
process.exit(1);
`);
  chmodSync(executable, 0o755);
}

function writeOpenClawDingTalkState(fakeHome: string, input: {
  conversationId: string;
  groupTitle: string;
  msgId: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}): void {
  writeOpenClawDingTalkTargetDirectory(fakeHome, {
    conversationId: input.conversationId,
    groupTitle: input.groupTitle,
    lastSeenAt: input.createdAt,
  });
  writeOpenClawDingTalkMessages(fakeHome, [{
    msgId: input.msgId,
    direction: "inbound",
    accountId: "default",
    conversationId: input.conversationId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    messageType: "text",
    text: input.text,
    senderId: input.senderId,
    senderName: input.senderName,
  }]);
}

function writeOpenClawDingTalkTargetDirectory(fakeHome: string, input: {
  conversationId: string;
  groupTitle: string;
  lastSeenAt: string;
}): void {
  const stateDir = path.join(fakeHome, ".openclaw", "agents", "default", "sessions", "dingtalk-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "targets.directory.account-default.json"), JSON.stringify({
    version: 1,
    groups: {
      [input.conversationId]: {
        currentTitle: input.groupTitle,
        lastSeenAt: input.lastSeenAt,
      },
    },
    users: {},
  }));
}

function writeOpenClawDingTalkMessages(fakeHome: string, records: Array<Record<string, unknown>>): void {
  const stateDir = path.join(fakeHome, ".openclaw", "agents", "default", "sessions", "dingtalk-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "messages.context.default.json"), JSON.stringify({
    version: 1,
    updatedAt: "2026-05-09T06:40:30.000Z",
    records,
  }));
}

function writeOpenClawTrajectory(fakeHome: string, agentId: string, sessionId: string, runs: Array<{
  runId: string;
  sessionKey: string;
  prompt: string;
  finalStatus: string;
  endedStatus: string;
  assistantTexts: string[];
  startedAt: string;
  endedAt: string;
}>): void {
  const sessionsDir = path.join(fakeHome, ".openclaw", "agents", agentId, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const lines = runs.flatMap((run) => [
    {
      type: "session.started",
      ts: run.startedAt,
      sessionId,
      sessionKey: run.sessionKey,
      runId: run.runId,
      data: {
        sessionFile: path.join(sessionsDir, `${sessionId}.missing.jsonl`),
        agentId,
        messageProvider: "dingtalk",
      },
    },
    {
      type: "prompt.submitted",
      ts: run.startedAt,
      sessionId,
      sessionKey: run.sessionKey,
      runId: run.runId,
      data: { prompt: run.prompt },
    },
    {
      type: "trace.artifacts",
      ts: run.endedAt,
      sessionId,
      sessionKey: run.sessionKey,
      runId: run.runId,
      data: {
        finalStatus: run.finalStatus,
        assistantTexts: run.assistantTexts,
        didSendViaMessagingTool: false,
      },
    },
    {
      type: "session.ended",
      ts: run.endedAt,
      sessionId,
      sessionKey: run.sessionKey,
      runId: run.runId,
      data: { status: run.endedStatus },
    },
  ]);
  writeFileSync(
    path.join(sessionsDir, `${sessionId}.trajectory.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

function writeOpenClawTrajectoryWithSessionMetadata(fakeHome: string, input: {
  agentId: string;
  sessionId: string;
  runId: string;
  sessionKey: string;
  prompt: string;
  runtimeContext: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
}): void {
  const sessionsDir = path.join(fakeHome, ".openclaw", "agents", input.agentId, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `${input.sessionId}.jsonl`);
  writeFileSync(sessionFile, `${[
    {
      role: "user",
      ts: input.startedAt,
      content: input.prompt,
    },
    {
      type: "custom_message",
      ts: input.startedAt,
      customType: "openclaw.runtime-context",
      content: `Conversation info (untrusted metadata):\n\`\`\`json\n${JSON.stringify(input.runtimeContext, null, 2)}\n\`\`\``,
    },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
  writeFileSync(path.join(sessionsDir, `${input.sessionId}.trajectory.jsonl`), `${[
    {
      type: "session.started",
      ts: input.startedAt,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      data: {
        sessionFile,
        agentId: input.agentId,
        messageProvider: "dingtalk",
      },
    },
    {
      type: "trace.artifacts",
      ts: input.endedAt,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      data: {
        finalStatus: "success",
        assistantTexts: ["已回复"],
        didSendViaMessagingTool: true,
      },
    },
    {
      type: "session.ended",
      ts: input.endedAt,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      data: { status: "success" },
    },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function writeFakeMultica(fakeBin: string, payload: {
  runtimes: unknown;
  agents: unknown;
  issues: unknown;
  tasksByAgentId: Record<string, unknown>;
}): void {
  const executable = path.join(fakeBin, "multica");
  const script = path.join(fakeBin, "multica.js");
  writeFileSync(script, `
const payload = ${JSON.stringify(payload)};
const [resource, action, id] = process.argv.slice(2);
if (resource === "runtime" && action === "list") {
  console.log(JSON.stringify(payload.runtimes));
  process.exit(0);
}
if (resource === "agent" && action === "list") {
  console.log(JSON.stringify(payload.agents));
  process.exit(0);
}
if (resource === "agent" && action === "tasks") {
  console.log(JSON.stringify(payload.tasksByAgentId[id] ?? { tasks: [] }));
  process.exit(0);
}
if (resource === "issue" && action === "list") {
  console.log(JSON.stringify(payload.issues));
  process.exit(0);
}
if (resource === "daemon" && action === "status") {
  console.log(JSON.stringify({ status: "running", active_task_count: 1 }));
  process.exit(0);
}
process.exit(1);
`);
  writeFileSync(executable, `#!/bin/sh
exec "${process.execPath}" "${script}" "$@"
`);
  chmodSync(executable, 0o755);
}

function runNodeScript(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return runCommand(process.execPath, args, options);
}

function runCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `node script exited with ${code ?? "unknown status"}`));
    });
  });
}

async function startSnapshotServer(options: {
  expectedAuthorization?: string;
} = {}): Promise<{
  server: Server;
  receivedSnapshot: Promise<Record<string, unknown>>;
  baseUrl: string;
}> {
  let server: Server | undefined;
  const receivedSnapshot = new Promise<Record<string, unknown>>((resolve) => {
    server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/device-snapshots");
      if (options.expectedAuthorization) {
        expect(request.headers.authorization).toBe(options.expectedAuthorization);
      }

      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        resolve(JSON.parse(body));
      });
    });
  });

  if (!server) throw new Error("failed to create snapshot server");
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  return {
    server,
    receivedSnapshot,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function startWorkStateServer(options: {
  expectedAuthorization?: string;
} = {}): Promise<{
  server: Server;
  receivedSnapshot: Promise<Record<string, unknown>>;
  baseUrl: string;
}> {
  let server: Server | undefined;
  const receivedSnapshot = new Promise<Record<string, unknown>>((resolve) => {
    server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/runtime-work-state-snapshots");
      if (options.expectedAuthorization) {
        expect(request.headers.authorization).toBe(options.expectedAuthorization);
      }

      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        resolve(JSON.parse(body));
      });
    });
  });

  if (!server) throw new Error("failed to create work state server");
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  return {
    server,
    receivedSnapshot,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function startFlakySnapshotServer(expectedPath: string): Promise<{
  server: Server;
  receivedSnapshot: Promise<Record<string, unknown>>;
  baseUrl: string;
  requestCount: () => number;
}> {
  let server: Server | undefined;
  let count = 0;
  const receivedSnapshot = new Promise<Record<string, unknown>>((resolve) => {
    server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe(expectedPath);
      count += 1;

      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (count === 1) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "temporary unavailable" }));
          return;
        }
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        resolve(JSON.parse(body));
      });
    });
  });

  if (!server) throw new Error("failed to create flaky snapshot server");
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  return {
    server,
    receivedSnapshot,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => count,
  };
}

async function startSlockInternalApiServer(): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer test-agent-token");
    expect(request.headers["x-agent-id"]).toBe("tester");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/internal/agent/tester/server") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        runtimeContext: { agentId: "tester", serverId: "server-1" },
        channels: [
          { id: "channel-1", name: "研发项目群", type: "channel", joined: true },
          { id: "channel-archived", name: "归档群", type: "channel", archivedAt: "2026-05-09T06:00:00.000Z", joined: true },
        ],
        agents: [{ id: "tester", name: "@tester" }],
        humans: [{ id: "user-1", name: "@zhangsan" }],
      }));
      return;
    }
    if (url.pathname === "/internal/agent/tester/tasks" && url.searchParams.get("channel") === "#研发项目群") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        tasks: [{
          id: "task-1",
          taskNumber: 12,
          title: "修复登录回调异常",
          status: "IN PROGRESS",
          creator: { name: "@zhangsan" },
          assignee: { name: "@tester" },
          createdAt: "2026-05-09T06:30:00.000Z",
          updatedAt: "2026-05-09T06:45:00.000Z",
          messageId: "message-1",
          threadId: "thread-1",
        }],
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startControlServer(options: {
  expectedHelloDeviceToken?: string;
} = {}): Promise<{
  baseUrl: string;
  close: () => void;
  startupResult: Promise<{
    hello: Record<string, unknown>;
    heartbeat: Record<string, unknown>;
    snapshots: Array<Record<string, unknown>>;
    workStateSnapshots: Array<Record<string, unknown>>;
  }>;
}> {
  const snapshots: Array<Record<string, unknown>> = [];
  const workStateSnapshots: Array<Record<string, unknown>> = [];
  let webSocketServer: WebSocketServer | undefined;
  let server: Server | undefined;
  let helloMessage: Record<string, unknown> | undefined;
  let heartbeatMessage: Record<string, unknown> | undefined;

  const startupResult = new Promise<{
    hello: Record<string, unknown>;
    heartbeat: Record<string, unknown>;
    snapshots: Array<Record<string, unknown>>;
    workStateSnapshots: Array<Record<string, unknown>>;
  }>((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => reject(new Error("collector startup upload timed out")), 5000);
    const maybeResolve = () => {
      if (resolved || !helloMessage || !heartbeatMessage || snapshots.length === 0 || workStateSnapshots.length === 0) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({
        hello: helloMessage,
        heartbeat: heartbeatMessage,
        snapshots,
        workStateSnapshots,
      });
    };

    server = createServer((request, response) => {
      if (
        request.method !== "POST"
        || ![
          "/api/device-snapshots",
          "/api/runtime-work-state-snapshots",
        ].includes(request.url ?? "")
      ) {
        response.writeHead(404);
        response.end();
        return;
      }

      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const snapshot = JSON.parse(body);
        if (request.url === "/api/device-snapshots") snapshots.push(snapshot);
        if (request.url === "/api/runtime-work-state-snapshots") workStateSnapshots.push(snapshot);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        maybeResolve();
      });
    });

    webSocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/api/device-control/ws") {
        socket.destroy();
        return;
      }
      webSocketServer?.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer?.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (webSocket) => {
      webSocket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "hello") {
          if (options.expectedHelloDeviceToken) {
            expect(message.deviceToken).toBe(options.expectedHelloDeviceToken);
            delete message.deviceToken;
          }
          helloMessage = message;
          maybeResolve();
        }
        if (message.type === "heartbeat") {
          heartbeatMessage = message;
          maybeResolve();
        }
      });
    });
  });

  if (!server) throw new Error("failed to create control server");
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close() {
      webSocketServer?.close();
      server?.close();
    },
    startupResult,
  };
}
