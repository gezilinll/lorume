import { describe, expect, it } from "vitest";
import {
  agentReplyFallback,
  formatRuntimeTaskAgentReply,
  formatRuntimeTaskCardTitle,
  formatRuntimeTaskDetailTitle,
  getRuntimeTaskCardPills,
} from "./runtime-task-display";
import type { RuntimeTaskBoardItem } from "./runtime-work-query-api";

const taskItem: RuntimeTaskBoardItem = {
  adapter: { kind: "openclaw" },
  agentId: "fixture-agent",
  assignee: { name: "main" },
  assigneeLabel: "main",
  channel: { externalId: "cid-private-raw", kind: "dingtalk" },
  channelKindLabel: "DingTalk",
  channelLabel: "DingTalk 群聊",
  conversation: { externalId: "cid-private-raw", title: "DingTalk 群聊" },
  creator: { name: "PMO" },
  creatorLabel: "PMO",
  displayTitle: "PMO asked OpenClaw to inspect the handoff.",
  id: "fixture-agent:task:1",
  requestExcerpt: "PMO asked OpenClaw to inspect the handoff.",
  status: "todo",
  statusLabel: "待处理",
  taskType: "conversation",
  updatedAt: "2026-05-21T17:59:00.000Z",
  userMessage: "PMO asked OpenClaw to inspect the handoff.",
};

describe("runtime task display helpers", () => {
  it("derives compact task copy from real Task fields", () => {
    expect(formatRuntimeTaskCardTitle(taskItem)).toBe("PMO asked OpenCl...");
    expect(formatRuntimeTaskDetailTitle(taskItem)).toBe("PMO asked OpenClaw to in...");
    expect(formatRuntimeTaskAgentReply(taskItem)).toBe(agentReplyFallback);
    expect(formatRuntimeTaskAgentReply({ ...taskItem, agentReply: "The handoff is ready for review." })).toBe("The handoff is ready for review.");
  });

  it("uses only real channel metadata as card pills", () => {
    expect(getRuntimeTaskCardPills(taskItem).map((pill) => [pill.kind, pill.label])).toEqual([
      ["channel", "DingTalk"],
    ]);
  });

  it("omits card pills when no real channel metadata exists", () => {
    expect(getRuntimeTaskCardPills({ ...taskItem, channelKindLabel: undefined, channel: undefined })).toEqual([]);
  });
});
