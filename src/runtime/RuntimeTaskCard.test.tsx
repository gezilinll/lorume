import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RuntimeTaskCard } from "./RuntimeTaskCard";
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

describe("RuntimeTaskCard", () => {
  it("renders a compact Taskflow-style task card", async () => {
    const onSelect = vi.fn();
    render(<RuntimeTaskCard item={item} onSelect={onSelect} />);

    const card = screen.getByRole("button", { name: /PMO asked OpenCl/ });
    expect(card).toHaveAttribute("data-view", "mail-list-item");
    expect(card).toHaveAttribute("data-spotlight", "task-card");
    expect(card).toHaveAttribute("data-state", "idle");
    expect(card).toHaveClass("py-3");
    expect(card.className).toContain("before:bg-[var(--card-color)]");
    expect(card.className).toContain("hover:shadow-[0_12px_26px");
    expect(screen.getByTestId("runtime-task-card-assignee")).toHaveTextContent("main");
    expect(screen.getByTestId("runtime-task-card-title")).toHaveTextContent("PMO asked OpenCl...");
    expect(screen.getByTestId("runtime-task-card-title")).toHaveAttribute("title", item.userMessage);
    expect(screen.getByTestId("runtime-task-card-reply")).toHaveTextContent("The handoff is ready for review.");
    expect(screen.getByTestId("runtime-task-card-footer")).toHaveTextContent("2026/05/22 01:59:00");
    expect(screen.getByTestId("runtime-task-card-footer")).toHaveClass("overflow-visible");

    const pillLabels = Array.from(card.querySelectorAll("[data-pill-kind]")).map((pill) => pill.textContent);
    expect(pillLabels).toEqual(["DingTalk"]);
    expect(card).not.toHaveTextContent("待处理");
    expect(card).not.toHaveTextContent("DingTalk 群聊");
    expect(card).not.toHaveTextContent("未关联执行");
    expect(card).not.toHaveTextContent("cid-private-raw");
    expect(card.querySelector("[data-spotlight-blob]")).not.toBeInTheDocument();

    await userEvent.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(card).toHaveAttribute("data-state", "idle");
  });

  it("uses a clear fallback when the Agent has not replied", () => {
    render(<RuntimeTaskCard item={{ ...item, agentReply: undefined }} onSelect={vi.fn()} />);

    expect(screen.getByTestId("runtime-task-card-reply")).toHaveTextContent("暂无 Agent 答复");
  });
});
