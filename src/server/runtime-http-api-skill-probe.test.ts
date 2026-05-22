import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeControlChannel } from "./runtime-control-channel";
import { createRuntimeHttpApiHandler } from "./runtime-http-api";
import { createRuntimeDeviceStateStore } from "./runtime-device-state-store";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("runtime HTTP API agent Skill probing", () => {
  it("stores and returns read-only probe snapshots", async () => {
    const { baseUrl } = await startRuntimeApi();
    const snapshot = createProbeSnapshot({ status: "succeeded" });

    const postResponse = await postJson(`${baseUrl}/api/agent-skill-probe-snapshots`, snapshot);
    const getResponse = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(snapshot.targetAgentId)}/skill-probe`);

    expect(postResponse.status).toBe(201);
    await expect(getResponse.json()).resolves.toMatchObject({
      status: "succeeded",
      targetAgentId: snapshot.targetAgentId,
      skills: [
        expect.objectContaining({
          rootPath: "/Users/example/.codex/skills/reviewer",
          markdownFiles: [expect.objectContaining({ relativePath: "SKILL.md" })],
          nonMarkdownFiles: [expect.not.objectContaining({ content: expect.any(String) })],
        }),
      ],
    });
  });
});

async function startRuntimeApi() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "lorume-skill-probe-api-"));
  const store = createRuntimeDeviceStateStore({
    snapshotPath: path.join(dataDir, "latest.json"),
    staleAfterMs: 24 * 60 * 60 * 1000,
  });
  store.writeLatestSnapshot({
    collectedAt: "2026-05-21T10:00:00.000Z",
    device: {
      id: "fixture-mac",
      hostname: "fixture-mac.local",
      os: "darwin",
    },
    runtimes: [{
      id: "fixture-mac:runtime:openclaw",
      deviceId: "fixture-mac",
      kind: "openclaw",
      name: "OpenClaw Gateway",
      collectionStatus: "online",
    }],
    agents: [{
      id: "fixture-mac:runtime:openclaw:agent:main",
      runtimeId: "fixture-mac:runtime:openclaw",
      name: "main",
      collectionStatus: "online",
    }],
    tasks: [],
  });
  const channel = createRuntimeControlChannel({
    store,
    now: () => new Date("2026-05-18T10:00:00.000Z"),
  });
  const handler = createRuntimeHttpApiHandler({
    store,
    controlChannel: channel,
  });
  const server = createServer((request, response) => {
    void handler(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
  };
}

function createProbeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    targetAgentId: "fixture-mac:runtime:openclaw:agent:main",
    targetAgentName: "main",
    deviceId: "fixture-mac",
    runtimeId: "fixture-mac:runtime:openclaw",
    runtimeName: "OpenClaw Gateway",
    status: "succeeded",
    observedAt: "2026-05-18T10:00:00.000Z",
    skills: [{
      name: "reviewer",
      rootPath: "/Users/example/.codex/skills/reviewer",
      entryPath: "/Users/example/.codex/skills/reviewer/SKILL.md",
      markdownFiles: [{
        name: "SKILL.md",
        path: "/Users/example/.codex/skills/reviewer/SKILL.md",
        relativePath: "SKILL.md",
      }],
      nonMarkdownFiles: [{
        name: "probe.sh",
        path: "/Users/example/.codex/skills/reviewer/scripts/probe.sh",
        relativePath: "scripts/probe.sh",
        content: "not exposed",
      }],
    }],
    ...overrides,
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}
