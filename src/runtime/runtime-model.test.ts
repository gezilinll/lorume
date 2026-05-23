import { describe, expect, it } from "vitest";
import {
  COLLECTION_STATUSES,
  RUNTIME_KINDS,
  TASK_ADAPTER_KINDS,
  TASK_CHANNEL_KINDS,
  TASK_STATUSES,
  createDeviceStateSnapshot,
  normalizeDeviceStateSnapshot,
  normalizeTaskStatus,
} from "./runtime-model";

describe("runtime four-object model", () => {
  it("defines the compact status and runtime kind sets", () => {
    expect(COLLECTION_STATUSES).toEqual(["syncing", "online", "offline", "error"]);
    expect(RUNTIME_KINDS).toEqual(["openclaw"]);
    expect(TASK_STATUSES).toEqual([
      "todo",
      "in_progress",
      "review",
      "done",
      "blocked",
      "failed",
      "cancelled",
      "unknown",
    ]);
  });

  it("creates a device-state snapshot without removed product fields", () => {
    const snapshot = createDeviceStateSnapshot({
      collectedAt: "2026-05-21T00:00:00.000Z",
      device: {
        id: "fixture-device",
        hostname: "fixture-device.local",
        os: "darwin",
        architecture: "arm64",
        collectionStatus: "online",
        lastSeenAt: "2026-05-21T00:00:00.000Z",
        collector: { version: "0.1.0", installPath: "/tmp/lorume" },
      },
      runtimes: [{
        id: "fixture-device:runtime:openclaw",
        deviceId: "fixture-device",
        kind: "openclaw",
        name: "OpenClaw Gateway",
        collectionStatus: "online",
        capabilities: ["health"],
        endpoint: "http://127.0.0.1:1234",
        sourceRefs: [{ source: "openclaw", externalId: "gateway-local" }],
      }],
      agents: [{
        id: "fixture-device:runtime:openclaw:agent:main",
        runtimeId: "fixture-device:runtime:openclaw",
        name: "main",
        collectionStatus: "online",
        origin: "openclaw",
        sourceRefs: [{ source: "openclaw", externalId: "main" }],
        load: { activeTasks: 1 },
      }],
      tasks: [{
        id: "fixture-device:runtime:openclaw:agent:main:task:task-1",
        agentId: "fixture-device:runtime:openclaw:agent:main",
        runtimeId: "fixture-device:runtime:openclaw",
        title: "Handle DingTalk request",
        description: "legacy description",
        toolCalls: [{ id: "exec-1", name: "bash", status: "done" }],
        userMessage: "Handle DingTalk request",
        status: "in_progress",
        adapter: { kind: "openclaw" },
        lastSeenAt: "2026-05-21T00:00:02.000Z",
        lastRun: { status: "running" },
      }],
    });

    expect(snapshot).toHaveProperty("collectedAt", "2026-05-21T00:00:00.000Z");
    expect(snapshot).not.toHaveProperty("observedAt");
    expect(snapshot.runtimes[0]).not.toHaveProperty("capabilities");
    expect(snapshot.runtimes[0]).not.toHaveProperty("endpoint");
    expect(snapshot.runtimes[0]).not.toHaveProperty("sourceRefs");
    expect(snapshot.agents[0]).not.toHaveProperty("origin");
    expect(snapshot.agents[0]).not.toHaveProperty("sourceRefs");
    expect(snapshot.agents[0]).not.toHaveProperty("load");
    expect(snapshot.tasks[0]).not.toHaveProperty("runtimeId");
    expect(snapshot.tasks[0]).not.toHaveProperty("lastRun");
    expect(snapshot.tasks[0]).not.toHaveProperty("title");
    expect(snapshot.tasks[0]).not.toHaveProperty("description");
    expect(snapshot.tasks[0]).not.toHaveProperty("toolCalls");
    expect(snapshot.tasks[0]).not.toHaveProperty("lastSeenAt");
    expect(snapshot.tasks[0]).toMatchObject({
      adapter: { kind: "openclaw" },
      userMessage: "Handle DingTalk request",
      status: "in_progress",
    });
  });

  it("defines only implemented task adapter and channel kinds", () => {
    expect(TASK_ADAPTER_KINDS).toEqual(["openclaw"]);
    expect(TASK_CHANNEL_KINDS).toEqual(["dingtalk", "webchat"]);
  });

  it("drops unsupported runtime kinds instead of coercing them to OpenClaw", () => {
    const snapshot = createDeviceStateSnapshot({
      collectedAt: "2026-05-21T00:00:00.000Z",
      device: { id: "device-1", hostname: "device-1.local", os: "darwin" },
      runtimes: [{
        id: "device-1:runtime:codex",
        deviceId: "device-1",
        kind: "codex",
        name: "Codex",
        collectionStatus: "online",
      }],
      agents: [],
      tasks: [],
    });

    expect(snapshot.runtimes).toEqual([]);
  });

  it("normalizes external task and execution evidence into a single task status", () => {
    expect(normalizeTaskStatus("queued")).toBe("todo");
    expect(normalizeTaskStatus("running")).toBe("in_progress");
    expect(normalizeTaskStatus("in_review")).toBe("review");
    expect(normalizeTaskStatus("succeeded")).toBe("done");
    expect(normalizeTaskStatus("success")).toBe("done");
    expect(normalizeTaskStatus("error")).toBe("failed");
    expect(normalizeTaskStatus("timed_out")).toBe("failed");
    expect(normalizeTaskStatus("lost")).toBe("failed");
    expect(normalizeTaskStatus("canceled")).toBe("cancelled");
    expect(normalizeTaskStatus("interrupted")).toBe("cancelled");
    expect(normalizeTaskStatus("not-a-known-status")).toBe("unknown");
  });

  it("preserves slim OpenClaw task fields, creator external id, assignee, and raw status", () => {
    const snapshot = createDeviceStateSnapshot({
      collectedAt: "2026-05-22T00:00:00.000Z",
      device: { id: "fixture-device", hostname: "fixture.local", os: "darwin", collectionStatus: "online" },
      runtimes: [],
      agents: [],
      tasks: [{
        id: "fixture-device:runtime:openclaw:agent:main:task:msg-1",
        agentId: "fixture-device:runtime:openclaw:agent:main",
        taskType: "conversation",
        title: "legacy title",
        description: "legacy description",
        userMessage: "查 Seedance 指标",
        agentReply: "应该查询 SLS 项目和对应日志库。",
        status: "success",
        adapter: { kind: "openclaw" },
        channel: { kind: "dingtalk", externalId: "cid-example" },
        conversation: { title: "日常工作提醒助手", externalId: "cid-example" },
        assignee: { name: "main", externalId: "main" },
        creator: { name: "张良", externalId: "100854680226406967" },
        toolCalls: [{
          id: "exec-1",
          name: "bash",
          status: "failed",
          arguments: { command: "python3 scripts/query_logs.py --query test" },
          resultPreview: "partial failures",
          error: "Column cannot be resolved",
        }],
        raw: {
          openclaw: {
            status: "done",
            statusSource: "session",
            sessionId: "session-1",
            sessionKey: "agent:main:dingtalk:group:cid-example",
            messageId: "msg-1",
            trajectoryRunId: "run-1",
          },
        },
      }],
    });

    expect(snapshot.tasks[0]).toMatchObject({
      taskType: "conversation",
      status: "done",
      userMessage: "查 Seedance 指标",
      agentReply: "应该查询 SLS 项目和对应日志库。",
      adapter: { kind: "openclaw" },
      channel: { kind: "dingtalk", externalId: "cid-example" },
      assignee: { name: "main", externalId: "main" },
      creator: { name: "张良", externalId: "100854680226406967" },
      raw: { openclaw: expect.objectContaining({ status: "done", messageId: "msg-1" }) },
    });
    expect(snapshot.tasks[0]).not.toHaveProperty("source");
    expect(snapshot.tasks[0].channel).not.toHaveProperty("name");
    expect(snapshot.tasks[0]).not.toHaveProperty("title");
    expect(snapshot.tasks[0]).not.toHaveProperty("description");
    expect(snapshot.tasks[0]).not.toHaveProperty("toolCalls");
  });

  it("drops unsupported task channel context", () => {
    const snapshot = createDeviceStateSnapshot({
      collectedAt: "2026-05-21T00:00:00.000Z",
      device: { id: "device-1", hostname: "device-1.local", os: "darwin" },
      tasks: [{
        id: "agent-1:task:local-1",
        agentId: "agent-1",
        title: "Local runtime work",
        userMessage: "Local runtime work",
        status: "done",
        adapter: { kind: "openclaw" },
        channel: { kind: "unsupported-channel" },
        conversation: { title: "Unsupported channel" },
      }],
    });

    expect(snapshot.tasks[0]).not.toHaveProperty("channel");
    expect(snapshot.tasks[0]).not.toHaveProperty("conversation");
  });

  it("normalizes only collectedAt snapshots and requires adapter provenance instead of a title", () => {
    expect(normalizeDeviceStateSnapshot({
      observedAt: "2026-05-22T00:00:00.000Z",
      device: { id: "device-1", hostname: "device-1.local", os: "darwin" },
      tasks: [{ id: "task-1", agentId: "agent-1", status: "done", userMessage: "Hello" }],
    })).toBeNull();

    expect(normalizeDeviceStateSnapshot({
      collectedAt: "2026-05-22T00:00:00.000Z",
      device: { id: "device-1", hostname: "device-1.local", os: "darwin" },
      tasks: [{ id: "task-1", agentId: "agent-1", status: "done", userMessage: "Hello" }],
    })).toBeNull();

    expect(normalizeDeviceStateSnapshot({
      collectedAt: "2026-05-22T00:00:00.000Z",
      device: { id: "device-1", hostname: "device-1.local", os: "darwin" },
      tasks: [{ id: "task-1", agentId: "agent-1", status: "done", userMessage: "Hello", adapter: { kind: "openclaw" } }],
    })?.tasks[0]).toMatchObject({
      id: "task-1",
      adapter: { kind: "openclaw" },
      userMessage: "Hello",
    });
  });
});
