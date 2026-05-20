import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeFleetPage } from "./RuntimeFleetPage";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Runtime Fleet Agent Skill probe panel", () => {
  it("shows a loading state and then an empty state when no probe exists", async () => {
    const user = userEvent.setup();
    let resolveProbe: (response: Response) => void = () => undefined;
    const probePromise = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/agents/") && url.includes("/skill-probe")) return probePromise;
      return new Response(JSON.stringify({ error: "backend unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;

    render(<RuntimeFleetPage />);
    await user.click(screen.getByRole("button", { name: "tester Skill 探测" }));

    expect(screen.getByText("正在读取 Skill 探测")).toBeInTheDocument();
    resolveProbe(new Response(JSON.stringify({
      targetAgentId: "fixture-mac:slock:slock-daemon:agent:tester",
      deviceId: "fixture-mac",
      runtimeId: "fixture-mac:slock:slock-daemon",
      status: "unknown",
      observedAt: null,
      skills: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await screen.findByText("尚未探测 Skill")).toBeInTheDocument();
  });

  it("shows Markdown and non-Markdown file metadata without file links", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/agents/") && url.includes("/skill-probe")) {
        return new Response(JSON.stringify(createProbeSnapshot("succeeded")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "backend unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;

    render(<RuntimeFleetPage />);
    await user.click(screen.getByRole("button", { name: "tester Skill 探测" }));

    const panel = await screen.findByRole("region", { name: "Skill 探测" });
    expect(within(panel).getByText("reviewer")).toBeInTheDocument();
    expect(within(panel).getByText("SKILL.md")).toBeInTheDocument();
    expect(within(panel).getByText("references/checklist.md")).toBeInTheDocument();
    expect(within(panel).getByText("scripts/probe.sh")).toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: "scripts/probe.sh" })).not.toBeInTheDocument();
  });

  it("surfaces unsupported, failed, and disconnected states from the probe API", async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url.includes("/api/agents/") && url.includes("/skill-probe") && init?.method === "POST") {
        return new Response(JSON.stringify({
          error: "device_not_connected",
          snapshot: createProbeSnapshot("device_disconnected"),
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/agents/") && url.includes("/skill-probe")) {
        return new Response(JSON.stringify(createProbeSnapshot("unsupported", "当前 runtime 不支持本地 Skill 探测")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "backend unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;

    render(<RuntimeFleetPage />);
    fireEvent.click(screen.getByRole("button", { name: "tester Skill 探测" }));

    const panel = await screen.findByRole("region", { name: "Skill 探测" });
    expect(within(panel).getByText("不支持探测")).toBeInTheDocument();
    expect(within(panel).getByText("当前 runtime 不支持本地 Skill 探测")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "请求探测" }));
    await waitFor(() => expect(within(panel).getByText("设备控制通道未连接")).toBeInTheDocument());
  });

  it("maps backend transport failures to readable messages", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/agents/") && url.includes("/skill-probe")) {
        return new Response(JSON.stringify({ error: "bad_gateway" }), { status: 502 });
      }
      return new Response(JSON.stringify({ error: "backend unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;

    render(<RuntimeFleetPage />);
    fireEvent.click(screen.getByRole("button", { name: "tester Skill 探测" }));

    const panel = await screen.findByRole("region", { name: "Skill 探测" });
    expect(within(panel).getByText("本地后端暂不可用，请稍后重试。")).toBeInTheDocument();
    expect(within(panel).queryByText(/HTTP 502/)).not.toBeInTheDocument();
  });
});

function createProbeSnapshot(status: string, errorSummary?: string) {
  return {
    targetAgentId: "fixture-mac:slock:slock-daemon:agent:tester",
    targetAgentName: "tester",
    deviceId: "fixture-mac",
    runtimeId: "fixture-mac:slock:slock-daemon",
    runtimeName: "Slock daemon",
    status,
    observedAt: "2026-05-18T10:00:00.000Z",
    errorSummary,
    skills: status === "succeeded" ? [{
      name: "reviewer",
      rootPath: "/Users/example/.codex/skills/reviewer",
      entryPath: "/Users/example/.codex/skills/reviewer/SKILL.md",
      markdownFiles: [
        { name: "SKILL.md", path: "/Users/example/.codex/skills/reviewer/SKILL.md", relativePath: "SKILL.md" },
        {
          name: "checklist.md",
          path: "/Users/example/.codex/skills/reviewer/references/checklist.md",
          relativePath: "references/checklist.md",
        },
      ],
      nonMarkdownFiles: [
        {
          name: "probe.sh",
          path: "/Users/example/.codex/skills/reviewer/scripts/probe.sh",
          relativePath: "scripts/probe.sh",
        },
      ],
    }] : [],
  };
}
