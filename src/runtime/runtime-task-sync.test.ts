import { describe, expect, it } from "vitest";
import type { Task } from "./runtime-model";
import {
  createRuntimeTaskBatches,
  createRuntimeTaskHash,
  normalizeRuntimeTaskBatch,
  normalizeTaskHashText,
} from "./runtime-task-sync";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "agent-1:task:msg-1",
    agentId: "agent-1",
    taskType: "conversation",
    status: "in_progress",
    userMessage: "  帮我查 Seedance 调用次数\r\n",
    agentReply: "",
    adapter: { kind: "openclaw" },
    creator: { name: "张良", externalId: "user-1" },
    assignee: { name: "main", externalId: "main" },
    channel: { kind: "dingtalk", externalId: "cid-example" },
    conversation: { title: "日常工作提醒助手", externalId: "cid-example" },
    raw: { openclaw: { messageId: "msg-1", trajectoryRunId: "run-1" } },
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:01.000Z",
    ...overrides,
  };
}

describe("runtime task sync", () => {
  it("normalizes empty and whitespace text before hashing", () => {
    expect(normalizeTaskHashText(undefined)).toBeNull();
    expect(normalizeTaskHashText("   ")).toBeNull();
    expect(normalizeTaskHashText(" a\r\nb ")).toBe("a\nb");
  });

  it("hashes only product task semantics and ignores raw or collection freshness", () => {
    const baseHash = createRuntimeTaskHash(task());

    expect(createRuntimeTaskHash(task({
      raw: { openclaw: { trajectoryRunId: "run-2", sessionKey: "agent:main:dingtalk:group:cid" } },
      lastSeenAt: "2026-05-22T01:00:00.000Z",
    } as Partial<Task> & { lastSeenAt: string }))).toBe(baseHash);

    expect(createRuntimeTaskHash(task({ agentReply: "查到了，应该看 SLS A。" }))).not.toBe(baseHash);
    expect(createRuntimeTaskHash(task({ status: "done" }))).not.toBe(baseHash);
    expect(createRuntimeTaskHash(task({ adapter: { kind: "openclaw" } }))).toBe(baseHash);
  });

  it("keeps hash stable when only Slock raw evidence changes", () => {
    const first = task({
      adapter: { kind: "slock" },
      channel: { kind: "slock", externalId: "#daily-work" },
      raw: { slock: { messageId: "msg-1", status: "done" } },
    });
    const second = task({
      ...first,
      raw: { slock: { messageId: "msg-1", status: "in_progress" } },
    });

    expect(createRuntimeTaskHash(first)).toBe(createRuntimeTaskHash(second));
  });

  it("splits task batches by count and byte budget with deterministic batch ids", () => {
    const tasks = [
      task({ id: "agent-1:task:msg-1", userMessage: "first", updatedAt: "2026-05-22T00:00:03.000Z" }),
      task({ id: "agent-1:task:msg-2", userMessage: "second", updatedAt: "2026-05-22T00:00:02.000Z" }),
      task({ id: "agent-1:task:msg-3", userMessage: "third", updatedAt: "2026-05-22T00:00:01.000Z" }),
    ];

    const batches = createRuntimeTaskBatches(tasks, {
      batchMaxBytes: 10_000,
      batchMaxTasks: 2,
      collectedAt: "2026-05-22T00:00:10.000Z",
      deviceId: "device-1",
    });

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({
      batchIndex: 0,
      batchCount: 2,
      collectedAt: "2026-05-22T00:00:10.000Z",
      deviceId: "device-1",
      schemaVersion: "device-state-v3",
    });
    expect(batches[0].tasks.map((entry) => entry.task.id)).toEqual([
      "agent-1:task:msg-1",
      "agent-1:task:msg-2",
    ]);
    expect(batches[1].tasks.map((entry) => entry.task.id)).toEqual(["agent-1:task:msg-3"]);
    expect(batches[0].batchId).toBe(createRuntimeTaskBatches(tasks, {
      batchMaxBytes: 10_000,
      batchMaxTasks: 2,
      collectedAt: "2026-05-22T00:00:10.000Z",
      deviceId: "device-1",
    })[0].batchId);
  });

  it("normalizes inbound task batches and strips removed task fields", () => {
    const batch = normalizeRuntimeTaskBatch({
      schemaVersion: "device-state-v3",
      deviceId: "device-1",
      collectedAt: "2026-05-22T00:00:10.000Z",
      batchId: "batch-1",
      batchIndex: 0,
      batchCount: 1,
      tasks: [{
        hash: "hash-1",
        task: {
          ...task(),
          title: "old title",
          description: "old description",
          lastSeenAt: "2026-05-22T00:00:11.000Z",
        },
      }],
    });

    expect(batch).toMatchObject({
      batchCount: 1,
      batchId: "batch-1",
      batchIndex: 0,
      collectedAt: "2026-05-22T00:00:10.000Z",
      deviceId: "device-1",
      tasks: [{ hash: "hash-1", task: { id: "agent-1:task:msg-1", userMessage: "  帮我查 Seedance 调用次数\r\n" } }],
    });
    expect(batch?.tasks[0].task).not.toHaveProperty("title");
    expect(batch?.tasks[0].task).not.toHaveProperty("description");
    expect(batch?.tasks[0].task).not.toHaveProperty("lastSeenAt");
  });

  it("normalizes removed task ids in runtime task batches", () => {
    const batch = normalizeRuntimeTaskBatch({
      schemaVersion: "device-state-v3",
      deviceId: "device-1",
      collectedAt: "2026-05-22T00:00:10.000Z",
      batchId: "batch-removed-1",
      batchIndex: 0,
      batchCount: 1,
      tasks: [],
      removedTaskIds: [
        "agent-1:task:old-1",
        " agent-1:task:old-2 ",
        "",
        "agent-1:task:old-1",
      ],
    });

    expect(batch).toMatchObject({
      batchId: "batch-removed-1",
      removedTaskIds: ["agent-1:task:old-1", "agent-1:task:old-2"],
      tasks: [],
    });
  });
});
