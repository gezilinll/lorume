import { describe, expect, it } from "vitest";
import fixtureSnapshot from "../../fixtures/runtime/runtime-fleet-query.sample.json";
import type { RuntimeFleetSnapshot } from "./runtime-fleet-query";
import { buildRuntimeSkillInventory, filterRuntimeSkillInventoryRows } from "./runtime-skill-inventory";
import type { RuntimeSkillSnapshot } from "./runtime-skill-probe";

const fleet = fixtureSnapshot as RuntimeFleetSnapshot;
const runtimeId = fleet.runtimes[0].id;
const mainAgentId = fleet.agents[0].id;
const pmoAgentId = `${runtimeId}:agent:pmo`;

describe("runtime Skill inventory", () => {
  it("expands runtime-scope Skills to active Agents under the Runtime", () => {
    const inventory = buildRuntimeSkillInventory({
      fleet: {
        ...fleet,
        agents: [
          ...fleet.agents,
          {
            collectionStatus: "online",
            id: pmoAgentId,
            name: "PMO",
            runtimeId,
          },
        ],
        summary: {
          ...fleet.summary,
          agentCount: fleet.summary.agentCount + 1,
        },
      },
      skillSnapshots: [skillSnapshot({
        skills: [
          {
            agentIds: [],
            available: true,
            builtIn: true,
            description: "Runtime common browser automation.",
            name: "browser",
            scope: "runtime",
          },
          {
            agentIds: [mainAgentId],
            available: true,
            builtIn: false,
            description: "Review pull requests.",
            name: "code-review",
            scope: "agent",
          },
        ],
      })],
    });

    expect(inventory.summary).toMatchObject({
      agentScopeCount: 1,
      availableCount: 2,
      builtInCount: 1,
      runtimeScopeCount: 1,
      total: 2,
    });
    expect(inventory.rows.find((row) => row.name === "browser")).toMatchObject({
      availableAgentIds: [mainAgentId, pmoAgentId],
      ownerAgentIds: [],
      runtimeId,
      scope: "runtime",
    });
    expect(inventory.rows.find((row) => row.name === "code-review")).toMatchObject({
      availableAgentIds: [mainAgentId],
      ownerAgentIds: [mainAgentId],
      runtimeId,
      scope: "agent",
    });
  });

  it("filters an Agent deep link to Runtime common Skills plus that Agent's own Skills", () => {
    const inventory = buildRuntimeSkillInventory({
      fleet,
      skillSnapshots: [skillSnapshot({
        skills: [
          {
            agentIds: [],
            available: true,
            builtIn: true,
            description: "Runtime common browser automation.",
            name: "browser",
            scope: "runtime",
          },
          {
            agentIds: [mainAgentId],
            available: true,
            builtIn: false,
            description: "Review pull requests.",
            name: "code-review",
            scope: "agent",
          },
          {
            agentIds: [`${runtimeId}:agent:other`],
            available: true,
            builtIn: false,
            description: "Other Agent only.",
            name: "other-agent-skill",
            scope: "agent",
          },
        ],
      })],
    });

    expect(filterRuntimeSkillInventoryRows(inventory.rows, {
      agentId: mainAgentId,
      runtimeId,
    }).map((row) => row.name)).toEqual(["browser", "code-review"]);
  });
});

function skillSnapshot(overrides: Partial<RuntimeSkillSnapshot>): RuntimeSkillSnapshot {
  return {
    deviceId: fleet.devices[0].id,
    runtimeId,
    runtimeKind: "openclaw",
    status: "succeeded",
    summary: {
      agentScopeCount: 0,
      availableCount: 0,
      builtInCount: 0,
      runtimeScopeCount: 0,
      total: 0,
      unavailableCount: 0,
    },
    skills: [],
    ...overrides,
  };
}
