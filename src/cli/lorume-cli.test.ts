import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(output.observedAt).toEqual(expect.any(String));
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
    for (const command of ["multica", "slock", "codex", "claude"]) {
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
      title: "Run a local OpenClaw check",
      status: "in_progress",
      source: { kind: "openclaw", externalId: "run-webchat-1" },
      taskType: "conversation",
      channel: { kind: "webchat", name: "OpenClaw Web Chat", externalId: "conversation-local-1" },
    });
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
      traceError: "previous attempt failed",
    });
    writeOpenClawTrajectoryFile(sessionDir, "task-failed-with-error", {
      finalStatus: "error",
      prompt: "失败任务需要保留错误原因",
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
    expect(output.diagnostics.warnings).toContainEqual(expect.stringContaining("task-ambiguous-1"));
    expect(output.diagnostics.warnings).toContainEqual(expect.stringContaining("ambiguous OpenClaw agent"));
  });

  it("maps OpenClaw trajectory run evidence into device-state tasks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lorume-cli-device-state-trajectory-"));
    const binDir = path.join(root, "bin");
    const sessionDir = path.join(root, ".openclaw", "agents", "main", "sessions", "live");
    const sessionFile = path.join(sessionDir, "run-traj-1.session.jsonl");
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
    writeFileSync(sessionFile, [
      JSON.stringify({ role: "user", content: "整理今天项目风险并同步到群里" }),
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
        data: { finalStatus: "error", error: "tool failed" },
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
      id: "test-device:runtime:openclaw:agent:main:task:run-traj-1",
      agentId: "test-device:runtime:openclaw:agent:main",
      title: "整理今天项目风险并同步到群里",
      description: "整理今天项目风险并同步到群里",
      status: "failed",
      source: { kind: "openclaw", externalId: "msg-live-1" },
      taskType: "conversation",
      channel: { kind: "dingtalk", name: "日常工作提醒助手", externalId: "group-live" },
      conversation: {
        title: "日常工作提醒助手",
        externalId: "group-live",
        lastActivityAt: "2026-05-21T02:03:00.000Z",
      },
      creator: { name: "张良", externalId: "user-live-1" },
      toolCalls: [{
        id: "exec-1",
        name: "bash",
        status: "failed",
        arguments: { command: "python3 scripts/query_project_risks.py --today" },
        resultPreview: "tool failed",
        error: "tool failed",
      }],
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
      lastSeenAt: "2026-05-21T02:03:00.000Z",
    });
    expect(output.tasks[0]).not.toHaveProperty("runtimeId");
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
      id: "test-device:runtime:openclaw:agent:main:task:cron-daily-summary",
      agentId: "test-device:runtime:openclaw:agent:main",
      taskType: "scheduled",
      title: "[cron:daily-summary] 汇总今天的项目风险",
      status: "done",
      source: { kind: "openclaw", externalId: "cron-daily-summary" },
      raw: {
        openclaw: {
          sessionKey: "agent:main:cron:daily-summary",
          status: "success",
          statusSource: "trajectory",
          trajectoryRunId: "cron-daily-summary",
        },
      },
    });
    expect(output.tasks[0]).not.toHaveProperty("channel");
    expect(output.tasks[0]).not.toHaveProperty("conversation");
  });

  it("limits OpenClaw trajectory tasks to the most recent snapshot window", () => {
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
          sessionKey: "agent:main:dingtalk:group:group-live",
          ts: `2026-05-21T04:${minute}:00.000Z`,
          data: { agentId: "main" },
        }),
        JSON.stringify({
          type: "prompt.submitted",
          runId: `run-window-${index}`,
          sessionKey: "agent:main:dingtalk:group:group-live",
          ts: `2026-05-21T04:${minute}:10.000Z`,
          data: { prompt: `窗口任务 ${index}` },
        }),
        JSON.stringify({
          type: "trace.artifacts",
          runId: `run-window-${index}`,
          sessionKey: "agent:main:dingtalk:group:group-live",
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
        LORUME_OPENCLAW_TASK_SNAPSHOT_MAX_TASKS: "3",
        LORUME_OPENCLAW_TASK_SNAPSHOT_MAX_BYTES: "100000",
        PATH: binDir,
      },
    });

    expect(output.tasks.map((task: { id: string }) => task.id)).toEqual([
      "test-device:runtime:openclaw:agent:main:task:run-window-5",
      "test-device:runtime:openclaw:agent:main:task:run-window-4",
      "test-device:runtime:openclaw:agent:main:task:run-window-3",
    ]);
    expect(output.diagnostics.warnings).toContainEqual(expect.stringContaining("OpenClaw task snapshot truncated from 5 to 3"));
  });

  it("keeps OpenClaw task snapshots inside the byte budget without trimming kept tool arguments", () => {
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
        JSON.stringify({ role: "user", content: `大参数任务 ${index}` }),
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
          sessionKey: "agent:main:dingtalk:group:group-live",
          ts: `2026-05-21T05:${minute}:00.000Z`,
          data: { agentId: "main", sessionFile },
        }),
        JSON.stringify({
          type: "prompt.submitted",
          runId: `run-large-${index}`,
          sessionKey: "agent:main:dingtalk:group:group-live",
          ts: `2026-05-21T05:${minute}:10.000Z`,
          data: { prompt: `大参数任务 ${index}` },
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
        LORUME_OPENCLAW_TASK_SNAPSHOT_MAX_TASKS: "10",
        LORUME_OPENCLAW_TASK_SNAPSHOT_MAX_BYTES: "5000",
        PATH: binDir,
      },
    });

    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0].id).toBe("test-device:runtime:openclaw:agent:main:task:run-large-3");
    expect(output.tasks[0].toolCalls[0].arguments.payload).toHaveLength(2500);
    expect(Buffer.byteLength(JSON.stringify(output.tasks), "utf8")).toBeLessThanOrEqual(5000);
    expect(output.diagnostics.warnings).toContainEqual(expect.stringContaining("OpenClaw task snapshot truncated from 3 to 1"));
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

function writeOpenClawTrajectoryFile(
  sessionDir: string,
  runId: string,
  options: {
    finalStatus: "success" | "error";
    prompt: string;
    sessionKey?: string;
    traceError?: string;
  },
) {
  const sessionKey = options.sessionKey ?? "agent:main:dingtalk:group:group-live";
  writeFileSync(path.join(sessionDir, `${runId}.trajectory.jsonl`), [
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
      data: { prompt: options.prompt },
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
  ].join("\n"));
}

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}
