/** Status values for read-only Runtime scheduled task probing. */
export type RuntimeScheduleProbeStatus =
  | "unknown"
  | "succeeded"
  | "unsupported"
  | "failed";

/** Minimal product-facing definition of one runtime-owned scheduled task. */
export interface RuntimeScheduleDefinition {
  key: string;
  sourceId: string;
  name: string;
  agentIds: string[];
  enabled: boolean;
  expression?: string;
  timezone?: string;
  nextRunAt?: string;
  lastRunAt?: string;
}

/** Summary derived from Runtime schedule definitions. */
export interface RuntimeScheduleSummary {
  total: number;
  enabledCount: number;
  disabledCount: number;
  agentCount: number;
}

/** Latest read-only scheduled task probe snapshot for one Runtime. */
export interface RuntimeScheduleProbeSnapshot {
  deviceId: string;
  runtimeId: string;
  runtimeKind: string;
  status: RuntimeScheduleProbeStatus;
  observedAt?: string | null;
  summary: RuntimeScheduleSummary;
  schedules: RuntimeScheduleDefinition[];
  errorSummary?: string;
}

export interface OpenClawRuntimeScheduleProbeInput {
  deviceId: string;
  runtimeId: string;
  runtimeKind?: string;
  observedAt?: string;
  agentIdByExternalId?: Map<string, string>;
  cronJobs?: unknown[];
}

export const runtimeScheduleProbeStatuses: RuntimeScheduleProbeStatus[] = [
  "unknown",
  "succeeded",
  "unsupported",
  "failed",
];

/** Validate and normalize a Runtime schedule snapshot to Lorume's minimal product contract. */
export function normalizeRuntimeScheduleProbeSnapshot(value: unknown): RuntimeScheduleProbeSnapshot | null {
  if (!isRecord(value)) return null;
  const deviceId = readString(value.deviceId);
  const runtimeId = readString(value.runtimeId);
  const runtimeKind = readString(value.runtimeKind);
  const status = readString(value.status);
  if (!deviceId || !runtimeId || !runtimeKind || !isRuntimeScheduleProbeStatus(status)) return null;
  const schedules = normalizeScheduleDefinitions(value.schedules, runtimeId);

  return {
    deviceId,
    runtimeId,
    runtimeKind,
    status,
    ...(readNullableString(value.observedAt) !== undefined ? { observedAt: readNullableString(value.observedAt) } : {}),
    summary: createRuntimeScheduleSummary(schedules),
    schedules,
    ...(readString(value.errorSummary) ? { errorSummary: readString(value.errorSummary) } : {}),
  };
}

/** Create a Runtime schedule snapshot from OpenClaw cron facts without exposing adapter internals. */
export function createOpenClawRuntimeScheduleSnapshot(input: OpenClawRuntimeScheduleProbeInput): RuntimeScheduleProbeSnapshot {
  const schedules = sortSchedules((input.cronJobs ?? [])
    .map((job) => openClawCronJobToSchedule(job, input.runtimeId, input.agentIdByExternalId ?? new Map()))
    .filter((schedule): schedule is RuntimeScheduleDefinition => Boolean(schedule)));

  return {
    deviceId: input.deviceId,
    runtimeId: input.runtimeId,
    runtimeKind: input.runtimeKind || "openclaw",
    status: schedules.length ? "succeeded" : "unsupported",
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    summary: createRuntimeScheduleSummary(schedules),
    schedules,
    ...(!schedules.length ? { errorSummary: "未发现可归一化的 OpenClaw 定时任务定义。" } : {}),
  };
}

export function makeRuntimeScheduleKey(runtimeId: string, sourceId: string): string {
  return `${runtimeId}:schedule:${sanitizeScheduleId(sourceId)}`;
}

export function isRuntimeScheduleProbeStatus(value: string): value is RuntimeScheduleProbeStatus {
  return runtimeScheduleProbeStatuses.includes(value as RuntimeScheduleProbeStatus);
}

export function createRuntimeScheduleSummary(schedules: RuntimeScheduleDefinition[]): RuntimeScheduleSummary {
  const agentIds = new Set<string>();
  for (const schedule of schedules) {
    for (const agentId of schedule.agentIds) agentIds.add(agentId);
  }
  return {
    total: schedules.length,
    enabledCount: schedules.filter((schedule) => schedule.enabled).length,
    disabledCount: schedules.filter((schedule) => !schedule.enabled).length,
    agentCount: agentIds.size,
  };
}

function normalizeScheduleDefinitions(value: unknown, runtimeId: string): RuntimeScheduleDefinition[] {
  const rows = Array.isArray(value)
    ? value.map((entry) => normalizeScheduleDefinition(entry, runtimeId)).filter((row): row is RuntimeScheduleDefinition => Boolean(row))
    : [];
  return sortSchedules(rows);
}

function normalizeScheduleDefinition(value: unknown, runtimeId: string): RuntimeScheduleDefinition | null {
  if (!isRecord(value)) return null;
  const sourceId = readString(value.sourceId) || readString(value.id);
  if (!sourceId) return null;
  const name = readString(value.name) || sourceId;
  return {
    key: makeRuntimeScheduleKey(runtimeId, sourceId),
    sourceId,
    name,
    agentIds: normalizeStringList(value.agentIds),
    enabled: value.enabled !== false,
    ...(readString(value.expression) ? { expression: readString(value.expression) } : {}),
    ...(readString(value.timezone) ? { timezone: readString(value.timezone) } : {}),
    ...(readIsoTimestamp(value.nextRunAt) ? { nextRunAt: readIsoTimestamp(value.nextRunAt) } : {}),
    ...(readIsoTimestamp(value.lastRunAt) ? { lastRunAt: readIsoTimestamp(value.lastRunAt) } : {}),
  };
}

function openClawCronJobToSchedule(
  value: unknown,
  runtimeId: string,
  agentIdByExternalId: Map<string, string>,
): RuntimeScheduleDefinition | null {
  if (!isRecord(value)) return null;
  const sourceId = readString(value.id) || readString(value.jobId) || readString(value.key) || sanitizeScheduleId(readString(value.name));
  if (!sourceId) return null;
  const schedule = isRecord(value.schedule) ? value.schedule : {};
  const state = isRecord(value.state) ? value.state : {};
  const agentExternalId = readString(value.agentId) ||
    (isRecord(value.agent) ? readString(value.agent.id) || readString(value.agent.agentId) : "") ||
    (isRecord(value.target) ? readString(value.target.agentId) || readString(value.target.id) : "");
  const agentId = agentExternalId ? agentIdByExternalId.get(agentExternalId) || "" : "";
  const nextRunAt = readIsoTimestamp(state.nextRunAt) ||
    readIsoTimestamp(value.nextRunAt) ||
    readEpochMillisAsIso(state.nextRunAtMs) ||
    readEpochMillisAsIso(value.nextRunAtMs);
  const lastRunAt = readIsoTimestamp(state.lastRunAt) ||
    readIsoTimestamp(value.lastRunAt) ||
    readEpochMillisAsIso(state.lastRunAtMs) ||
    readEpochMillisAsIso(value.lastRunAtMs);

  return {
    key: makeRuntimeScheduleKey(runtimeId, sourceId),
    sourceId,
    name: readString(value.name) || readString(value.title) || sourceId,
    agentIds: agentId ? [agentId] : [],
    enabled: value.disabled === true ? false : value.enabled !== false,
    ...(readString(schedule.expr) || readString(schedule.expression) || readString(value.cron) || readString(value.expression)
      ? { expression: readString(schedule.expr) || readString(schedule.expression) || readString(value.cron) || readString(value.expression) }
      : {}),
    ...(readString(schedule.tz) || readString(schedule.timezone) || readString(value.timezone)
      ? { timezone: readString(schedule.tz) || readString(schedule.timezone) || readString(value.timezone) }
      : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
  };
}

function sortSchedules(rows: RuntimeScheduleDefinition[]): RuntimeScheduleDefinition[] {
  return rows
    .map((row) => ({
      ...row,
      key: makeRuntimeScheduleKey(row.key.split(":schedule:")[0] || "", row.sourceId),
      agentIds: uniqueSorted(row.agentIds),
    }))
    .sort((left, right) =>
      left.name.localeCompare(right.name) ||
      left.sourceId.localeCompare(right.sourceId),
    );
}

function sanitizeScheduleId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueSorted(value.map(readString).filter(Boolean));
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return readString(value) || undefined;
}

function readIsoTimestamp(value: unknown): string {
  const text = readString(value);
  if (!text) return "";
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function readEpochMillisAsIso(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return new Date(number).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
