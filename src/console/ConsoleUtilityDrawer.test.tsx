import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleUtilityBar, ConsoleUtilityDrawer } from "./ConsoleUtilityDrawer";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ConsoleUtilityDrawer", () => {
  it("shows top-right utility buttons with API-backed counts", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/operations")) {
        return jsonResponse({
          operations: [
            operationItem({ id: "op_1", status: "running" }),
            operationItem({ id: "op_2", status: "requires_manual_step" }),
            operationItem({ id: "op_3", status: "succeeded" }),
          ],
        });
      }
      if (url.includes("/api/notifications")) {
        return jsonResponse({ threads: [notificationThread({ isRead: false }), notificationThread({ id: "thread_2", isRead: true })] });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<ConsoleUtilityBar activeView={null} organizationId="org_1" onOpen={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "任务 2" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "通知 1" })).toBeInTheDocument();
  });

  it("shows operations as a right-side drawer with selectable details", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/operations")) {
        return jsonResponse({
          operations: [{
            createdAt: "2026-05-14T08:20:00.000Z",
            id: "op_1",
            resourceId: "thread_1",
            resourceType: "notification_thread",
            status: "queued",
            summary: "发送通知",
            targetId: "thread_1",
            targetType: "notification_thread",
            type: "notification_delivery",
            updatedAt: "2026-05-14T08:21:00.000Z",
          }],
        });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(
      <ConsoleUtilityDrawer
        organizationId="org_1"
        view="operations"
        onClose={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    const drawer = screen.getByRole("dialog", { name: "任务" });
    expect(screen.queryByRole("tablist", { name: "工具切换" })).not.toBeInTheDocument();
    expect(drawer).toHaveClass("utilityDrawer");
    expect(within(drawer).getByRole("heading", { name: "任务" })).toBeInTheDocument();
    await userEvent.click(await within(drawer).findByRole("button", { name: /发送通知/ }));

    expect(within(drawer).getByRole("heading", { name: "发送通知" })).toBeInTheDocument();
    expect(within(drawer).getByText("目标: notification_thread · thread_1")).toBeInTheDocument();
  });

  it("marks notification threads as read when selected from the drawer", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url.includes("/api/notifications/thread_1/read") && init?.method === "POST") {
        return jsonResponse({
          thread: notificationThread({ isRead: true, readAt: "2026-05-14T08:22:00.000Z" }),
        });
      }
      if (url.includes("/api/notifications")) {
        return jsonResponse({ threads: [notificationThread({ isRead: false })] });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <ConsoleUtilityDrawer
        organizationId="org_1"
        view="notifications"
        onClose={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    const drawer = screen.getByRole("dialog", { name: "通知" });
    const notification = await within(drawer).findByRole("button", { name: /通知已排队/ });
    expect(within(notification).getByText("未读")).toBeInTheDocument();

    await user.click(notification);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/thread_1/read",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(within(notification).getByText("已读")).toBeInTheDocument();
    expect(within(drawer).getByRole("heading", { name: "通知已排队" })).toBeInTheDocument();
  });
});

function operationItem(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-05-14T08:20:00.000Z",
    id: "op_1",
    resourceId: "thread_1",
    resourceType: "notification_thread",
    status: "queued",
    summary: "发送通知",
    targetId: "thread_1",
    targetType: "notification_thread",
    type: "notification_delivery",
    updatedAt: "2026-05-14T08:21:00.000Z",
    ...overrides,
  };
}

function notificationThread(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-05-14T08:20:00.000Z",
    dedupeKey: "operation:op_notification_delivery:queued",
    eventType: "operation_status_changed",
    firstOccurredAt: "2026-05-14T08:20:00.000Z",
    id: "thread_1",
    isRead: false,
    lastOccurredAt: "2026-05-14T08:20:00.000Z",
    latestSummary: "通知等待投递。",
    occurrenceCount: 1,
    organizationId: "org_1",
    severity: "info",
    status: "open",
    title: "通知已排队",
    updatedAt: "2026-05-14T08:20:00.000Z",
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}
