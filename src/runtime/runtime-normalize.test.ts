import { describe, expect, it } from "vitest";
import {
  createRuntimeInventorySnapshot,
  summarizeRuntimeInventory,
  type RuntimeAdapterReport,
  type RuntimeDevice,
} from "./runtime-normalize";

const fixtureDevice: RuntimeDevice = {
  id: "gezilinll-claw",
  hostname: "gezilinll-clawdeMacBook-Pro.local",
  os: "darwin",
  architecture: "arm64",
};

describe("runtime inventory normalization", () => {
  it("keeps device facts narrow and independent from runtime health", () => {
    const snapshot = createRuntimeInventorySnapshot({
      observedAt: "2026-05-20T00:00:00.000Z",
      collector: { version: "0.1.0", status: "online", installPath: "/tmp/lorume" },
      device: {
        id: "device-a",
        name: "Device A",
        hostname: "device-a.local",
        os: "darwin",
        architecture: "arm64",
        status: "unknown",
        lastSeenAt: "2026-05-19T00:00:00.000Z",
        user: { username: "gezilinll-claw" },
        network: { localIps: ["10.1.67.125"], publicIp: "203.0.113.10" },
      } as RuntimeDevice,
      reports: [{
        source: "codex",
        collectedAt: "2026-05-20T00:00:00.000Z",
        runtimes: [{
          externalId: "runtime-main",
          kind: "codex",
          name: "Codex CLI",
          status: "degraded",
          capabilities: [],
        }],
        agents: [],
      }],
    });

    expect(snapshot.device).toEqual({
      id: "device-a",
      hostname: "device-a.local",
      os: "darwin",
      architecture: "arm64",
      lastSeenAt: "2026-05-20T00:00:00.000Z",
      user: { username: "gezilinll-claw" },
      network: { localIps: ["10.1.67.125"], publicIp: "203.0.113.10" },
    });
    expect(snapshot.device).not.toHaveProperty("name");
    expect(snapshot.device).not.toHaveProperty("status");
    expect(snapshot.device).not.toHaveProperty("connectionMode");
  });

  it("normalizes runtime and agent reports into stable Lorume ids", () => {
    const reports: RuntimeAdapterReport[] = [
      {
        source: "openclaw",
        collectedAt: "2026-05-08T08:00:00.000Z",
        runtimes: [
          {
            externalId: "gateway-18789",
            kind: "openclaw",
            name: "OpenClaw Gateway",
            status: "online",
            version: "2026.4.27",
            capabilities: ["health", "status", "tasks"],
            lastSeenAt: "2026-05-08T08:00:03.000Z",
          },
        ],
        agents: [
          {
            externalId: "main",
            runtimeExternalId: "gateway-18789",
            name: "main",
            origin: "openclaw",
            status: "idle",
            lastSeenAt: "2026-05-08T08:00:02.000Z",
            channelBindings: [{ kind: "dingtalk", label: "DingTalk default", status: "enabled" }],
            load: { historicalSessions: 12 },
          },
        ],
      },
    ] as RuntimeAdapterReport[];

    const snapshot = createRuntimeInventorySnapshot({
      device: fixtureDevice,
      observedAt: "2026-05-08T08:00:01.000Z",
      collector: { version: "0.1.0", status: "online" },
      reports,
    });

    expect(snapshot.device).not.toHaveProperty("status");
    expect(snapshot.runtimes[0]).toMatchObject({
      id: "gezilinll-claw:openclaw:gateway-18789",
      deviceId: "gezilinll-claw",
      kind: "openclaw",
      status: "online",
      capabilities: ["health", "status", "tasks"],
      lastSeenAt: "2026-05-08T08:00:03.000Z",
    });
    expect(snapshot.agents[0]).toMatchObject({
      id: "gezilinll-claw:openclaw:gateway-18789:agent:main",
      runtimeId: "gezilinll-claw:openclaw:gateway-18789",
      origin: "openclaw",
      status: "idle",
      lastSeenAt: "2026-05-08T08:00:02.000Z",
      channelBindings: [{ kind: "dingtalk", label: "DingTalk default", status: "enabled" }],
      load: { historicalSessions: 12 },
    });
  });

  it("falls back agent lastSeenAt to the adapter collection time", () => {
    const snapshot = createRuntimeInventorySnapshot({
      device: fixtureDevice,
      observedAt: "2026-05-08T08:00:03.000Z",
      collector: { version: "0.1.0", status: "online" },
      reports: [
        {
          source: "multica",
          collectedAt: "2026-05-08T08:00:02.000Z",
          runtimes: [
            {
              externalId: "runtime-1",
              kind: "codex",
              name: "Codex Runtime",
              status: "online",
              capabilities: ["agent:list"],
            },
          ],
          agents: [
            {
              externalId: "agent-1",
              runtimeExternalId: "runtime-1",
              name: "MiBot",
              origin: "multica",
              status: "idle",
              channelBindings: [{ kind: "multica", label: "Multica", status: "enabled" }],
            },
          ],
        },
      ],
    });

    expect(snapshot.agents[0]?.lastSeenAt).toBe("2026-05-08T08:00:02.000Z");
  });

  it("keeps Slock and Multica as source kinds while preserving underlying runtime kinds", () => {
    const reports: RuntimeAdapterReport[] = [
      {
        source: "multica",
        collectedAt: "2026-05-08T08:00:00.000Z",
        runtimes: [
          {
            externalId: "07b2fc23",
            kind: "openclaw",
            name: "Openclaw (gezilinll-claw)",
            status: "online",
            capabilities: ["agent:list", "runtime:list"],
          },
        ],
        agents: [
          {
            externalId: "cmo-agent",
            runtimeExternalId: "07b2fc23",
            name: "CMO",
            origin: "multica",
            status: "idle",
            channelBindings: [{ kind: "multica", label: "Multica workspace", status: "enabled" }],
          },
        ],
      },
      {
        source: "slock",
        collectedAt: "2026-05-08T08:00:00.000Z",
        runtimes: [
          {
            externalId: "slock-daemon",
            kind: "slock",
            name: "Slock daemon",
            status: "online",
            capabilities: ["agent:start", "agent:deliver"],
          },
        ],
        agents: [
          {
            externalId: "tester",
            runtimeExternalId: "slock-daemon",
            name: "tester",
            origin: "slock",
            status: "active",
            channelBindings: [{ kind: "slock", label: "Slock", status: "enabled" }],
          },
        ],
      },
    ];

    const snapshot = createRuntimeInventorySnapshot({
      device: fixtureDevice,
      observedAt: "2026-05-08T08:00:01.000Z",
      collector: { version: "0.1.0", status: "online" },
      reports,
    });

    expect(snapshot.runtimes.map((runtime) => [runtime.kind, runtime.sourceRefs[0]?.source])).toEqual([
      ["openclaw", "multica"],
      ["slock", "slock"],
    ]);
    expect(snapshot.agents.map((agent) => [agent.name, agent.origin])).toEqual([
      ["CMO", "multica"],
      ["tester", "slock"],
    ]);
  });

  it("summarizes degraded inventory without losing individual statuses", () => {
    const snapshot = createRuntimeInventorySnapshot({
      device: fixtureDevice,
      observedAt: "2026-05-08T08:00:01.000Z",
      collector: { version: "0.1.0", status: "online" },
      reports: [
        {
          source: "openclaw",
          collectedAt: "2026-05-08T08:00:00.000Z",
          runtimes: [
            {
              externalId: "gateway-18789",
              kind: "openclaw",
              name: "OpenClaw Gateway",
              status: "degraded",
              capabilities: ["health"],
              health: { lastError: "task audit has lost tasks" },
            },
          ],
          agents: [],
        },
      ],
    });

    const summary = summarizeRuntimeInventory(snapshot);

    expect(summary).toEqual({
      runtimes: { total: 1, online: 0, degraded: 1, offline: 0, unknown: 0 },
      agents: { total: 0, active: 0, idle: 0, inactive: 0, degraded: 0, unknown: 0 },
      channelKinds: [],
    });
  });
});
