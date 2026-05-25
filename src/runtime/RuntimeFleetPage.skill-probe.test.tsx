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
    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "main Skill 探测" }));

    expect(screen.getByText("正在读取 Skill 探测")).toBeInTheDocument();
    resolveProbe(new Response(JSON.stringify({
      targetAgentId: "fixture-mac:runtime:openclaw:agent:main",
      deviceId: "fixture-mac",
      runtimeId: "fixture-mac:runtime:openclaw",
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
    await user.click(screen.getByRole("button", { name: "main Skill 探测" }));

    const panel = await screen.findByRole("region", { name: "Skill 探测" });
    expect(within(panel).getByText("reviewer")).toBeInTheDocument();
    expect(within(panel).getByText("SKILL.md")).toBeInTheDocument();
    expect(within(panel).getByText("references/checklist.md")).toBeInTheDocument();
    expect(within(panel).getByText("scripts/probe.sh")).toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: "scripts/probe.sh" })).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Root:/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Entry:/)).not.toBeInTheDocument();
    expect(within(panel).queryByText("/Users/example/.codex/skills/reviewer")).not.toBeInTheDocument();
  });

  it("activates the nested Skill probe button from the keyboard without row key handling intercepting it", async () => {
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
    screen.getByRole("button", { name: "main Skill 探测" }).focus();
    await user.keyboard("{Enter}");

    const panel = await screen.findByRole("region", { name: "Skill 探测" });
    expect(within(panel).getByText("reviewer")).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/fixture-mac%3Aruntime%3Aopenclaw%3Aagent%3Amain/skill-probe");
  });

  it("surfaces unsupported and failed states from stored probe snapshots", async () => {
    let probeReads = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/agents/") && url.includes("/skill-probe")) {
        probeReads += 1;
        return new Response(JSON.stringify(
          probeReads === 1
            ? createProbeSnapshot("unsupported", "当前 runtime 不支持本地 Skill 探测")
            : createProbeSnapshot("failed", "Skill 探测失败"),
        ), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "backend unavailable" }), { status: 503 });
    }) as unknown as typeof fetch;

    render(<RuntimeFleetPage />);
    fireEvent.click(screen.getByRole("button", { name: "main Skill 探测" }));

    const panel = await screen.findByRole("region", { name: "Skill 探测" });
    expect(within(panel).getByText("不支持探测")).toBeInTheDocument();
    expect(within(panel).getByText("当前 runtime 不支持本地 Skill 探测")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(within(panel).getByText("探测失败")).toBeInTheDocument());
    expect(within(panel).getByText("Skill 探测失败")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "main Skill 探测" }));

    const panel = await screen.findByRole("region", { name: "Skill 探测" });
    expect(within(panel).getByText("本地后端暂不可用，请稍后重试。")).toBeInTheDocument();
    expect(within(panel).queryByText(/HTTP 502/)).not.toBeInTheDocument();
  });
});

function createProbeSnapshot(status: string, errorSummary?: string) {
  return {
    targetAgentId: "fixture-mac:runtime:openclaw:agent:main",
    targetAgentName: "main",
    deviceId: "fixture-mac",
    runtimeId: "fixture-mac:runtime:openclaw",
    runtimeName: "OpenClaw Gateway",
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
