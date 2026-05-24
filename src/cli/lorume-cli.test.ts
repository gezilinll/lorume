import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "scripts", "lorume.mjs");
const fixturePath = path.join(repoRoot, "fixtures", "runtime", "collector-snapshot.sample.json");

describe("lorume CLI", () => {
  it("prints deterministic JSON for local device identity", () => {
    const output = runCli([
      "device",
      "identify",
      "--json",
      "--device-id",
      "test-device",
    ]);

    expect(output.command).toBe("device.identify");
    expect(output.device).toMatchObject({
      architecture: process.arch,
      hostname: expect.any(String),
      id: "test-device",
      os: process.platform,
    });
    expect(output.device).not.toHaveProperty("name");
    expect(output.device).not.toHaveProperty("status");
    expect(output.device).not.toHaveProperty("connectionMode");
    expect(output.device.lastSeenAt).toEqual(expect.any(String));
    expect(output.collectedAt).toEqual(expect.any(String));
  });

  it("lists normalized runtimes and agents from a device-state snapshot", () => {
    const output = runCli(["runtime", "list", "--json", "--snapshot", fixturePath]);

    expect(output.command).toBe("runtime.list");
    expect(output.device.id).toBe("fixture-mac");
    expect(output.runtimes.map((runtime: { kind: string }) => runtime.kind)).toContain("openclaw");
    expect(output.agents.map((agent: { name: string }) => agent.name)).toContain("main");
  });

  it("collects OpenClaw-only device state without invoking disabled adapters", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-"));
    const binDir = path.join(root, "bin");
    const disabledCallsPath = path.join(root, "disabled-adapter-called");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "openclaw"), `#!/bin/sh
if [ "$1" = "health" ]; then
  printf '{"ok":true,"agents":[{"agentId":"main"}],"channels":{"dingtalk":{"enabled":true}}}\\n'
  exit 0
fi
if [ "$1" = "status" ]; then
  printf '{"gateway":{"reachable":true,"url":"local","self":{"version":"openclaw 1.0.0"}},"agents":{"agents":[{"agentId":"main","sessions":{"count":2}}]}}\\n'
  exit 0
fi
printf '{}\\n'
`);
    for (const command of ["multica", "slock", "codex"]) {
      writeExecutable(path.join(binDir, command), `#!/bin/sh
printf '${command}\\n' >> ${JSON.stringify(disabledCallsPath)}
exit 91
`);
    }

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.command).toBe("collect.device-state");
    expect(output.runtimes.map((runtime: { kind: string }) => runtime.kind)).toEqual(["openclaw"]);
    expect(output.agents.map((agent: { name: string }) => agent.name)).toEqual(["main"]);
    expect(output.tasks).toEqual([]);
    expect(output.runtimes[0]).not.toHaveProperty("capabilities");
    expect(output.runtimes[0]).not.toHaveProperty("endpoint");
    expect(output.runtimes[0]).not.toHaveProperty("sourceRefs");
    expect(output.agents[0]).not.toHaveProperty("origin");
    expect(output.agents[0]).not.toHaveProperty("sourceRefs");
    expect(output.agents[0]).not.toHaveProperty("load");
    expect(existsSync(disabledCallsPath)).toBe(false);
  });

  it("collects native Codex tasks while skipping Slock and Multica-owned Codex sessions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-codex-fixture-"));
    writeCodexFixtureHome(root);

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "fixture-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "codex",
      },
    });

    expect(output.runtimes).toEqual([
      expect.objectContaining({
        id: "fixture-device:runtime:codex",
        kind: "codex",
        name: "Codex",
        collectionStatus: "online",
      }),
    ]);
    expect(output.agents).toEqual([
      expect.objectContaining({
        id: "fixture-device:runtime:codex:agent:codex:local",
        runtimeId: "fixture-device:runtime:codex",
        name: "Codex",
        collectionStatus: "online",
      }),
    ]);
    expect(output.tasks).toEqual([
      expect.objectContaining({
        id: "fixture-device:runtime:codex:agent:codex:local:task:thread-native-unknown",
        agentId: "fixture-device:runtime:codex:agent:codex:local",
        taskType: "conversation",
        status: "unknown",
        userMessage: "帮我看一下这个 flaky test 为什么偶发失败",
        agentReply: "我还在排查测试波动。",
        adapter: { kind: "codex" },
        raw: {
          codex: expect.objectContaining({
            threadId: "thread-native-unknown",
            source: "vscode",
            model: "gpt-5.4",
            cwdKind: "codex-native-or-other",
            tokensUsed: 2560,
          }),
        },
      }),
      expect.objectContaining({
        id: "fixture-device:runtime:codex:agent:codex:local:task:thread-native-done",
        agentId: "fixture-device:runtime:codex:agent:codex:local",
        taskType: "conversation",
        status: "done",
        userMessage: "帮我总结一下当前仓库状态",
        agentReply: "仓库状态正常，没有发现阻塞。",
        adapter: { kind: "codex" },
        raw: {
          codex: expect.objectContaining({
            threadId: "thread-native-done",
            source: "exec",
            model: "gpt-5.4",
            cwdKind: "codex-native-or-other",
            tokensUsed: 1280,
            git: {
              branch: "main",
              sha: "abc1234",
              origin: "git@example.com:fixture/lorume.git",
            },
          }),
        },
      }),
    ]);
    for (const task of output.tasks) {
      expect(task).not.toHaveProperty("runtimeId");
      expect(task).not.toHaveProperty("title");
      expect(task).not.toHaveProperty("description");
      expect(task).not.toHaveProperty("toolCalls");
      expect(task).not.toHaveProperty("channel");
      expect(task).not.toHaveProperty("conversation");
    }
    expect(output.diagnostics.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "codex_missing_user_message", severity: "warning", count: 1 }),
      expect.objectContaining({ code: "codex_unknown_task_status", severity: "warning", count: 1 }),
      expect.objectContaining({ code: "codex_owned_by_slock_ignored", severity: "info", count: 1 }),
      expect.objectContaining({ code: "codex_owned_by_multica_ignored", severity: "info", count: 1 }),
    ]));
  });

  it("discovers Slock daemon credentials by default and collects local Slock tasks", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-daemon-discovery-"));
    const binDir = path.join(root, "bin");
    mkdirSync(path.join(root, ".slock", "agents", "agent-local-1"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "openclaw"), `#!/bin/sh
exit 127
`);
    writeExecutable(path.join(binDir, "ps"), `#!/bin/sh
cat <<'EOF'
fixture 12345 0.0 0.1 node /Users/fixture/.slock/chat-bridge.js --agent-id agent-local-1 --server-url ${server.baseUrl} --auth-token fixture-token --runtime codex --runtime-actions-only
EOF
`);

    try {
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "",
          LORUME_SLOCK_SERVER_URL: "",
          LORUME_SLOCK_BASE_URL: "",
          LORUME_SLOCK_AUTH_TOKEN: "",
          LORUME_SLOCK_API_KEY: "",
          LORUME_SLOCK_AGENT_IDS: "",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
        },
      });

      expect(output.runtimes).toEqual([
        expect.objectContaining({ id: "fixture-device:runtime:codex", kind: "codex", name: "Codex" }),
      ]);
      expect(output.agents).toEqual([
        expect.objectContaining({
          id: "fixture-device:runtime:codex:agent:slock:agent-local-1",
          name: "大卷Bot",
        }),
      ]);
      expect(output.tasks).toEqual([
        expect.objectContaining({
          id: "fixture-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1",
          agentId: "fixture-device:runtime:codex:agent:slock:agent-local-1",
          userMessage: "帮我整理今天的项目风险",
          adapter: { kind: "slock" },
          channel: { kind: "slock", externalId: "#daily-work" },
        }),
      ]);
      expect(server.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pathname: "/internal/agent/agent-local-1/profile",
          agentIdHeader: "agent-local-1",
          authorizationHeader: "Bearer fixture-token",
          slockClientHeader: "lorume-collector",
        }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("collects current-device Slock tasks through authenticated agent-scoped Slock APIs", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-workspace-"));
    mkdirSync(path.join(root, ".slock", "agents", "agent-workspace-1"), { recursive: true });
    try {
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1,agent-unsupported-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        },
      });

      expect(output.runtimes).toEqual([
        expect.objectContaining({ id: "fixture-device:runtime:codex", kind: "codex", name: "Codex" }),
      ]);
      expect(output.agents).toEqual([
        expect.objectContaining({
          id: "fixture-device:runtime:codex:agent:slock:agent-local-1",
          name: "大卷Bot",
          runtimeId: "fixture-device:runtime:codex",
        }),
      ]);
      expect(output.tasks).toEqual([
        expect.objectContaining({
          id: "fixture-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1",
          agentId: "fixture-device:runtime:codex:agent:slock:agent-local-1",
          userMessage: "帮我整理今天的项目风险",
          agentReply: "今天的主要风险是接口稳定性和排期收敛。",
          status: "done",
          adapter: { kind: "slock" },
          channel: { kind: "slock", externalId: "#daily-work" },
          conversation: { title: "日常工作", externalId: "#daily-work", lastActivityAt: "2026-05-23T01:05:00.000Z" },
          creator: { name: "张良", externalId: "user-1" },
          assignee: { name: "大卷Bot", externalId: "agent-local-1" },
          raw: {
            slock: {
              status: "done",
              taskNumber: "1001",
              messageId: "msg-local-1",
              channelTarget: "#daily-work",
              threadTarget: "#daily-work:msg-loca",
            },
          },
          createdAt: "2026-05-23T01:00:00.000Z",
          updatedAt: "2026-05-23T01:05:00.000Z",
        }),
      ]);
      expect(output.diagnostics.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_inactive_workspace_task_ignored", count: 1, severity: "warning" }),
        expect.objectContaining({ code: "slock_remote_agent_task_ignored", count: 1, severity: "info" }),
        expect.objectContaining({ code: "slock_unassigned_task_ignored", count: 1, severity: "info" }),
        expect.objectContaining({ code: "slock_unsupported_runtime_ignored", count: 1, severity: "info" }),
      ]));
      expect(server.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pathname: "/internal/agent/agent-local-1/profile",
          agentIdHeader: "agent-local-1",
          authorizationHeader: "Bearer fixture-token",
          slockClientHeader: "lorume-collector",
        }),
        expect.objectContaining({
          pathname: "/internal/agent/agent-local-1/history",
          channel: "#daily-work",
          agentIdHeader: "agent-local-1",
          authorizationHeader: "Bearer fixture-token",
          slockClientHeader: "lorume-collector",
        }),
        expect.objectContaining({
          pathname: "/internal/agent/agent-local-1/history",
          channel: "#daily-work:msg-loca",
          agentIdHeader: "agent-local-1",
          authorizationHeader: "Bearer fixture-token",
          slockClientHeader: "lorume-collector",
        }),
        expect.objectContaining({
          pathname: "/internal/agent/agent-unsupported-1/profile",
          agentIdHeader: "agent-unsupported-1",
          authorizationHeader: "Bearer fixture-token",
          slockClientHeader: "lorume-collector",
        }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("discovers joined Slock channels when channel targets are not configured", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-discovered-channels-"));
    try {
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        },
      });

      expect(output.tasks).toEqual([
        expect.objectContaining({
          id: "fixture-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1",
          agentReply: "今天的主要风险是接口稳定性和排期收敛。",
          channel: { kind: "slock", externalId: "#daily-work" },
          conversation: expect.objectContaining({ title: "日常工作", externalId: "#daily-work" }),
        }),
      ]);
      expect(server.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pathname: "/internal/agent/agent-local-1/server",
          agentIdHeader: "agent-local-1",
          authorizationHeader: "Bearer fixture-token",
          slockClientHeader: "lorume-collector",
        }),
        expect.objectContaining({
          pathname: "/internal/agent/agent-local-1/history",
          channel: "#daily-work",
        }),
      ]));
      expect(server.requests).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          pathname: "/internal/agent/agent-local-1/history",
          channel: "#public-not-joined",
        }),
      ]));
      expect(server.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pathname: "/internal/agent/agent-local-1/history",
          channel: "#daily-work:msg-loca",
        }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("reuses cached Slock agent replies for unchanged discovered tasks", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-reply-cache-"));
    const cachePath = path.join(root, "slock-reply-cache.json");
    try {
      const run = () => runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
          LORUME_SLOCK_REPLY_CACHE_PATH: cachePath,
        },
      });

      const first = await run();
      const firstThreadReads = server.requests.filter((request) =>
        request.pathname === "/internal/agent/agent-local-1/history" &&
        request.channel === "#daily-work:msg-loca"
      );
      expect(first.tasks[0]).toMatchObject({
        agentReply: "今天的主要风险是接口稳定性和排期收敛。",
      });
      expect(firstThreadReads).toHaveLength(1);

      server.requests.length = 0;
      const second = await run();
      const secondThreadReads = server.requests.filter((request) =>
        request.pathname === "/internal/agent/agent-local-1/history" &&
        request.channel === "#daily-work:msg-loca"
      );
      expect(second.tasks[0]).toMatchObject({
        agentReply: "今天的主要风险是接口稳定性和排期收敛。",
      });
      expect(secondThreadReads).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("refreshes cached Slock agent replies when reply fingerprint changes", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-reply-refresh-"));
    const cachePath = path.join(root, "slock-reply-cache.json");
    try {
      const env = {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
        LORUME_SLOCK_SERVER_URL: server.baseUrl,
        LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
        LORUME_SLOCK_AGENT_IDS: "agent-local-1",
        LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        LORUME_SLOCK_REPLY_CACHE_PATH: cachePath,
      };
      await runCliAsync(["collect", "device-state", "--json", "--device-id", "fixture-device"], { env });
      server.setDailyWorkReplyCount(2);
      server.setThreadReplyText("风险已更新为接口回归和资源锁定。");
      const output = await runCliAsync(["collect", "device-state", "--json", "--device-id", "fixture-device"], { env });
      expect(output.tasks[0]).toMatchObject({
        agentReply: "风险已更新为接口回归和资源锁定。",
      });
    } finally {
      await server.close();
    }
  });

  it("keeps Slock Tasks when agent reply thread enrichment fails", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-reply-failure-"));
    try {
      server.failThreadHistory();
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        },
      });

      expect(output.tasks).toEqual([
        expect.objectContaining({
          id: "fixture-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1",
          userMessage: "帮我整理今天的项目风险",
        }),
      ]);
      expect(output.tasks[0]).not.toHaveProperty("agentReply");
      expect(output.diagnostics.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_agent_reply_fetch_failed", severity: "warning" }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("classifies done Slock tasks when reply threads are empty or unavailable", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-reply-gap-"));
    try {
      server.setJoinedChannelTargets(["#reply-missing"]);
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        },
      });

      expect(output.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "fixture-device:runtime:codex:agent:slock:agent-local-1:task:empty-thread-task" }),
        expect.objectContaining({ id: "fixture-device:runtime:codex:agent:slock:agent-local-1:task:unavailable-thread-task" }),
      ]));
      expect(output.tasks).toHaveLength(2);
      for (const task of output.tasks) expect(task).not.toHaveProperty("agentReply");
      expect(output.diagnostics.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_agent_reply_thread_empty", severity: "warning", count: 1 }),
        expect.objectContaining({ code: "slock_agent_reply_thread_unavailable", severity: "warning", count: 1 }),
      ]));
      expect(output.diagnostics.items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_missing_agent_reply" }),
        expect.objectContaining({ code: "slock_agent_reply_fetch_failed" }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("limits Slock agent reply thread reads per collector run without dropping Tasks", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-reply-budget-"));
    try {
      server.setJoinedChannelTargets(["#reply-budget"]);
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
          LORUME_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN: "1",
        },
      });

      const threadReads = server.requests.filter((request) =>
        request.pathname === "/internal/agent/agent-local-1/history" &&
        request.channel.startsWith("#reply-budget:budget-")
      );
      const repliedTasks = output.tasks.filter((task: { agentReply?: string }) => task.agentReply);

      expect(output.tasks).toHaveLength(3);
      expect(repliedTasks).toEqual([
        expect.objectContaining({ userMessage: "预算任务 A", agentReply: "预算任务 A 的执行回复" }),
      ]);
      expect(threadReads).toHaveLength(1);
      expect(output.diagnostics.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_agent_reply_deferred", severity: "info", count: 2 }),
      ]));
      expect(output.diagnostics.items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_missing_agent_reply" }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("continues deferred Slock agent reply enrichment on later collector runs", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-reply-budget-cache-"));
    const cachePath = path.join(root, "slock-reply-cache.json");
    try {
      server.setJoinedChannelTargets(["#reply-budget"]);
      const env = {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
        LORUME_SLOCK_SERVER_URL: server.baseUrl,
        LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
        LORUME_SLOCK_AGENT_IDS: "agent-local-1",
        LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        LORUME_SLOCK_REPLY_CACHE_PATH: cachePath,
        LORUME_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN: "1",
      };

      const first = await runCliAsync(["collect", "device-state", "--json", "--device-id", "fixture-device"], { env });
      expect(first.tasks.filter((task: { agentReply?: string }) => task.agentReply)).toHaveLength(1);

      server.requests.length = 0;
      const second = await runCliAsync(["collect", "device-state", "--json", "--device-id", "fixture-device"], { env });
      const secondThreadReads = server.requests.filter((request) =>
        request.pathname === "/internal/agent/agent-local-1/history" &&
        request.channel.startsWith("#reply-budget:budget-")
      );
      expect(secondThreadReads).toHaveLength(1);
      expect(second.tasks.filter((task: { agentReply?: string }) => task.agentReply)).toHaveLength(2);
      expect(second.diagnostics.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_agent_reply_deferred", severity: "info", count: 1 }),
      ]));

      server.requests.length = 0;
      const third = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          ...env,
          LORUME_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN: "10",
        },
      });
      const thirdThreadReads = server.requests.filter((request) =>
        request.pathname === "/internal/agent/agent-local-1/history" &&
        request.channel.startsWith("#reply-budget:budget-")
      );
      expect(thirdThreadReads).toHaveLength(1);
      expect(third.tasks.filter((task: { agentReply?: string }) => task.agentReply)).toHaveLength(3);
      expect(third.diagnostics?.items ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_agent_reply_deferred" }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("allows Slock reply thread reads to be disabled for a collector run", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-reply-budget-zero-"));
    try {
      server.setJoinedChannelTargets(["#reply-budget"]);
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
          LORUME_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN: "0",
        },
      });

      const threadReads = server.requests.filter((request) =>
        request.pathname === "/internal/agent/agent-local-1/history" &&
        request.channel.startsWith("#reply-budget:budget-")
      );

      expect(output.tasks).toHaveLength(3);
      for (const task of output.tasks) expect(task).not.toHaveProperty("agentReply");
      expect(threadReads).toHaveLength(0);
      expect(output.diagnostics.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_agent_reply_deferred", severity: "info", count: 3 }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("retries transient Slock read-only API failures", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-retry-"));
    try {
      server.failProfileOnce();
      server.failServerDiscoveryOnce();
      server.failDailyWorkHistoryOnce();
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        },
      });

      expect(output.tasks).toEqual([
        expect.objectContaining({
          id: "fixture-device:runtime:codex:agent:slock:agent-local-1:task:msg-local-1",
          agentReply: "今天的主要风险是接口稳定性和排期收敛。",
        }),
      ]);
      expect(output.diagnostics?.items ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_profile_unreadable" }),
        expect.objectContaining({ code: "slock_channel_discovery_failed" }),
        expect.objectContaining({ code: "slock_history_pagination_incomplete" }),
      ]));
      expect(server.requests.filter((request) => request.pathname === "/internal/agent/agent-local-1/profile")).toHaveLength(2);
      expect(server.requests.filter((request) => request.pathname === "/internal/agent/agent-local-1/server")).toHaveLength(2);
      expect(server.requests.filter((request) =>
        request.pathname === "/internal/agent/agent-local-1/history" &&
        request.channel === "#daily-work"
      ).length).toBeGreaterThan(1);
    } finally {
      await server.close();
    }
  });

  it("trusts explicit Slock pagination flags when a history page reaches the request limit", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-exact-limit-"));
    try {
      server.setJoinedChannelTargets(["#exact-limit"]);
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        },
      });

      expect(output.runtimes).toEqual([
        expect.objectContaining({ id: "fixture-device:runtime:codex", kind: "codex" }),
      ]);
      expect(output.tasks).toEqual([]);
      expect(output.diagnostics?.items ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_history_pagination_incomplete" }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("does not warn when a Slock task is assigned to another active local agent", async () => {
    const server = await startSlockFixtureServer();
    const root = mkdtempSync(path.join(tmpdir(), "lorume-slock-local-peer-"));
    try {
      server.setJoinedChannelTargets(["#shared-local"]);
      const output = await runCliAsync([
        "collect",
        "device-state",
        "--json",
        "--device-id",
        "fixture-device",
      ], {
        env: {
          LORUME_COLLECTOR_HOME: root,
          LORUME_ENABLED_RUNTIME_ADAPTERS: "slock",
          LORUME_SLOCK_SERVER_URL: server.baseUrl,
          LORUME_SLOCK_AUTH_TOKEN: "fixture-token",
          LORUME_SLOCK_AGENT_IDS: "agent-local-1,agent-local-2",
          LORUME_SLOCK_COMPUTER_HOSTNAME: "fixture-device.local",
        },
      });

      expect(output.tasks).toEqual([
        expect.objectContaining({
          id: "fixture-device:runtime:codex:agent:slock:agent-local-1:task:msg-shared-local-1",
          agentId: "fixture-device:runtime:codex:agent:slock:agent-local-1",
        }),
      ]);
      const sharedLocalHistoryReads = server.requests.filter((request) =>
        request.pathname.endsWith("/history") &&
        request.channel === "#shared-local"
      );
      expect(sharedLocalHistoryReads).toHaveLength(1);
      expect(output.diagnostics?.items ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "slock_remote_agent_task_ignored" }),
        expect.objectContaining({ code: "slock_inactive_workspace_task_ignored" }),
      ]));
    } finally {
      await server.close();
    }
  });

  it("does not create product Tasks from OpenClaw tasks list output", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-task-"));
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: {
        tasks: [{
          taskId: "task-live-1",
          runId: "run-live-1",
          status: "running",
          agentId: "main",
          task: "帮我检查线上告警，并回复群里",
          requesterSessionKey: "agent:main:dingtalk:group:group-live",
          requesterOriginJson: JSON.stringify({
            channel: "dingtalk",
            to: "group-live",
            messageId: "msg-live-1",
            senderId: "user-live-1",
            senderName: "张三",
          }),
          createdAt: "2026-05-21T01:00:00.000Z",
          lastEventAt: "2026-05-21T01:05:00.000Z",
        }],
      },
    });

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toEqual([]);
  });

  it("maps OpenClaw webchat trajectory runs without using runtime source as Task channel", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-runtime-channel-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "webchat");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeFileSync(path.join(sessionDir, "run-webchat-1.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "run-webchat-1",
        sessionKey: "agent:main:webchat:conversation-local-1",
        ts: "2026-05-21T03:00:00.000Z",
        data: { agentId: "main" },
      }),
      JSON.stringify({
        type: "prompt.submitted",
        runId: "run-webchat-1",
        sessionKey: "agent:main:webchat:conversation-local-1",
        ts: "2026-05-21T03:01:00.000Z",
        data: { prompt: "Run a local OpenClaw check" },
      }),
    ].join("\n"));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0]).toMatchObject({
      id: "test-device:runtime:openclaw:agent:main:task:run-webchat-1",
      agentId: "test-device:runtime:openclaw:agent:main",
      userMessage: "Run a local OpenClaw check",
      status: "in_progress",
      adapter: { kind: "openclaw" },
      taskType: "conversation",
      channel: { kind: "webchat", externalId: "conversation-local-1" },
      conversation: { title: "OpenClaw Web Chat", externalId: "conversation-local-1" },
      assignee: { name: "main", externalId: "main" },
    });
    expect(output.tasks[0]).not.toHaveProperty("title");
    expect(output.tasks[0]).not.toHaveProperty("description");
    expect(output.tasks[0]).not.toHaveProperty("toolCalls");
    expect(output.tasks[0]).not.toHaveProperty("lastSeenAt");
    expect(output.tasks[0].channel.kind).not.toBe("openclaw");
  });

  it("only exposes OpenClaw task errors for failed tasks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-task-error-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "errors");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeOpenClawTrajectoryFile(sessionDir, "task-done-with-stale-error", {
      finalStatus: "success",
      prompt: "已经完成但保留了历史错误字段",
      sessionKey: "agent:main:webchat:errors",
      traceError: "previous attempt failed",
    });
    writeOpenClawTrajectoryFile(sessionDir, "task-failed-with-error", {
      finalStatus: "error",
      prompt: "失败任务需要保留错误原因",
      sessionKey: "agent:main:webchat:errors",
      traceError: "tool failed",
    });

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    const doneTask = output.tasks.find((task: { id: string }) => task.id.endsWith(":task:task-done-with-stale-error"));
    const failedTask = output.tasks.find((task: { id: string }) => task.id.endsWith(":task:task-failed-with-error"));
    expect(doneTask).toMatchObject({ status: "done", taskType: "conversation" });
    expect(doneTask).not.toHaveProperty("error");
    expect(failedTask).toMatchObject({ status: "failed", taskType: "conversation", error: "tool failed" });
  });

  it("does not warn for missing agentReply when OpenClaw reports messaging delivery", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-task-reply-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "reply");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeOpenClawTrajectoryFile(sessionDir, "task-done-missing-reply", {
      finalStatus: "success",
      prompt: "完成后没有可读回复文本",
      sessionKey: "agent:main:webchat:reply",
    });
    writeFileSync(path.join(sessionDir, "task-done-sent-via-tool.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "task-done-sent-via-tool",
        sessionKey: "agent:main:webchat:reply",
        ts: "2026-05-21T04:00:00.000Z",
        data: { agentId: "main" },
      }),
      JSON.stringify({
        type: "prompt.submitted",
        runId: "task-done-sent-via-tool",
        sessionKey: "agent:main:webchat:reply",
        ts: "2026-05-21T04:01:00.000Z",
        data: { prompt: "回复通过消息工具发送" },
      }),
      JSON.stringify({
        type: "trace.artifacts",
        runId: "task-done-sent-via-tool",
        sessionKey: "agent:main:webchat:reply",
        ts: "2026-05-21T04:03:00.000Z",
        data: {
          didSendViaMessagingTool: true,
          finalStatus: "success",
        },
      }),
    ].join("\n"));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    const warning = output.diagnostics.items.find((item: { code?: string }) => item.code === "openclaw_missing_agent_reply");
    expect(warning).toMatchObject({
      count: 1,
      message: "1 条 OpenClaw 会话/定时任务缺少 Agent 回复，已按不完整任务入库。",
      sampleRefs: ["task-done-missing-reply"],
      severity: "warning",
    });
    expect(output.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "test-device:runtime:openclaw:agent:main:task:task-done-missing-reply", status: "done" }),
      expect.objectContaining({ id: "test-device:runtime:openclaw:agent:main:task:task-done-sent-via-tool", status: "done" }),
    ]));
  });

  it("skips OpenClaw trajectory runs when agent ownership is ambiguous", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-ambiguous-task-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "ambiguous");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }, { agentId: "backup" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }, { agentId: "backup" }] },
      },
      tasks: { tasks: [] },
    });
    writeFileSync(path.join(sessionDir, "task-ambiguous-1.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "task-ambiguous-1",
        sessionKey: "dingtalk:group:group-live",
        ts: "2026-05-21T04:00:00.000Z",
      }),
      JSON.stringify({
        type: "prompt.submitted",
        runId: "task-ambiguous-1",
        sessionKey: "dingtalk:group:group-live",
        ts: "2026-05-21T04:01:00.000Z",
        data: { prompt: "没有明确 agent 的任务" },
      }),
    ].join("\n"));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toEqual([]);
    expect(output.diagnostics.items).toContainEqual(expect.objectContaining({
      code: "openclaw_ambiguous_agent_link",
      count: 1,
      severity: "warning",
      sampleRefs: ["task-ambiguous-1"],
    }));
  });

  it("maps OpenClaw trajectory run evidence into device-state tasks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-trajectory-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "live");
    const dingtalkStateDir = path.join(root, ".openclaw", "agents", "main", "sessions", "dingtalk-state");
    const sessionFile = path.join(sessionDir, "run-traj-1.session.jsonl");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(dingtalkStateDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeFileSync(sessionFile, [
      JSON.stringify({ role: "user", content: "整理今天项目风险并同步到群里" }),
      JSON.stringify({
        role: "assistant",
        content: "我会整理风险并同步到群里。",
      }),
      JSON.stringify({
        role: "assistant",
        toolCall: {
          id: "exec-1",
          name: "bash",
          arguments: { command: "python3 scripts/query_project_risks.py --today" },
        },
      }),
      JSON.stringify({
        type: "toolResult",
        toolCallId: "exec-1",
        isError: true,
        content: "tool failed",
      }),
    ].join("\n"));
    writeFileSync(path.join(sessionDir, "run-traj-1.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "run-traj-1",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T02:00:00.000Z",
        data: { agentId: "main", sessionFile },
      }),
      JSON.stringify({
        type: "prompt.submitted",
        runId: "run-traj-1",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T02:01:00.000Z",
        data: {
          prompt: "整理今天项目风险并同步到群里",
          runtimeContext: {
            chat_id: "group-live",
            group_subject: "日常工作提醒助手",
            message_id: "msg-live-1",
            sender: "张良",
            sender_id: "user-live-1",
          },
        },
      }),
      JSON.stringify({
        type: "trace.artifacts",
        runId: "run-traj-1",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T02:03:00.000Z",
        data: { finalStatus: "error", error: "tool failed", assistantTexts: ["我会整理风险并同步到群里。"] },
      }),
    ].join("\n"));
    writeFileSync(path.join(dingtalkStateDir, "targets.directory.json"), JSON.stringify({
      groups: {
        "group-live": { currentTitle: "日常工作提醒助手" },
      },
    }));
    writeFileSync(path.join(dingtalkStateDir, "messages.context.json"), JSON.stringify({
      records: [{
        msgId: "msg-live-1",
        conversationId: "group-live",
        direction: "inbound",
        text: "整理今天项目风险并同步到群里",
        senderId: "user-live-1",
        senderName: "张良",
        createdAt: "2026-05-21T02:01:00.000Z",
        updatedAt: "2026-05-21T02:01:00.000Z",
      }],
    }));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0]).toMatchObject({
      id: "test-device:runtime:openclaw:agent:main:task:run-traj-1",
      agentId: "test-device:runtime:openclaw:agent:main",
      userMessage: "整理今天项目风险并同步到群里",
      agentReply: "我会整理风险并同步到群里。",
      status: "failed",
      adapter: { kind: "openclaw" },
      taskType: "conversation",
      channel: { kind: "dingtalk", externalId: "group-live" },
      conversation: {
        title: "日常工作提醒助手",
        externalId: "group-live",
        lastActivityAt: "2026-05-21T02:03:00.000Z",
      },
      creator: { name: "张良", externalId: "user-live-1" },
      assignee: { name: "main", externalId: "main" },
      raw: {
        openclaw: {
          messageId: "msg-live-1",
          sessionKey: "agent:main:dingtalk:group:group-live",
          status: "error",
          statusSource: "trajectory",
          trajectoryRunId: "run-traj-1",
        },
      },
      error: "tool failed",
      createdAt: "2026-05-21T02:00:00.000Z",
      updatedAt: "2026-05-21T02:03:00.000Z",
    });
    expect(output.tasks[0]).not.toHaveProperty("runtimeId");
    expect(output.tasks[0]).not.toHaveProperty("title");
    expect(output.tasks[0]).not.toHaveProperty("description");
    expect(output.tasks[0]).not.toHaveProperty("toolCalls");
    expect(output.tasks[0]).not.toHaveProperty("lastSeenAt");
  });

  it("matches DingTalk messages through canonical conversation ids from OpenClaw targets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-dingtalk-canonical-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "live");
    const dingtalkStateDir = path.join(root, ".openclaw", "agents", "main", "sessions", "dingtalk-state");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(dingtalkStateDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeFileSync(path.join(sessionDir, "run-canonical.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "run-canonical",
        sessionKey: "agent:main:dingtalk:group:cidztz9jowm0xwxyssk2rf4uw==",
        ts: "2026-05-21T02:00:00.000Z",
        data: { agentId: "main" },
      }),
      JSON.stringify({
        type: "prompt.submitted",
        runId: "run-canonical",
        sessionKey: "agent:main:dingtalk:group:cidztz9jowm0xwxyssk2rf4uw==",
        ts: "2026-05-21T02:01:00.000Z",
        data: { prompt: "记录问题" },
      }),
      JSON.stringify({
        type: "trace.artifacts",
        runId: "run-canonical",
        sessionKey: "agent:main:dingtalk:group:cidztz9jowm0xwxyssk2rf4uw==",
        ts: "2026-05-21T02:03:00.000Z",
        data: { finalStatus: "success", assistantTexts: ["已记录。"] },
      }),
    ].join("\n"));
    writeFileSync(path.join(dingtalkStateDir, "targets.directory.json"), JSON.stringify({
      groups: {
        "cidZtz9jOwM0xwxYSSK2RF4Uw==": { currentTitle: "问题登记群" },
      },
    }));
    writeFileSync(path.join(dingtalkStateDir, "messages.context.json"), JSON.stringify({
      records: [{
        msgId: "msg-canonical-1",
        conversationId: "cidZtz9jOwM0xwxYSSK2RF4Uw==",
        direction: "inbound",
        text: "记录问题",
        senderId: "user-canonical-1",
        senderName: "张良",
        createdAt: "2026-05-21T02:01:00.000Z",
        updatedAt: "2026-05-21T02:01:00.000Z",
      }],
    }));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0]).toMatchObject({
      userMessage: "记录问题",
      agentReply: "已记录。",
      adapter: { kind: "openclaw" },
      channel: { kind: "dingtalk", externalId: "cidZtz9jOwM0xwxYSSK2RF4Uw==" },
      conversation: { title: "问题登记群", externalId: "cidZtz9jOwM0xwxYSSK2RF4Uw==" },
      creator: { name: "张良", externalId: "user-canonical-1" },
    });
    expect(output.diagnostics?.items || []).not.toContainEqual(expect.objectContaining({
      code: "openclaw_legacy_dingtalk_context_missing",
    }));
  });

  it("maps OpenClaw cron trajectory runs into scheduled Tasks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-scheduled-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "cron");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeOpenClawTrajectoryFile(sessionDir, "cron-daily-summary", {
      finalStatus: "success",
      prompt: "[cron:daily-summary] 汇总今天的项目风险",
      sessionKey: "agent:main:cron:daily-summary",
    });
    writeOpenClawTrajectoryFile(sessionDir, "cron-interrupted", {
      finalStatus: "interrupted",
      prompt: "[cron:weekly-report 工具产研团队昨日日报文档-工具能力合伙人] 生成昨天的团队日报",
      sessionKey: "agent:main:cron:weekly-report",
    });

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toHaveLength(2);
    expect(output.tasks.find((task: { id: string }) => task.id.endsWith(":task:cron-daily-summary"))).toMatchObject({
      id: "test-device:runtime:openclaw:agent:main:task:cron-daily-summary",
      agentId: "test-device:runtime:openclaw:agent:main",
      taskType: "scheduled",
      userMessage: "[cron:daily-summary] 汇总今天的项目风险",
      status: "done",
      adapter: { kind: "openclaw" },
      assignee: { name: "main", externalId: "main" },
      raw: {
        openclaw: {
          sessionKey: "agent:main:cron:daily-summary",
          status: "success",
          statusSource: "trajectory",
          trajectoryRunId: "cron-daily-summary",
        },
      },
    });
    expect(output.tasks.find((task: { id: string }) => task.id.endsWith(":task:cron-interrupted"))).toMatchObject({
      taskType: "scheduled",
      userMessage: "[cron:weekly-report 工具产研团队昨日日报文档-工具能力合伙人] 生成昨天的团队日报",
      status: "cancelled",
      adapter: { kind: "openclaw" },
      raw: { openclaw: { status: "interrupted" } },
    });
    expect(output.tasks.find((task: { id: string }) => task.id.endsWith(":task:cron-daily-summary"))).not.toHaveProperty("channel");
    expect(output.tasks.find((task: { id: string }) => task.id.endsWith(":task:cron-daily-summary"))).not.toHaveProperty("conversation");
    expect(output.tasks[0]).not.toHaveProperty("title");
    expect(output.tasks[0]).not.toHaveProperty("description");
  });

  it("uses run-bound OpenClaw messagesSnapshot user turns for DingTalk conversation tasks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-snapshot-turn-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "live");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeFileSync(path.join(sessionDir, "run-snapshot-turn.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "run-snapshot-turn",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:00:00.000Z",
        data: { agentId: "main" },
      }),
      JSON.stringify({
        type: "model.completed",
        runId: "run-snapshot-turn",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:02:00.000Z",
        data: {
          messagesSnapshot: [{
            role: "user",
            content: "Conversation metadata: {\"message_id\":\"msg-snapshot-1\",\"chat_id\":\"group-live\",\"group_subject\":\"日常工作提醒助手\",\"sender\":\"张良\",\"sender_id\":\"user-live-1\"}\n\n帮我查 Seedance 模型今天的调用次数、成功次数和失败原因",
          }],
          assistantTexts: ["Seedance 今天调用 128 次，成功 120 次，失败 8 次。"],
        },
      }),
      JSON.stringify({
        type: "trace.artifacts",
        runId: "run-snapshot-turn",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:03:00.000Z",
        data: { finalStatus: "success" },
      }),
    ].join("\n"));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0]).toMatchObject({
      id: "test-device:runtime:openclaw:agent:main:task:run-snapshot-turn",
      agentId: "test-device:runtime:openclaw:agent:main",
      userMessage: "帮我查 Seedance 模型今天的调用次数、成功次数和失败原因",
      agentReply: "Seedance 今天调用 128 次，成功 120 次，失败 8 次。",
      status: "done",
      adapter: { kind: "openclaw" },
      taskType: "conversation",
      channel: { kind: "dingtalk", externalId: "group-live" },
      conversation: {
        title: "日常工作提醒助手",
        externalId: "group-live",
        lastActivityAt: "2026-05-21T06:03:00.000Z",
      },
      creator: { name: "张良", externalId: "user-live-1" },
      assignee: { name: "main", externalId: "main" },
      raw: {
        openclaw: {
          messageId: "msg-snapshot-1",
          sessionKey: "agent:main:dingtalk:group:group-live",
          status: "success",
          statusSource: "trajectory",
          trajectoryRunId: "run-snapshot-turn",
        },
      },
      createdAt: "2026-05-21T06:00:00.000Z",
      updatedAt: "2026-05-21T06:03:00.000Z",
    });
    expect(output.diagnostics?.items ?? []).not.toContainEqual(expect.objectContaining({
      code: "openclaw_legacy_dingtalk_context_missing",
    }));
  });

  it("does not create DingTalk tasks from messagesSnapshot user text without runtime context", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-snapshot-no-context-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "live");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeFileSync(path.join(sessionDir, "run-snapshot-no-context.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "run-snapshot-no-context",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:00:00.000Z",
        data: { agentId: "main" },
      }),
      JSON.stringify({
        type: "model.completed",
        runId: "run-snapshot-no-context",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:02:00.000Z",
        data: {
          messagesSnapshot: [{
            role: "user",
            content: "帮我查 Seedance 模型今天的调用次数、成功次数和失败原因",
          }],
          assistantTexts: ["已查询。"],
        },
      }),
      JSON.stringify({
        type: "trace.artifacts",
        runId: "run-snapshot-no-context",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:03:00.000Z",
        data: { finalStatus: "success" },
      }),
    ].join("\n"));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toEqual([]);
    expect(output.diagnostics.items).toContainEqual(expect.objectContaining({
      code: "openclaw_legacy_dingtalk_context_missing",
      count: 1,
      severity: "warning",
      sampleRefs: ["run-snapshot-no-context"],
    }));
  });

  it("records diagnostics instead of uploading DingTalk conversation tasks without inbound message context", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-missing-message-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "dingtalk-missing-message");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeFileSync(path.join(sessionDir, "run-missing-message.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "run-missing-message",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:00:00.000Z",
        data: { agentId: "main" },
      }),
      JSON.stringify({
        type: "prompt.submitted",
        runId: "run-missing-message",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:01:00.000Z",
        data: {
          prompt: "Conversation metadata: {\"message_id\":\"msg-missing\",\"chat_id\":\"group-live\"}\n\n帮我拉5月16日的数据",
        },
      }),
    ].join("\n"));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toEqual([]);
    expect(output.diagnostics.items).toContainEqual(expect.objectContaining({
      code: "openclaw_legacy_dingtalk_context_missing",
      count: 1,
      severity: "warning",
      sampleRefs: ["run-missing-message"],
    }));
  });

  it("records orphan OpenClaw runs without user turns as diagnostics only", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-orphan-run-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "dingtalk-orphan-run");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeFileSync(path.join(sessionDir, "run-orphan.trajectory.jsonl"), [
      JSON.stringify({
        type: "session.started",
        runId: "run-orphan",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:00:00.000Z",
        data: { agentId: "main" },
      }),
      JSON.stringify({
        type: "prompt.submitted",
        runId: "run-orphan",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:01:00.000Z",
        data: {},
      }),
      JSON.stringify({
        type: "model.completed",
        runId: "run-orphan",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:02:00.000Z",
        data: {},
      }),
      JSON.stringify({
        type: "trace.artifacts",
        runId: "run-orphan",
        sessionKey: "agent:main:dingtalk:group:group-live",
        ts: "2026-05-21T06:03:00.000Z",
        data: { finalStatus: "success", assistantTexts: ["已处理。"] },
      }),
    ].join("\n"));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toEqual([]);
    expect(output.diagnostics.items).toContainEqual(expect.objectContaining({
      code: "openclaw_orphan_run_missing_user_turn",
      count: 1,
      severity: "warning",
      sampleRefs: ["run-orphan"],
    }));
  });

  it("filters internal OpenClaw announce and subagent runs into diagnostics only", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-internal-run-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "internal");
    const dingtalkStateDir = path.join(root, ".openclaw", "agents", "main", "sessions", "dingtalk-state");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(dingtalkStateDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });
    writeOpenClawTrajectoryFile(sessionDir, "announce-v1", {
      finalStatus: "success",
      prompt: "[announce:v1] publish OpenClaw internal status",
      sessionKey: "agent:main:webchat:internal",
    });
    writeOpenClawTrajectoryFile(sessionDir, "announce:v1:agent:main:subagent:researcher:run-1", {
      finalStatus: "success",
      prompt: "[Wed 2026-05-06 10:20 GMT+8] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> OpenClaw runtime context (internal): This context is not a user task.",
      sessionKey: "agent:main:dingtalk:group:group-live",
    });
    writeOpenClawTrajectoryFile(sessionDir, "subagent-run", {
      finalStatus: "success",
      prompt: "[subagent:researcher] internal scratchpad work",
      sessionKey: "agent:main:webchat:internal",
    });
    writeOpenClawTrajectoryFile(sessionDir, "runtime-context-subagent", {
      finalStatus: "success",
      prompt: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> OpenClaw runtime context (internal): This context is runtime-generated, not user-authored. [Internal task completion event] source: subagent session_key: agent:main:subagent:researcher type: subagent task status: completed successfully",
      sessionKey: "agent:main:dingtalk:group:group-live",
    });
    writeOpenClawTrajectoryFile(sessionDir, "runtime-context-subagent-snapshot", {
      finalStatus: "success",
      prompt: "",
      snapshotUserMessage: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> OpenClaw runtime context (internal): This context is runtime-generated, not user-authored. [Internal task completion event] source: subagent session_key: agent:main:subagent:researcher type: subagent task status: completed successfully",
      sessionKey: "agent:main:dingtalk:group:group-live",
    });
    writeOpenClawTrajectoryFile(sessionDir, "runtime-context-dingtalk-message", {
      finalStatus: "success",
      prompt: "Process DingTalk message",
      runtimeContext: {
        chat_id: "group-live",
        group_subject: "日常工作提醒助手",
        message_id: "msg-internal-context-1",
        sender: "张良",
        sender_id: "user-live-1",
      },
      sessionKey: "agent:main:dingtalk:group:group-live",
    });
    writeFileSync(path.join(dingtalkStateDir, "targets.directory.json"), JSON.stringify({
      groups: {
        "group-live": { currentTitle: "日常工作提醒助手" },
      },
    }));
    writeFileSync(path.join(dingtalkStateDir, "messages.context.json"), JSON.stringify({
      records: [{
        msgId: "msg-internal-context-1",
        conversationId: "group-live",
        direction: "inbound",
        text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> OpenClaw runtime context (internal): This context is runtime-generated, not user-authored. [Internal task completion event] source: subagent session_key: agent:main:subagent:researcher type: subagent task status: completed successfully",
        senderId: "user-live-1",
        senderName: "张良",
      }],
    }));

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks).toEqual([]);
    expect(output.diagnostics.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "openclaw_internal_announce_ignored",
        count: 2,
        severity: "debug",
        sampleRefs: ["announce-v1", "announce:v1:agent:main:subagent:researcher:run-1"],
      }),
      expect.objectContaining({
        code: "openclaw_internal_subagent_ignored",
        count: 4,
        severity: "debug",
        sampleRefs: expect.arrayContaining([
          "subagent-run",
          "runtime-context-subagent",
          "runtime-context-subagent-snapshot",
          "runtime-context-dingtalk-message",
        ]),
      }),
    ]));
    expect(output.diagnostics.items.some((item: { severity?: string }) => item.severity === "warning")).toBe(false);
  });

  it("does not cap OpenClaw trajectory tasks by count", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-task-window-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "window");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });

    for (let index = 1; index <= 5; index += 1) {
      const minute = String(index).padStart(2, "0");
      writeFileSync(path.join(sessionDir, `run-window-${index}.trajectory.jsonl`), [
        JSON.stringify({
          type: "session.started",
          runId: `run-window-${index}`,
          sessionKey: "agent:main:webchat:window-live",
          ts: `2026-05-21T04:${minute}:00.000Z`,
          data: { agentId: "main" },
        }),
        JSON.stringify({
          type: "prompt.submitted",
          runId: `run-window-${index}`,
          sessionKey: "agent:main:webchat:window-live",
          ts: `2026-05-21T04:${minute}:10.000Z`,
          data: { prompt: `窗口任务 ${index}` },
        }),
        JSON.stringify({
          type: "trace.artifacts",
          runId: `run-window-${index}`,
          sessionKey: "agent:main:webchat:window-live",
          ts: `2026-05-21T04:${minute}:30.000Z`,
          data: { finalStatus: "success" },
        }),
      ].join("\n"));
    }

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks.map((task: { id: string }) => task.id)).toEqual([
      "test-device:runtime:openclaw:agent:main:task:run-window-5",
      "test-device:runtime:openclaw:agent:main:task:run-window-4",
      "test-device:runtime:openclaw:agent:main:task:run-window-3",
      "test-device:runtime:openclaw:agent:main:task:run-window-2",
      "test-device:runtime:openclaw:agent:main:task:run-window-1",
    ]);
  });

  it("does not drop large OpenClaw tasks while omitting tool call payloads", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-task-bytes-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "bytes");
    const largeArgument = "x".repeat(2500);
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeOpenClawExecutable(binDir, {
      health: { ok: true, agents: [{ agentId: "main" }] },
      status: {
        gateway: { reachable: true, url: "local", self: { version: "openclaw 1.0.0" } },
        agents: { agents: [{ agentId: "main" }] },
      },
      tasks: { tasks: [] },
    });

    for (let index = 1; index <= 3; index += 1) {
      const minute = String(index).padStart(2, "0");
      const sessionFile = path.join(sessionDir, `run-large-${index}.session.jsonl`);
      writeFileSync(sessionFile, [
        JSON.stringify({ role: "user", content: `大参数任务 ${index} ${largeArgument}` }),
        JSON.stringify({
          role: "assistant",
          toolCall: {
            id: `tool-${index}`,
            name: "bash",
            arguments: { payload: largeArgument },
          },
        }),
      ].join("\n"));
      writeFileSync(path.join(sessionDir, `run-large-${index}.trajectory.jsonl`), [
        JSON.stringify({
          type: "session.started",
          runId: `run-large-${index}`,
          sessionKey: "agent:main:webchat:large-live",
          ts: `2026-05-21T05:${minute}:00.000Z`,
          data: { agentId: "main", sessionFile },
        }),
        JSON.stringify({
          type: "prompt.submitted",
          runId: `run-large-${index}`,
          sessionKey: "agent:main:webchat:large-live",
          ts: `2026-05-21T05:${minute}:10.000Z`,
          data: { prompt: `大参数任务 ${index} ${largeArgument}` },
        }),
      ].join("\n"));
    }

    const output = runCli([
      "collect",
      "device-state",
      "--json",
      "--device-id",
      "test-device",
    ], {
      env: {
        LORUME_COLLECTOR_HOME: root,
        LORUME_ENABLED_RUNTIME_ADAPTERS: "openclaw",
        PATH: binDir,
      },
    });

    expect(output.tasks.map((task: { id: string }) => task.id)).toEqual([
      "test-device:runtime:openclaw:agent:main:task:run-large-3",
      "test-device:runtime:openclaw:agent:main:task:run-large-2",
      "test-device:runtime:openclaw:agent:main:task:run-large-1",
    ]);
    expect(output.tasks[0].userMessage).toContain("大参数任务 3");
    expect(output.tasks[0]).not.toHaveProperty("toolCalls");
  });

  it("probes read-only Agent Skill metadata from explicit local roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-skill-"));
    const skillRoot = path.join(root, "review-assistant");
    mkdirSync(path.join(skillRoot, "references"), { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "# Review assistant");
    writeFileSync(path.join(skillRoot, "references", "guide.md"), "# Guide");
    writeFileSync(path.join(skillRoot, "config.json"), "{\"safe\":true}");

    const output = runCli([
      "agent",
      "skill-probe",
      "--json",
      "--agent-id",
      "agent-1",
      "--runtime-id",
      "runtime-1",
      "--device-id",
      "device-1",
      "--skill-root",
      skillRoot,
    ]);

    expect(output.command).toBe("agent.skill-probe");
    expect(output.status).toBe("succeeded");
    expect(output.targetAgentId).toBe("agent-1");
    expect(output.skills).toHaveLength(1);
    expect(output.skills[0]).toMatchObject({
      name: "review-assistant",
      entryPath: path.join(skillRoot, "SKILL.md"),
    });
    expect(output.skills[0].markdownFiles.map((file: { relativePath: string }) => file.relativePath)).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
    expect(output.skills[0].nonMarkdownFiles.map((file: { relativePath: string }) => file.relativePath)).toEqual([
      "config.json",
    ]);
  });

  it("checks connector status only from an authorized backend context", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lorume-cli-context-"));
    const contextPath = path.join(dir, "context.json");
    writeFileSync(contextPath, JSON.stringify({
      connectors: [
        { deviceId: "device-a", id: "connector-a", status: "online" },
      ],
    }));

    const output = runCli(["connector", "status", "--json", "--context", contextPath, "--target", "connector-a"]);

    expect(output).toMatchObject({
      command: "connector.status",
      connector: { deviceId: "device-a", id: "connector-a", status: "online" },
    });
  });

  it("copies an explicit file inside allowed roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-copy-"));
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "nested", "destination.txt");
    writeFileSync(source, "hello from lorume cli");

    const output = runCli([
      "files",
      "copy",
      "--json",
      "--from",
      source,
      "--to",
      destination,
      "--allow-root",
      root,
    ]);

    expect(output).toMatchObject({ command: "files.copy", status: "copied" });
    expect(readFileSync(destination, "utf8")).toBe("hello from lorume cli");
  });

  it("delegates collector uninstall to the installer capability", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-collector-"));
    const fakeInstaller = path.join(root, "install-device-collector.sh");
    const callsPath = path.join(root, "calls.jsonl");
    writeExecutable(fakeInstaller, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}
`);

    const output = runCli([
      "collector",
      "uninstall",
      "--json",
      "--install-dir",
      path.join(root, "collector"),
    ], {
      env: { LORUME_COLLECTOR_INSTALLER_PATH: fakeInstaller },
    });

    expect(output).toMatchObject({ command: "collector.uninstall", status: "succeeded" });
    expect(readFileSync(callsPath, "utf8")).toContain(`--install-dir ${path.join(root, "collector")} --uninstall`);
  });

  it("delegates collector stop to the installer capability", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-collector-"));
    const fakeInstaller = path.join(root, "install-device-collector.sh");
    const callsPath = path.join(root, "calls.jsonl");
    writeExecutable(fakeInstaller, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}
`);

    const output = runCli([
      "collector",
      "stop",
      "--json",
      "--install-dir",
      path.join(root, "collector"),
    ], {
      env: { LORUME_COLLECTOR_INSTALLER_PATH: fakeInstaller },
    });

    expect(output).toMatchObject({ command: "collector.stop", status: "succeeded" });
    expect(readFileSync(callsPath, "utf8")).toContain(`--install-dir ${path.join(root, "collector")} --stop`);
  });

  it("refuses path traversal outside allowed roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-safe-"));
    const outside = mkdtempSync(path.join(tmpdir(), "lorume-cli-outside-"));
    const source = path.join(root, "source.txt");
    writeFileSync(source, "do not leak");

    const result = spawnCli([
      "files",
      "copy",
      "--json",
      "--from",
      source,
      "--to",
      path.join(outside, "..", path.basename(outside), "destination.txt"),
      "--allow-root",
      root,
    ]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "unsafe_path",
    });
    expect(existsSync(path.join(outside, "destination.txt"))).toBe(false);
  });

  it("returns a JSON error for unsupported commands", () => {
    const result = spawnCli(["unknown", "thing", "--json"]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "unsupported_command",
    });
  });
});

function runCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Record<string, any> {
  return JSON.parse(execFileSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  }));
}

function runCliAsync(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function spawnCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function writeOpenClawExecutable(
  binDir: string,
  payload: { health: unknown; status: unknown; tasks: unknown },
) {
  writeExecutable(path.join(binDir, "openclaw"), `#!/usr/bin/env node
const payload = ${JSON.stringify(payload)};
const args = process.argv.slice(2);
if (args[0] === "health") {
  console.log(JSON.stringify(payload.health));
  process.exit(0);
}
if (args[0] === "status") {
  console.log(JSON.stringify(payload.status));
  process.exit(0);
}
if (args[0] === "tasks" && args[1] === "list") {
  console.log(JSON.stringify(payload.tasks));
  process.exit(0);
}
console.log("{}");
`);
}

function writeCodexFixtureHome(root: string) {
  const fixtureRoot = path.join(repoRoot, "fixtures", "runtime", "codex");
  const codexRoot = path.join(root, ".codex");
  const sessionsRoot = path.join(codexRoot, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  for (const fileName of [
    "native-done.jsonl",
    "native-unknown.jsonl",
    "slock-owned.jsonl",
    "multica-owned.jsonl",
    "missing-user.jsonl",
  ]) {
    writeFileSync(
      path.join(sessionsRoot, fileName),
      readFileSync(path.join(fixtureRoot, "sessions", fileName), "utf8"),
    );
  }

  const script = `
const { DatabaseSync } = require("node:sqlite");
const { readFileSync } = require("node:fs");
const [dbPath, sqlPath] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(readFileSync(sqlPath, "utf8"));
db.close();
`;
  execFileSync(process.execPath, [
    "--no-warnings",
    "-e",
    script,
    path.join(codexRoot, "state_5.sqlite"),
    path.join(fixtureRoot, "threads.sql"),
  ]);
}

function writeOpenClawTrajectoryFile(
  sessionDir: string,
  runId: string,
  options: {
    finalStatus: "success" | "error" | "interrupted";
    prompt: string;
    runtimeContext?: Record<string, unknown>;
    sessionKey?: string;
    snapshotUserMessage?: string;
    traceError?: string;
  },
) {
  const sessionKey = options.sessionKey ?? "agent:main:dingtalk:group:group-live";
  const records = [
    JSON.stringify({
      type: "session.started",
      runId,
      sessionKey,
      ts: "2026-05-21T04:00:00.000Z",
      data: { agentId: "main" },
    }),
    JSON.stringify({
      type: "prompt.submitted",
      runId,
      sessionKey,
      ts: "2026-05-21T04:01:00.000Z",
      data: {
        prompt: options.prompt,
        ...(options.runtimeContext ? { runtimeContext: options.runtimeContext } : {}),
      },
    }),
    JSON.stringify({
      type: "trace.artifacts",
      runId,
      sessionKey,
      ts: "2026-05-21T04:03:00.000Z",
      data: {
        finalStatus: options.finalStatus,
        ...(options.traceError ? { error: options.traceError } : {}),
      },
    }),
  ];
  if (options.snapshotUserMessage) {
    records.push(JSON.stringify({
      type: "model.completed",
      runId,
      sessionKey,
      ts: "2026-05-21T04:04:00.000Z",
      data: {
        messagesSnapshot: [
          { role: "user", content: options.snapshotUserMessage },
        ],
      },
    }));
  }
  writeFileSync(path.join(sessionDir, `${runId}.trajectory.jsonl`), records.join("\n"));
}

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

async function startSlockFixtureServer(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, string>>;
  setJoinedChannelTargets: (targets: string[]) => void;
  setDailyWorkReplyCount: (value: number) => void;
  setThreadReplyText: (value: string) => void;
  failThreadHistory: () => void;
  failProfileOnce: () => void;
  failServerDiscoveryOnce: () => void;
  failDailyWorkHistoryOnce: () => void;
  close: () => Promise<void>;
}> {
  const fixtureRoot = path.join(repoRoot, "fixtures", "runtime", "slock");
  const readFixture = (name: string) => readFileSync(path.join(fixtureRoot, name), "utf8");
  const requests: Array<Record<string, string>> = [];
  let joinedChannelTargets = ["#daily-work"];
  let dailyWorkReplyCount = 1;
  let threadReplyText = "今天的主要风险是接口稳定性和排期收敛。";
  let failThreadHistory = false;
  let failProfileOnce = false;
  let failServerDiscoveryOnce = false;
  let failDailyWorkHistoryOnce = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const pathAgentId = url.pathname.match(/^\/internal\/agent\/([^/]+)\//)?.[1] ?? "";
    const requestRecord = {
      pathname: url.pathname,
      channel: url.searchParams.get("channel") ?? url.searchParams.get("target") ?? "",
      agentIdHeader: String(request.headers["x-agent-id"] || ""),
      authorizationHeader: String(request.headers.authorization || ""),
      slockClientHeader: String(request.headers["x-slock-client"] || ""),
    };
    requests.push(requestRecord);
    const sendJson = (statusCode: number, body: string) => {
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(body);
    };

    if (pathAgentId && (
      requestRecord.agentIdHeader !== pathAgentId ||
      requestRecord.authorizationHeader !== "Bearer fixture-token" ||
      requestRecord.slockClientHeader !== "lorume-collector"
    )) {
      sendJson(401, JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/profile") {
      if (failProfileOnce) {
        failProfileOnce = false;
        sendJson(503, JSON.stringify({ error: "temporary_profile_unavailable" }));
        return;
      }
      sendJson(200, readFixture("profile-active.json"));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-2/profile") {
      sendJson(200, JSON.stringify({
        id: "agent-local-2",
        displayName: "小卷Bot",
        name: "xiaojuan-bot",
        runtime: "codex",
        status: "active",
        computerHostname: "fixture-device.local",
      }));
      return;
    }
    if (url.pathname === "/internal/agent/agent-unsupported-1/profile") {
      sendJson(200, readFixture("profile-unsupported-runtime.json"));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/server" || url.pathname === "/internal/agent/agent-local-2/server") {
      if (failServerDiscoveryOnce) {
        failServerDiscoveryOnce = false;
        sendJson(503, JSON.stringify({ error: "temporary_server_unavailable" }));
        return;
      }
      sendJson(200, JSON.stringify({
        channels: [
          ...joinedChannelTargets.map((target) => ({
            name: target.replace(/^#/, ""),
            target,
            joined: true,
          })),
          { name: "public-not-joined", target: "#public-not-joined", joined: false },
        ],
      }));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/history" && url.searchParams.get("channel") === "#daily-work") {
      if (failDailyWorkHistoryOnce) {
        failDailyWorkHistoryOnce = false;
        sendJson(503, JSON.stringify({ error: "temporary_history_unavailable" }));
        return;
      }
      const page = JSON.parse(readFixture(url.searchParams.has("before") ? "channel-history-page-2.json" : "channel-history-page-1.json"));
      if (!url.searchParams.has("before") && page.messages?.[0]) page.messages[0].replyCount = dailyWorkReplyCount;
      sendJson(200, JSON.stringify(page));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/history" && url.searchParams.get("channel") === "#reply-budget") {
      sendJson(200, JSON.stringify({
        channelName: "Reply Budget",
        messages: [
          {
            id: "budget-a-task",
            seq: 3,
            content: "预算任务 A",
            taskNumber: "3001",
            taskStatus: "done",
            taskAssigneeId: "agent-local-1",
            replyCount: 1,
            senderId: "user-1",
            senderName: "张良",
            createdAt: "2026-05-23T01:01:00.000Z",
            updatedAt: "2026-05-23T01:03:00.000Z",
          },
          {
            id: "budget-b-task",
            seq: 2,
            content: "预算任务 B",
            taskNumber: "3002",
            taskStatus: "done",
            taskAssigneeId: "agent-local-1",
            replyCount: 1,
            senderId: "user-1",
            senderName: "张良",
            createdAt: "2026-05-23T01:02:00.000Z",
            updatedAt: "2026-05-23T01:04:00.000Z",
          },
          {
            id: "budget-c-task",
            seq: 1,
            content: "预算任务 C",
            taskNumber: "3003",
            taskStatus: "done",
            taskAssigneeId: "agent-local-1",
            replyCount: 1,
            senderId: "user-1",
            senderName: "张良",
            createdAt: "2026-05-23T01:03:00.000Z",
            updatedAt: "2026-05-23T01:05:00.000Z",
          },
        ],
        has_older: false,
        has_more: false,
      }));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/history" && url.searchParams.get("channel") === "#reply-missing") {
      sendJson(200, JSON.stringify({
        channelName: "Reply Missing",
        messages: [
          {
            id: "empty-thread-task",
            seq: 2,
            content: "空 thread 的 done 任务",
            taskNumber: "4001",
            taskStatus: "done",
            taskAssigneeId: "agent-local-1",
            replyCount: 1,
            senderId: "user-1",
            senderName: "张良",
            createdAt: "2026-05-23T01:01:00.000Z",
            updatedAt: "2026-05-23T01:03:00.000Z",
          },
          {
            id: "unavailable-thread-task",
            seq: 1,
            content: "不可读 thread 的 done 任务",
            taskNumber: "4002",
            taskStatus: "done",
            taskAssigneeId: "agent-local-1",
            replyCount: 1,
            senderId: "user-1",
            senderName: "张良",
            createdAt: "2026-05-23T01:02:00.000Z",
            updatedAt: "2026-05-23T01:04:00.000Z",
          },
        ],
        has_older: false,
        has_more: false,
      }));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/history") {
      const budgetThreadKey = url.searchParams.get("channel")?.match(/^#reply-budget:(budget-[abc])$/)?.[1];
      if (budgetThreadKey) {
        const label = budgetThreadKey === "budget-a"
          ? "预算任务 A"
          : budgetThreadKey === "budget-b"
            ? "预算任务 B"
            : "预算任务 C";
        sendJson(200, JSON.stringify({
          messages: [{
            id: `${budgetThreadKey}-reply`,
            senderId: "agent-local-1",
            senderName: "大卷Bot",
            content: `${label} 的执行回复`,
            createdAt: "2026-05-23T01:06:00.000Z",
            updatedAt: "2026-05-23T01:07:00.000Z",
          }],
          has_older: false,
          has_more: false,
        }));
        return;
      }
    }
    if (url.pathname === "/internal/agent/agent-local-1/history" && url.searchParams.get("channel") === "#reply-missing:empty-th") {
      sendJson(200, JSON.stringify({
        messages: [],
        has_older: false,
        has_more: false,
      }));
      return;
    }
    if ((url.pathname === "/internal/agent/agent-local-1/history" || url.pathname === "/internal/agent/agent-local-2/history") && url.searchParams.get("channel") === "#shared-local") {
      sendJson(200, JSON.stringify({
        channelName: "共享频道",
        messages: [{
          id: "msg-shared-local-1",
          seq: 2,
          content: "请整理共享频道风险",
          taskNumber: "2001",
          taskStatus: "done",
          taskAssigneeId: "agent-local-1",
          senderId: "user-1",
          senderName: "张良",
          createdAt: "2026-05-23T01:00:00.000Z",
          updatedAt: "2026-05-23T01:03:00.000Z",
        }],
        has_older: false,
        has_more: false,
      }));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/history" && url.searchParams.get("channel") === "#shared-local:msg-shar") {
      sendJson(200, readFixture("thread-history.json"));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/history" && url.searchParams.get("channel") === "#exact-limit" && !url.searchParams.has("before")) {
      sendJson(200, JSON.stringify({
        channelName: "exact-limit",
        messages: Array.from({ length: 100 }, (_, index) => ({
          id: `noise-${index}`,
          seq: 100 - index,
          content: `noise ${index}`,
          createdAt: "2026-05-23T01:00:00.000Z",
        })),
        has_older: false,
        has_more: false,
      }));
      return;
    }
    if (url.pathname === "/internal/agent/agent-local-1/history" && url.searchParams.get("channel") === "#daily-work:msg-loca") {
      if (failThreadHistory) {
        sendJson(500, JSON.stringify({ error: "thread_unavailable" }));
        return;
      }
      sendJson(200, JSON.stringify({
        messages: [{
          id: "reply-1",
          senderId: "agent-local-1",
          senderName: "大卷Bot",
          content: threadReplyText,
          createdAt: "2026-05-23T01:04:00.000Z",
          updatedAt: "2026-05-23T01:05:00.000Z",
        }],
      }));
      return;
    }
    if (url.pathname.startsWith("/internal/agent/")) {
      sendJson(404, JSON.stringify({ error: "not_found" }));
      return;
    }
    sendJson(404, JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setJoinedChannelTargets: (targets: string[]) => {
      joinedChannelTargets = targets;
    },
    setDailyWorkReplyCount: (value: number) => {
      dailyWorkReplyCount = value;
    },
    setThreadReplyText: (value: string) => {
      threadReplyText = value;
    },
    failThreadHistory: () => {
      failThreadHistory = true;
    },
    failProfileOnce: () => {
      failProfileOnce = true;
    },
    failServerDiscoveryOnce: () => {
      failServerDiscoveryOnce = true;
    },
    failDailyWorkHistoryOnce: () => {
      failDailyWorkHistoryOnce = true;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
