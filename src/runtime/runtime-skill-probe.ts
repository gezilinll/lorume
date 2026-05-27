/** Status values for read-only Runtime Skill probing. */
export type RuntimeSkillProbeStatus =
  | "unknown"
  | "succeeded"
  | "unsupported"
  | "failed";

/** Product-level Skill scope. Runtime adapters must map platform-specific layers into this pair. */
export type RuntimeSkillScope = "runtime" | "agent";

/** Product-facing Skill row. It intentionally excludes source paths, command names, and file contents. */
export interface RuntimeSkillDisplayRow {
  name: string;
  description: string;
  scope: RuntimeSkillScope;
  available: boolean;
  builtIn: boolean;
  agentIds: string[];
}

/** Summary derived from Runtime Skill rows. */
export interface RuntimeSkillSummary {
  total: number;
  runtimeScopeCount: number;
  agentScopeCount: number;
  availableCount: number;
  unavailableCount: number;
  builtInCount: number;
}

/** Latest read-only Skill probe snapshot for one Runtime. */
export interface RuntimeSkillSnapshot {
  deviceId: string;
  runtimeId: string;
  runtimeKind: string;
  status: RuntimeSkillProbeStatus;
  observedAt?: string | null;
  summary: RuntimeSkillSummary;
  skills: RuntimeSkillDisplayRow[];
  errorSummary?: string;
}

export interface OpenClawRuntimeSkillProbeInput {
  deviceId: string;
  runtimeId: string;
  runtimeKind?: string;
  observedAt?: string;
  runtimeSkills?: unknown[];
  agentSkillViews?: Array<{
    agentId?: string;
    skills?: unknown[];
  }>;
}

export const runtimeSkillProbeStatuses: RuntimeSkillProbeStatus[] = [
  "unknown",
  "succeeded",
  "unsupported",
  "failed",
];

const knownOpenClawRuntimeScopeSkills = new Set(["clawhub", "healthcheck", "weather"]);

/** Validate and normalize a Runtime Skill snapshot to Lorume's minimal product contract. */
export function normalizeRuntimeSkillProbeSnapshot(value: unknown): RuntimeSkillSnapshot | null {
  if (!isRecord(value)) return null;
  const deviceId = readString(value.deviceId);
  const runtimeId = readString(value.runtimeId);
  const runtimeKind = readString(value.runtimeKind);
  const status = readString(value.status);
  if (!deviceId || !runtimeId || !runtimeKind || !isRuntimeSkillProbeStatus(status)) return null;
  const skills = normalizeSkillRows(value.skills);

  return {
    deviceId,
    runtimeId,
    runtimeKind,
    status,
    ...(readNullableString(value.observedAt) !== undefined ? { observedAt: readNullableString(value.observedAt) } : {}),
    summary: createRuntimeSkillSummary(skills),
    skills,
    ...(readString(value.errorSummary) ? { errorSummary: readString(value.errorSummary) } : {}),
  };
}

/** Create a Runtime Skill snapshot from OpenClaw adapter facts without exposing OpenClaw-only fields. */
export function createOpenClawRuntimeSkillSnapshot(input: OpenClawRuntimeSkillProbeInput): RuntimeSkillSnapshot {
  const rowsByName = new Map<string, RuntimeSkillDisplayRow>();

  for (const rawSkill of input.runtimeSkills ?? []) {
    const row = openClawSkillToRow(rawSkill, undefined);
    if (row) mergeSkillRow(rowsByName, row);
  }

  for (const view of input.agentSkillViews ?? []) {
    const agentId = readString(view.agentId);
    for (const rawSkill of view.skills ?? []) {
      const row = openClawSkillToRow(rawSkill, agentId);
      if (row) mergeSkillRow(rowsByName, row);
    }
  }

  const skills = sortSkillRows(Array.from(rowsByName.values()));
  return {
    deviceId: input.deviceId,
    runtimeId: input.runtimeId,
    runtimeKind: input.runtimeKind || "openclaw",
    status: skills.length ? "succeeded" : "unsupported",
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    summary: createRuntimeSkillSummary(skills),
    skills,
    ...(!skills.length ? { errorSummary: "未发现可归一化的 OpenClaw Skill metadata。" } : {}),
  };
}

export function isRuntimeSkillProbeStatus(value: string): value is RuntimeSkillProbeStatus {
  return runtimeSkillProbeStatuses.includes(value as RuntimeSkillProbeStatus);
}

export function createRuntimeSkillSummary(skills: RuntimeSkillDisplayRow[]): RuntimeSkillSummary {
  return {
    total: skills.length,
    runtimeScopeCount: skills.filter((skill) => skill.scope === "runtime").length,
    agentScopeCount: skills.filter((skill) => skill.scope === "agent").length,
    availableCount: skills.filter((skill) => skill.available).length,
    unavailableCount: skills.filter((skill) => !skill.available).length,
    builtInCount: skills.filter((skill) => skill.builtIn).length,
  };
}

function normalizeSkillRows(value: unknown): RuntimeSkillDisplayRow[] {
  const rows = Array.isArray(value)
    ? value.map(normalizeSkillRow).filter((row): row is RuntimeSkillDisplayRow => Boolean(row))
    : [];
  return sortSkillRows(rows);
}

function normalizeSkillRow(value: unknown): RuntimeSkillDisplayRow | null {
  if (!isRecord(value)) return null;
  const name = readString(value.name);
  const scope = readString(value.scope);
  if (!name || !isRuntimeSkillScope(scope)) return null;
  const agentIds = scope === "agent" ? normalizeStringList(value.agentIds) : [];
  return {
    name,
    description: readString(value.description),
    scope,
    available: value.available === true,
    builtIn: value.builtIn === true,
    agentIds,
  };
}

function openClawSkillToRow(rawSkill: unknown, visibleAgentId: string | undefined): RuntimeSkillDisplayRow | null {
  if (!isRecord(rawSkill)) return null;
  const name = readString(rawSkill.name) || readString(rawSkill.id) || readString(rawSkill.slug);
  if (!name) return null;
  const scope = mapOpenClawSkillScope(rawSkill);
  if (!scope) return null;
  return {
    name,
    description: readString(rawSkill.description) || readString(rawSkill.summary),
    scope,
    available: isOpenClawSkillAvailable(rawSkill),
    builtIn: rawSkill.bundled === true || readString(rawSkill.source) === "openclaw-bundled",
    agentIds: scope === "agent" && visibleAgentId ? [visibleAgentId] : [],
  };
}

function mapOpenClawSkillScope(rawSkill: Record<string, unknown>): RuntimeSkillScope | null {
  const name = readString(rawSkill.name) || readString(rawSkill.id) || readString(rawSkill.slug);
  if (knownOpenClawRuntimeScopeSkills.has(name)) return "runtime";
  const source = readString(rawSkill.source);
  if (rawSkill.bundled === true || source === "openclaw-bundled" || source === "openclaw-extra") return "runtime";
  if (
    source === "openclaw-workspace" ||
    source === "agents-skills-personal" ||
    source === "agents-skills-project"
  ) return "agent";
  return null;
}

function isOpenClawSkillAvailable(rawSkill: Record<string, unknown>): boolean {
  return rawSkill.eligible === true &&
    rawSkill.disabled !== true &&
    rawSkill.blockedByAllowlist !== true &&
    missingCount(rawSkill.missing) === 0;
}

function missingCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((sum, item) => sum + missingCount(item), 0);
  }
  if (typeof value === "string") return value.trim() ? 1 : 0;
  return 0;
}

function mergeSkillRow(rowsByName: Map<string, RuntimeSkillDisplayRow>, row: RuntimeSkillDisplayRow): void {
  const existing = rowsByName.get(row.name);
  if (!existing) {
    rowsByName.set(row.name, { ...row, agentIds: uniqueSorted(row.agentIds) });
    return;
  }
  const scope = existing.scope === "runtime" || row.scope === "runtime" ? "runtime" : "agent";
  rowsByName.set(row.name, {
    name: existing.name,
    description: existing.description || row.description,
    scope,
    available: existing.available || row.available,
    builtIn: existing.builtIn || row.builtIn,
    agentIds: scope === "agent" ? uniqueSorted([...existing.agentIds, ...row.agentIds]) : [],
  });
}

function sortSkillRows(rows: RuntimeSkillDisplayRow[]): RuntimeSkillDisplayRow[] {
  return rows
    .map((row) => ({
      ...row,
      agentIds: row.scope === "agent" ? uniqueSorted(row.agentIds) : [],
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueSorted(value.map(readString).filter(Boolean));
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function isRuntimeSkillScope(value: string): value is RuntimeSkillScope {
  return value === "runtime" || value === "agent";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  const stringValue = readString(value);
  return stringValue ? stringValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
