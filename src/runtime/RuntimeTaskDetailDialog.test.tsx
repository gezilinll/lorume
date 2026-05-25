import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuntimeTaskDetailDialog } from "./RuntimeTaskDetailDialog";
import type { RuntimeTaskBoardItem } from "./runtime-work-query-api";

const item: RuntimeTaskBoardItem = {
  adapter: { kind: "openclaw" },
  agentId: "fixture-agent",
  agentReply: "The handoff is ready for review.",
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

describe("RuntimeTaskDetailDialog", () => {
  it("renders a designed task detail card with summary, content, and context areas", () => {
    render(<RuntimeTaskDetailDialog item={item} onOpenChange={vi.fn()} open />);

    const dialog = screen.getByRole("dialog", { name: "PMO asked OpenClaw to in..." });
    expect(dialog).toHaveAttribute("data-surface", "task-detail");
    expect(dialog).toHaveAttribute("data-depth", "modal-3d");
    expect(dialog).toHaveAttribute("data-depth-intensity", "modal-3d");
    expect(dialog).toHaveAttribute("data-layout", "task-detail-simple");
    expect(dialog.className).toContain("sm:max-w-[640px]");

    expect(screen.getByRole("heading", { name: "PMO asked OpenClaw to in..." })).toBeInTheDocument();
    expect(screen.getByTestId("runtime-task-detail-title")).toHaveAttribute("title", item.userMessage);
    expect(screen.getByText("任务信息")).toBeInTheDocument();
    expect(screen.getByText("用户消息")).toBeInTheDocument();
    expect(screen.getByText("Agent 回复")).toBeInTheDocument();
    expect(screen.getByText("发起人")).toBeInTheDocument();
    expect(screen.getByText("PMO")).toBeInTheDocument();
    expect(screen.getByText("承接 Agent")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("更新时间")).toBeInTheDocument();
    expect(screen.getByText("2026/05/22 01:59:00")).toBeInTheDocument();
    expect(screen.getByText("渠道")).toBeInTheDocument();
    expect(screen.getByText("DingTalk")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("cid-private-raw");
    expect(dialog).not.toHaveTextContent("未关联执行");
    expect(dialog).not.toHaveTextContent("任务状态");
    expect(dialog).not.toHaveTextContent("采集来源");
    expect(dialog).not.toHaveTextContent("Adapter");
    expect(dialog).not.toHaveTextContent("任务类型");
  });

  it("uses a clear fallback when the Agent has not replied", () => {
    render(<RuntimeTaskDetailDialog item={{ ...item, agentReply: undefined }} onOpenChange={vi.fn()} open />);

    expect(screen.getByTestId("runtime-task-detail-agent-reply")).toHaveTextContent("暂无 Agent 答复");
  });
});
