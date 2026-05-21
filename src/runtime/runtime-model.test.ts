import { describe, expect, it } from "vitest";
import {
  COLLECTION_STATUSES,
  RUNTIME_KINDS,
  TASK_STATUSES,
  createDeviceStateSnapshot,
  normalizeTaskStatus,
} from "./runtime-model";

describe("runtime four-object model", () => {
  it("defines the compact status and runtime kind sets", () => {
    expect(COLLECTION_STATUSES).toEqual(["syncing", "online", "offline", "error"]);
    expect(RUNTIME_KINDS).toEqual(["openclaw", "slock", "multica", "codex"]);
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
      observedAt: "2026-05-21T00:00:00.000Z",
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
        status: "in_progress",
        lastRun: { status: "running" },
      }],
    });

    expect(snapshot.runtimes[0]).not.toHaveProperty("capabilities");
    expect(snapshot.runtimes[0]).not.toHaveProperty("endpoint");
    expect(snapshot.runtimes[0]).not.toHaveProperty("sourceRefs");
    expect(snapshot.agents[0]).not.toHaveProperty("origin");
    expect(snapshot.agents[0]).not.toHaveProperty("sourceRefs");
    expect(snapshot.agents[0]).not.toHaveProperty("load");
    expect(snapshot.tasks[0]).not.toHaveProperty("runtimeId");
    expect(snapshot.tasks[0]).not.toHaveProperty("lastRun");
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

  it("preserves OpenClaw task type, tool calls, creator external id, and raw status", () => {
    const snapshot = createDeviceStateSnapshot({
      observedAt: "2026-05-22T00:00:00.000Z",
      device: { id: "fixture-device", hostname: "fixture.local", os: "darwin", collectionStatus: "online" },
      runtimes: [],
      agents: [],
      tasks: [{
        id: "fixture-device:runtime:openclaw:agent:main:task:msg-1",
        agentId: "fixture-device:runtime:openclaw:agent:main",
        taskType: "conversation",
        title: "查 Seedance 指标",
        status: "success",
        source: { kind: "openclaw", externalId: "msg-1" },
        channel: { kind: "dingtalk", name: "日常工作提醒助手", externalId: "cid-example" },
        conversation: { title: "日常工作提醒助手", externalId: "cid-example" },
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
      source: { kind: "openclaw", externalId: "msg-1" },
      creator: { name: "张良", externalId: "100854680226406967" },
      toolCalls: [expect.objectContaining({ id: "exec-1", status: "failed" })],
      raw: { openclaw: expect.objectContaining({ status: "done", messageId: "msg-1" }) },
    });
  });

  it("drops runtime source names from task channel context", () => {
    const snapshot = createDeviceStateSnapshot({
      observedAt: "2026-05-21T00:00:00.000Z",
      device: { id: "device-1", hostname: "device-1.local", os: "darwin" },
      tasks: [{
        id: "agent-1:task:local-1",
        agentId: "agent-1",
        title: "Local runtime work",
        status: "done",
        channel: { kind: "openclaw", name: "OpenClaw" },
        conversation: { title: "OpenClaw" },
      }],
    });

    expect(snapshot.tasks[0]).not.toHaveProperty("channel");
    expect(snapshot.tasks[0]).not.toHaveProperty("conversation");
  });
});
