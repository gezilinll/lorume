import {
  runtimeFleetSnapshotFromQueryResponse,
  runtimeKindLabels,
  type RuntimeFleetSnapshot,
} from "./runtime-fleet-query";
import type { Agent, Runtime } from "./runtime-model";
import {
  normalizeRuntimeSkillProbeSnapshot,
  type RuntimeSkillDisplayRow,
  type RuntimeSkillScope,
  type RuntimeSkillSnapshot,
} from "./runtime-skill-probe";

export interface RuntimeSkillInventoryAgent {
  id: string;
  name: string;
  runtimeId: string;
  collectionStatus: Agent["collectionStatus"];
}

export interface RuntimeSkillInventoryRuntime {
  id: string;
  name: string;
  kindLabel: string;
  deviceId: string;
}

export interface RuntimeSkillInventoryRow extends RuntimeSkillDisplayRow {
  id: string;
  observedAt?: string | null;
  runtimeId: string;
  runtimeName: string;
  runtimeKindLabel: string;
  deviceId: string;
  ownerAgentIds: string[];
  availableAgentIds: string[];
  ownerAgents: RuntimeSkillInventoryAgent[];
  availableAgents: RuntimeSkillInventoryAgent[];
}

export interface RuntimeSkillInventorySummary {
  total: number;
  runtimeScopeCount: number;
  agentScopeCount: number;
  availableCount: number;
  unavailableCount: number;
  builtInCount: number;
}

export interface RuntimeSkillInventory {
  rows: RuntimeSkillInventoryRow[];
  summary: RuntimeSkillInventorySummary;
  runtimes: RuntimeSkillInventoryRuntime[];
  agents: RuntimeSkillInventoryAgent[];
}

export interface RuntimeSkillInventoryFilters {
  agentId?: string;
  available?: boolean;
  builtIn?: boolean;
  runtimeId?: string;
  scope?: RuntimeSkillScope;
  search?: string;
}

export interface RuntimeSkillInventoryFetchResult {
  inventory: RuntimeSkillInventory;
  errors: string[];
}

export const runtimeSkillScopeLabels: Record<RuntimeSkillScope, string> = {
  agent: "Agent",
  runtime: "Runtime",
};

export function buildRuntimeSkillInventory({
  fleet,
  skillSnapshots,
}: {
  fleet: RuntimeFleetSnapshot;
  skillSnapshots: RuntimeSkillSnapshot[];
}): RuntimeSkillInventory {
  const runtimeById = new Map(fleet.runtimes.map((runtime) => [runtime.id, runtime]));
  const agentsByRuntimeId = groupAgentsByRuntimeId(fleet.agents);
  const agentById = new Map(fleet.agents.map((agent) => [agent.id, toInventoryAgent(agent)]));
  const rows: RuntimeSkillInventoryRow[] = [];

  for (const snapshot of skillSnapshots) {
    const runtime = runtimeById.get(snapshot.runtimeId);
    for (const skill of snapshot.skills) {
      rows.push(toInventoryRow({
        agentById,
        agentsByRuntimeId,
        runtime,
        skill,
        snapshot,
      }));
    }
  }

  const sortedRows = rows.sort((left, right) =>
    left.name.localeCompare(right.name) || left.runtimeName.localeCompare(right.runtimeName),
  );

  return {
    agents: fleet.agents.map(toInventoryAgent).sort(sortByNameThenId),
    rows: sortedRows,
    runtimes: fleet.runtimes.map(toInventoryRuntime).sort(sortByNameThenId),
    summary: summarizeRows(sortedRows),
  };
}

export function filterRuntimeSkillInventoryRows(
  rows: RuntimeSkillInventoryRow[],
  filters: RuntimeSkillInventoryFilters,
): RuntimeSkillInventoryRow[] {
  const search = normalizeSearch(filters.search);
  return rows.filter((row) => {
    if (filters.runtimeId && row.runtimeId !== filters.runtimeId) return false;
    if (filters.agentId && !row.availableAgentIds.includes(filters.agentId) && !row.ownerAgentIds.includes(filters.agentId)) {
      return false;
    }
    if (filters.scope && row.scope !== filters.scope) return false;
    if (typeof filters.available === "boolean" && row.available !== filters.available) return false;
    if (typeof filters.builtIn === "boolean" && row.builtIn !== filters.builtIn) return false;
    if (search && !rowMatchesSearch(row, search)) return false;
    return true;
  });
}

export async function fetchRuntimeSkillInventory({
  organizationId,
}: {
  organizationId?: string;
} = {}): Promise<RuntimeSkillInventoryFetchResult> {
  const fleetUrl = createApiUrl("/api/runtime-fleet", organizationId);
  const fleetResponse = await fetch(fleetUrl);
  if (!fleetResponse.ok) throw new Error("runtime fleet query failed");
  const fleet = runtimeFleetSnapshotFromQueryResponse(await fleetResponse.json());
  if (!fleet) throw new Error("runtime fleet query returned an invalid payload");

  const snapshots = await Promise.allSettled(
    fleet.runtimes.map((runtime) => fetchRuntimeSkillSnapshot(runtime.id, organizationId)),
  );
  const errors: string[] = [];
  const skillSnapshots: RuntimeSkillSnapshot[] = [];
  for (const result of snapshots) {
    if (result.status === "fulfilled") {
      skillSnapshots.push(result.value);
    } else {
      errors.push(result.reason instanceof Error ? result.reason.message : "Skill snapshot query failed");
    }
  }

  return {
    errors,
    inventory: buildRuntimeSkillInventory({ fleet, skillSnapshots }),
  };
}

function toInventoryRow({
  agentById,
  agentsByRuntimeId,
  runtime,
  skill,
  snapshot,
}: {
  agentById: ReadonlyMap<string, RuntimeSkillInventoryAgent>;
  agentsByRuntimeId: ReadonlyMap<string, RuntimeSkillInventoryAgent[]>;
  runtime?: Runtime;
  skill: RuntimeSkillDisplayRow;
  snapshot: RuntimeSkillSnapshot;
}): RuntimeSkillInventoryRow {
  const runtimeAgents = agentsByRuntimeId.get(snapshot.runtimeId) ?? [];
  const ownerAgentIds = skill.scope === "agent" ? uniqueSorted(skill.agentIds) : [];
  const availableAgentIds = skill.available
    ? skill.scope === "runtime"
      ? runtimeAgents.filter((agent) => agent.collectionStatus !== "invisible").map((agent) => agent.id)
      : ownerAgentIds.filter((agentId) => agentById.get(agentId)?.collectionStatus !== "invisible")
    : [];
  const ownerAgents = ownerAgentIds.map((agentId) => agentById.get(agentId)).filter(Boolean) as RuntimeSkillInventoryAgent[];
  const availableAgents = availableAgentIds.map((agentId) => agentById.get(agentId)).filter(Boolean) as RuntimeSkillInventoryAgent[];
  const runtimeName = runtime?.name ?? snapshot.runtimeId;
  return {
    ...skill,
    availableAgentIds: uniqueSorted(availableAgentIds),
    availableAgents: availableAgents.sort(sortByNameThenId),
    deviceId: runtime?.deviceId ?? snapshot.deviceId,
    id: `${snapshot.runtimeId}:${skill.name}`,
    observedAt: snapshot.observedAt,
    ownerAgentIds,
    ownerAgents: ownerAgents.sort(sortByNameThenId),
    runtimeId: snapshot.runtimeId,
    runtimeKindLabel: runtime ? runtimeKindLabels[runtime.kind] : snapshot.runtimeKind,
    runtimeName,
  };
}

async function fetchRuntimeSkillSnapshot(runtimeId: string, organizationId?: string): Promise<RuntimeSkillSnapshot> {
  const response = await fetch(createApiUrl(`/api/runtimes/${encodeURIComponent(runtimeId)}/skill-probe`, organizationId));
  if (!response.ok) throw new Error(`runtime Skill query failed: ${runtimeId}`);
  const snapshot = normalizeRuntimeSkillProbeSnapshot(await response.json());
  if (!snapshot) throw new Error(`runtime Skill query returned invalid payload: ${runtimeId}`);
  return snapshot;
}

function createApiUrl(pathname: string, organizationId?: string): URL {
  const requestUrl = new URL(pathname, window.location.origin);
  if (organizationId?.trim()) requestUrl.searchParams.set("organizationId", organizationId.trim());
  return requestUrl;
}

function groupAgentsByRuntimeId(agents: Agent[]): Map<string, RuntimeSkillInventoryAgent[]> {
  const grouped = new Map<string, RuntimeSkillInventoryAgent[]>();
  for (const agent of agents) {
    const list = grouped.get(agent.runtimeId) ?? [];
    list.push(toInventoryAgent(agent));
    grouped.set(agent.runtimeId, list);
  }
  for (const list of grouped.values()) {
    list.sort(sortByNameThenId);
  }
  return grouped;
}

function toInventoryRuntime(runtime: Runtime): RuntimeSkillInventoryRuntime {
  return {
    deviceId: runtime.deviceId,
    id: runtime.id,
    kindLabel: runtimeKindLabels[runtime.kind],
    name: runtime.name,
  };
}

function toInventoryAgent(agent: Agent): RuntimeSkillInventoryAgent {
  return {
    collectionStatus: agent.collectionStatus,
    id: agent.id,
    name: agent.name,
    runtimeId: agent.runtimeId,
  };
}

function summarizeRows(rows: RuntimeSkillInventoryRow[]): RuntimeSkillInventorySummary {
  return {
    agentScopeCount: rows.filter((row) => row.scope === "agent").length,
    availableCount: rows.filter((row) => row.available).length,
    builtInCount: rows.filter((row) => row.builtIn).length,
    runtimeScopeCount: rows.filter((row) => row.scope === "runtime").length,
    total: rows.length,
    unavailableCount: rows.filter((row) => !row.available).length,
  };
}

function rowMatchesSearch(row: RuntimeSkillInventoryRow, search: string): boolean {
  const haystack = [
    row.name,
    row.description,
    row.runtimeName,
    row.runtimeKindLabel,
    ...row.ownerAgents.map((agent) => agent.name),
    ...row.availableAgents.map((agent) => agent.name),
  ].join(" ").toLowerCase();
  return haystack.includes(search);
}

function normalizeSearch(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function sortByNameThenId(
  left: Pick<RuntimeSkillInventoryAgent | RuntimeSkillInventoryRuntime, "id" | "name">,
  right: Pick<RuntimeSkillInventoryAgent | RuntimeSkillInventoryRuntime, "id" | "name">,
): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
