import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtureSnapshot from "../../fixtures/runtime/runtime-fleet-query.sample.json";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RuntimeFleetPage } from "./RuntimeFleetPage";

const originalFetch = globalThis.fetch;
const invisibleAgentDescription = "该 Agent 曾被采集到，但最新全量采集中未再出现。可能已被删除、停用，或已移出当前采集范围。";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Runtime Fleet Skill warehouse entry", () => {
  it("opens Runtime and Agent Skill actions through the warehouse deep-link callback", async () => {
    const user = userEvent.setup();
    const onOpenSkillWarehouse = vi.fn();

    renderRuntimeFleetPage(onOpenSkillWarehouse);

    const runtimeTable = screen.getByRole("table", { name: "Runtime 列表" });
    const runtimeRow = within(runtimeTable).getByRole("row", { name: /OpenClaw Gateway/ });
    await user.click(within(runtimeRow).getByRole("button", { name: "查看 Skill" }));
    expect(onOpenSkillWarehouse).toHaveBeenCalledWith({
      runtimeId: "fixture-mac:runtime:openclaw",
    });

    const agentTable = screen.getByRole("table", { name: "Agent 列表" });
    const agentRow = within(agentTable).getByRole("row", { name: /main/ });
    await user.click(within(agentRow).getByRole("button", { name: "查看 Skill" }));
    expect(onOpenSkillWarehouse).toHaveBeenCalledWith({
      agentId: "fixture-mac:runtime:openclaw:agent:main",
      runtimeId: "fixture-mac:runtime:openclaw",
    });
  });

  it("activates the nested Skill button from the keyboard without row key handling intercepting it", async () => {
    const user = userEvent.setup();
    const onOpenSkillWarehouse = vi.fn();

    renderRuntimeFleetPage(onOpenSkillWarehouse);
    const agentTable = screen.getByRole("table", { name: "Agent 列表" });
    const agentRow = within(agentTable).getByRole("row", { name: /main/ });
    within(agentRow).getByRole("button", { name: "查看 Skill" }).focus();
    await user.keyboard("{Enter}");

    expect(onOpenSkillWarehouse).toHaveBeenCalledWith({
      agentId: "fixture-mac:runtime:openclaw:agent:main",
      runtimeId: "fixture-mac:runtime:openclaw",
    });
  });

  it("explains why Skill warehouse deep links are disabled for invisible Agents", async () => {
    const user = userEvent.setup();
    const snapshot = {
      ...fixtureSnapshot,
      agents: fixtureSnapshot.agents.map((agent) => ({
        ...agent,
        collectionStatus: "invisible",
      })),
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        return new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/devices/") && url.includes("/collection-health")) {
        return new Response(JSON.stringify({
          checks: [],
          deviceId: "fixture-mac",
          lastCollectedAt: fixtureSnapshot.collectedAt,
          lastReceivedAt: fixtureSnapshot.collectedAt,
          status: "healthy",
          summary: "采集正常",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/devices/") && url.includes("/diagnostics")) {
        return new Response(JSON.stringify({
          deviceId: "fixture-mac",
          label: "在线",
          lastDeviceStateSuccessAt: fixtureSnapshot.collectedAt,
          lastHeartbeatAt: fixtureSnapshot.collectedAt,
          message: "设备最近完成成功同步",
          reason: "device_state_fresh",
          status: "online",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;

    renderRuntimeFleetPage(vi.fn());

    const agentTable = await screen.findByRole("table", { name: "Agent 列表" });
    const agentRow = within(agentTable).getByRole("row", { name: /main/ });
    const skillButton = within(agentRow).getByRole("button", { name: "查看 Skill" });
    await waitFor(() => expect(skillButton).toBeDisabled());
    const tooltipTarget = skillButton.closest("[data-skill-probe-disabled='true']");
    expect(tooltipTarget).toBeTruthy();
    await user.hover(tooltipTarget as HTMLElement);

    expect(await screen.findAllByText(invisibleAgentDescription)).not.toHaveLength(0);
  });
});

describe("Runtime Fleet collector upgrade management", () => {
  it("shows collector latest version posture and starts a device upgrade task", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        return jsonResponse({
          ...fixtureSnapshot,
          devices: fixtureSnapshot.devices.map((device) => ({
            ...device,
            collector: { installPath: "/opt/lorume", version: "0.0.9" },
          })),
        });
      }
      if (url.includes("/api/device-collector/manifest.json")) {
        return jsonResponse({ schemaVersion: "collector-package-v1", version: "0.1.0" });
      }
      if (url.includes("/api/operations")) {
        return jsonResponse({ operations: [] });
      }
      if (url.includes("/api/devices/fixture-mac/collector-upgrade") && init?.method === "POST") {
        return jsonResponse({ operationId: "op_upgrade", status: "queued", targetVersion: "0.1.0" }, 202);
      }
      if (url.includes("/collection-health") || url.includes("/diagnostics")) {
        return jsonResponse({}, 404);
      }
      return jsonResponse({ error: "unexpected request", url }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderRuntimeFleetPage(vi.fn(), "org_1");

    expect(await screen.findByText("Collector 0.0.9 · 待升级")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /fixture-mac/ }));
    expect(await screen.findByText("最新版本: 0.1.0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "升级 Collector" }));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/devices/fixture-mac/collector-upgrade",
        search: "?organizationId=org_1",
      }),
      expect.objectContaining({
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
  });
});

function renderRuntimeFleetPage(
  onOpenSkillWarehouse: (filters: { runtimeId?: string; agentId?: string }) => void,
  organizationId?: string,
) {
  return render(
    <TooltipProvider delayDuration={0}>
      <RuntimeFleetPage organizationId={organizationId} onOpenSkillWarehouse={onOpenSkillWarehouse} />
    </TooltipProvider>,
  );
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
