import { describe, expect, it } from "vitest";
import {
  createRuntimeTaskBoard,
  createTasksQueryUrl,
  listRuntimeTaskChannelOptions,
  runtimeTasksQueryPageFromResponse,
} from "./runtime-work-query-api";

describe("Runtime task query API helpers", () => {
  it("creates backend query URLs for Task rows", () => {
    const url = createTasksQueryUrl("http://lorume.local", {
      channelKind: "dingtalk",
      search: "handoff",
      status: "in_progress",
      timeRange: { start: "2026-05-21T10:00:00", end: "2026-05-21T11:00:00" },
    }, { cursor: "cursor-1" });

    expect(url.pathname).toBe("/api/runtime-tasks");
    expect(url.searchParams.get("channelKind")).toBe("dingtalk");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
    expect(url.searchParams.get("search")).toBe("handoff");
    expect(url.searchParams.get("status")).toBe("in_progress");
    expect(url.searchParams.get("startAt")).toBe("2026-05-21T02:00:00.000Z");
    expect(url.searchParams.get("endAt")).toBe("2026-05-21T03:00:00.000Z");
  });

  it("parses Task query pages without title, description, runtimeId, lastRun, conversations, or executions", () => {
    const page = runtimeTasksQueryPageFromResponse({
      items: [{
        id: "agent-1:task:work-1",
        agentId: "agent-1",
        runtimeId: "must-not-leak",
        lastRun: { status: "running" },
        title: "Inspect task handoff",
        description: "Check the handoff context",
        userMessage: "Check the handoff context",
        agentReply: "I found the handoff owner.",
        status: "in_progress",
        channel: { kind: "dingtalk", name: "DingTalk 群聊", externalId: "group-1" },
        conversation: { title: "DingTalk 群聊", externalId: "conversation-1" },
        creator: { name: "PMO" },
        assignee: { name: "main" },
        lastSeenAt: "2026-05-21T10:00:00.000Z",
      }],
      nextCursor: "cursor-2",
      total: 2,
    });

    expect(page).toMatchObject({
      nextCursor: "cursor-2",
      total: 2,
      tasks: [expect.objectContaining({
        agentId: "agent-1",
        id: "agent-1:task:work-1",
        userMessage: "Check the handoff context",
        agentReply: "I found the handoff owner.",
      })],
    });
    expect(page?.tasks[0]).not.toHaveProperty("runtimeId");
    expect(page?.tasks[0]).not.toHaveProperty("lastRun");
    expect(page?.tasks[0]).not.toHaveProperty("title");
    expect(page?.tasks[0]).not.toHaveProperty("description");
    expect(page?.tasks[0]).not.toHaveProperty("lastSeenAt");
    expect(page).not.toHaveProperty("conversations");
    expect(page).not.toHaveProperty("executions");
  });

  it("groups Task rows by Task.status in UI/BFF code", () => {
    const page = runtimeTasksQueryPageFromResponse({
      items: [
        { id: "task-1", agentId: "agent-1", userMessage: "Queued", status: "todo" },
        { id: "task-2", agentId: "agent-1", userMessage: "Running", status: "in_progress" },
        { id: "task-3", agentId: "agent-1", userMessage: "Failed", status: "failed", error: "timeout" },
      ],
      total: 3,
    });

    if (!page) throw new Error("query page should be parsed");
    const board = createRuntimeTaskBoard(page.tasks, { status: "failed" });

    expect(board.summary).toMatchObject({
      failed: 1,
      in_progress: 1,
      todo: 1,
      total: 3,
    });
    expect(board.visibleItems).toEqual([expect.objectContaining({ id: "task-3", status: "failed" })]);
    expect(board.lanes.find((lane) => lane.status === "failed")?.items).toEqual([
      expect.objectContaining({ displayTitle: "Failed", id: "task-3", requestExcerpt: "Failed" }),
    ]);
  });

  it("lists user-facing channel filters from Task context only", () => {
    const page = runtimeTasksQueryPageFromResponse({
      items: [
        { id: "task-1", agentId: "agent-1", userMessage: "One", status: "todo", channel: { kind: "dingtalk", name: "DingTalk 群聊" } },
        { id: "task-2", agentId: "agent-1", userMessage: "Two", status: "todo", channel: { kind: "dingtalk", name: "DingTalk 群聊" } },
        { id: "task-3", agentId: "agent-1", userMessage: "Three", status: "todo", channel: { kind: "slack", name: "#ops" } },
      ],
      total: 3,
    });

    expect(listRuntimeTaskChannelOptions(page?.tasks ?? [])).toEqual([
      { label: "DingTalk", value: "dingtalk" },
      { label: "Slack", value: "slack" },
    ]);
  });
});
