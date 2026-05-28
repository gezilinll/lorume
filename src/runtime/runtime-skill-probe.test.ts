import { describe, expect, it } from "vitest";
import {
  createOpenClawRuntimeSkillSnapshot,
  normalizeRuntimeSkillProbeSnapshot,
} from "./runtime-skill-probe";

describe("runtime Skill probe metadata", () => {
  it("normalizes runtime-level snapshots to the minimal product contract", () => {
    const snapshot = normalizeRuntimeSkillProbeSnapshot({
      deviceId: "fixture-mac",
      runtimeId: "fixture-mac:runtime:openclaw",
      runtimeKind: "openclaw",
      status: "succeeded",
      observedAt: "2026-05-27T08:00:00.000Z",
      skills: [{
        name: "weather",
        description: "Weather lookup",
        body: "# Weather\n\nUse weather data.",
        localPath: "~/.openclaw/skills/weather/SKILL.md",
        scope: "runtime",
        available: true,
        builtIn: true,
        agentIds: ["should-not-survive"],
        active: false,
        modelVisible: false,
        sourcePath: "/private/raw/weather/SKILL.md",
      }, {
        name: "argus-cost-provider-auth-refresh",
        description: "Refresh cost provider auth",
        scope: "agent",
        available: true,
        builtIn: false,
        agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
        source: "agents-skills-project",
      }],
    });

    expect(snapshot).toMatchObject({
      deviceId: "fixture-mac",
      runtimeId: "fixture-mac:runtime:openclaw",
      runtimeKind: "openclaw",
      status: "succeeded",
      summary: {
        total: 2,
        runtimeScopeCount: 1,
        agentScopeCount: 1,
        availableCount: 2,
        unavailableCount: 0,
        builtInCount: 1,
      },
    });
    expect(snapshot?.skills).toEqual([
      {
        name: "argus-cost-provider-auth-refresh",
        description: "Refresh cost provider auth",
        scope: "agent",
        available: true,
        builtIn: false,
        agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
      },
      {
        name: "weather",
        description: "Weather lookup",
        body: "# Weather\n\nUse weather data.",
        localPath: "~/.openclaw/skills/weather/SKILL.md",
        scope: "runtime",
        available: true,
        builtIn: true,
        agentIds: [],
      },
    ]);
    expect(snapshot?.skills[0]).not.toHaveProperty("source");
    expect(snapshot?.skills[1]).not.toHaveProperty("active");
    expect(snapshot?.skills[1]).not.toHaveProperty("sourcePath");
    expect(normalizeRuntimeSkillProbeSnapshot({ status: "installed" })).toBeNull();
  });

  it("maps OpenClaw skill facts to runtime/agent scope without exposing OpenClaw internals", () => {
    const snapshot = createOpenClawRuntimeSkillSnapshot({
      deviceId: "fixture-mac",
      runtimeId: "fixture-mac:runtime:openclaw",
      observedAt: "2026-05-27T08:00:00.000Z",
      runtimeSkills: [{
        name: "clawhub",
        description: "Discover OpenClaw skills",
        body: "# ClawHub\n\nDiscover and install skills.",
        localPath: "~/.openclaw/skills/clawhub/SKILL.md",
        source: "openclaw-bundled",
        bundled: true,
        eligible: true,
        active: false,
        modelVisible: false,
        commandVisible: false,
      }, {
        name: "healthcheck",
        description: "Check runtime health",
        eligible: true,
        missing: {
          bins: [],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        },
      }, {
        name: "weather",
        description: "Weather lookup",
        source: "openclaw-bundled",
        bundled: true,
        eligible: true,
      }, {
        name: "1password",
        description: "1Password CLI integration",
        source: "openclaw-bundled",
        bundled: true,
        eligible: false,
        missing: {
          bins: ["op"],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        },
      }],
      agentSkillViews: [{
        agentId: "fixture-mac:runtime:openclaw:agent:main",
        skills: [{
          name: "argus-cost-provider-auth-refresh",
          description: "Refresh cost provider auth",
          source: "agents-skills-project",
          eligible: true,
          active: false,
        }, {
          name: "share-files",
          description: "Share local files",
          source: "openclaw-workspace",
          eligible: true,
          blockedByAgentFilter: true,
        }],
      }],
    });

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.summary).toMatchObject({
      total: 6,
      runtimeScopeCount: 4,
      agentScopeCount: 2,
      availableCount: 5,
      unavailableCount: 1,
      builtInCount: 3,
    });
    expect(snapshot.skills).toEqual([
      expect.objectContaining({ name: "1password", scope: "runtime", available: false, builtIn: true, agentIds: [] }),
      expect.objectContaining({
        name: "argus-cost-provider-auth-refresh",
        scope: "agent",
        available: true,
        builtIn: false,
        agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
      }),
      expect.objectContaining({
        name: "clawhub",
        body: "# ClawHub\n\nDiscover and install skills.",
        localPath: "~/.openclaw/skills/clawhub/SKILL.md",
        scope: "runtime",
        available: true,
        builtIn: true,
        agentIds: [],
      }),
      expect.objectContaining({ name: "healthcheck", scope: "runtime", available: true, agentIds: [] }),
      expect.objectContaining({
        name: "share-files",
        scope: "agent",
        available: true,
        builtIn: false,
        agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
      }),
      expect.objectContaining({ name: "weather", scope: "runtime", available: true, builtIn: true, agentIds: [] }),
    ]);
  });
});
