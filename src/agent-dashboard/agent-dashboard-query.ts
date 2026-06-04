export type AgentDashboardOperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unsupported"
  | "requires_manual_step"
  | "cancelled";

export interface AgentDashboardDurationMetrics {
  basis: "trajectoryElapsed";
  includedStatuses: ["done", "failed"];
  sampleCount: number;
  avgMs?: number;
  p50Ms?: number;
  p90Ms?: number;
}

export interface AgentDashboardHardMetrics {
  duration: AgentDashboardDurationMetrics;
  failedCount: number;
  lastActiveAt?: string;
  periodEnd: string;
  periodStart: string;
  statusCounts: Record<string, number>;
  taskTypeCounts: Record<string, number>;
  totalTasks: number;
  unknownCount: number;
}

export type AgentDashboardSatisfactionLevel = "positive" | "mixed" | "negative" | "unknown";

export interface AgentDashboardAnalysis {
  periodPerformance: {
    completion: string;
    failurePattern: string;
    latency: string;
    workload: string;
  };
  taskTypes: Array<{
    cases: Array<{
      id: string;
      outcome: string;
      reason: string;
      signal: AgentDashboardSatisfactionLevel;
      title: string;
    }>;
    countEstimate: number;
    description: string;
    label: string;
    satisfaction: {
      evidenceIds: string[];
      level: AgentDashboardSatisfactionLevel;
      reason: string;
    };
  }>;
  risks: Array<{
    description: string;
    evidenceIds: string[];
    title: string;
  }>;
  actions: Array<{
    evidenceIds: string[];
    reason: string;
    title: string;
  }>;
}

export interface AgentDashboardModelMetadata {
  model?: string;
  provider?: string;
  usage?: {
    cacheRead?: number;
    input?: number;
    output?: number;
    total?: number;
  };
}

export interface AgentDashboardReport {
  agentId: string;
  analysis: AgentDashboardAnalysis;
  createdAt: string;
  deviceId: string;
  hardMetrics: AgentDashboardHardMetrics;
  id: string;
  modelMetadata: AgentDashboardModelMetadata;
  operationId: string;
  organizationId: string;
  periodEnd: string;
  periodStart: string;
  promptKind: string;
  promptVersion: string;
  runtimeId: string;
  runtimeKind: "openclaw";
}

export interface AgentDashboardOperation {
  createdAt?: string;
  errorSummary?: string | null;
  id: string;
  manualInstruction?: string | null;
  resourceId?: string | null;
  resourceType?: string | null;
  status: AgentDashboardOperationStatus;
  summary: string;
  targetId?: string | null;
  targetType?: string | null;
  type: string;
  updatedAt?: string;
}

export interface AgentDashboardOperationJob {
  createdAt?: string;
  finishedAt?: string | null;
  id: string;
  lastErrorSummary?: string | null;
  operationId?: string;
  payload: Record<string, unknown>;
  startedAt?: string | null;
  status: AgentDashboardOperationStatus;
  type: string;
  updatedAt?: string;
}

export interface AgentDashboardOperationDetail {
  jobs: AgentDashboardOperationJob[];
  operation: AgentDashboardOperation;
}

export interface AgentDashboardRunResult {
  job: AgentDashboardOperationJob;
  operation: AgentDashboardOperation;
}

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

const operationStatuses: AgentDashboardOperationStatus[] = [
  "cancelled",
  "failed",
  "queued",
  "requires_manual_step",
  "running",
  "succeeded",
  "unsupported",
];

const satisfactionLevels: AgentDashboardSatisfactionLevel[] = ["positive", "mixed", "negative", "unknown"];

export function createAgentAnalysisReportsUrl(
  origin: string,
  input: { agentId?: string; limit?: number; organizationId?: string },
): URL {
  const requestUrl = new URL("/api/agent-analysis-reports", origin);
  if (input.organizationId?.trim()) requestUrl.searchParams.set("organizationId", input.organizationId.trim());
  if (input.agentId?.trim()) requestUrl.searchParams.set("agentId", input.agentId.trim());
  if (Number.isFinite(input.limit)) requestUrl.searchParams.set("limit", String(Math.trunc(input.limit ?? 0)));
  return requestUrl;
}

export function createAgentAnalysisReportUrl(origin: string, reportId: string, organizationId?: string): URL {
  const requestUrl = new URL(`/api/agent-analysis-reports/${encodeURIComponent(reportId)}`, origin);
  if (organizationId?.trim()) requestUrl.searchParams.set("organizationId", organizationId.trim());
  return requestUrl;
}

export function createOperationDetailUrl(origin: string, operationId: string): URL {
  return new URL(`/api/operations/${encodeURIComponent(operationId)}`, origin);
}

export function normalizeAgentAnalysisReportsResponse(value: unknown): AgentDashboardReport[] {
  const record = asRecord(value);
  const reports = Array.isArray(record?.reports) ? record.reports : [];
  return reports
    .map(normalizeAgentAnalysisReport)
    .filter((report): report is AgentDashboardReport => Boolean(report));
}

export function normalizeAgentAnalysisReportResponse(value: unknown): AgentDashboardReport | null {
  return normalizeAgentAnalysisReport(asRecord(value)?.report);
}

export function normalizeAgentAnalysisRunResponse(value: unknown): AgentDashboardRunResult | null {
  const record = asRecord(value);
  const operation = normalizeOperation(record?.operation);
  const job = normalizeOperationJob(record?.job);
  return operation && job ? { job, operation } : null;
}

export function normalizeOperationDetailResponse(value: unknown): AgentDashboardOperationDetail | null {
  const record = asRecord(value);
  const operation = normalizeOperation(record?.operation);
  if (!operation) return null;
  const jobs = Array.isArray(record?.jobs)
    ? record.jobs.map(normalizeOperationJob).filter((job): job is AgentDashboardOperationJob => Boolean(job))
    : [];
  return { jobs, operation };
}

export async function createAgentAnalysisRun(
  origin: string,
  input: {
    agentId: string;
    organizationId?: string;
    periodEnd?: string;
    periodStart?: string;
  },
  fetcher: FetchLike = globalThis.fetch as FetchLike,
): Promise<AgentDashboardRunResult> {
  const requestUrl = new URL("/api/agent-analysis-runs", origin);
  if (input.organizationId?.trim()) requestUrl.searchParams.set("organizationId", input.organizationId.trim());
  const response = await fetcher(requestUrl, {
    body: JSON.stringify({
      agentId: input.agentId,
      ...(input.periodStart ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload = await readJsonObject(response);
  if (!response.ok) {
    throw new Error(errorMessageFromPayload(payload) ?? "Agent 分析任务创建失败");
  }
  const run = normalizeAgentAnalysisRunResponse(payload);
  if (!run) throw new Error("Agent 分析任务返回无效");
  return run;
}

export async function readOperationDetail(
  origin: string,
  operationId: string,
  fetcher: FetchLike = globalThis.fetch as FetchLike,
): Promise<AgentDashboardOperationDetail | null> {
  const response = await fetcher(createOperationDetailUrl(origin, operationId));
  if (!response.ok) return null;
  return normalizeOperationDetailResponse(await readJsonObject(response));
}

function normalizeAgentAnalysisReport(value: unknown): AgentDashboardReport | null {
  const record = asRecord(value);
  if (!record) return null;
  const runtimeKind = readString(record.runtimeKind);
  const analysis = normalizeAnalysis(record.analysis);
  const hardMetrics = normalizeHardMetrics(record.hardMetrics);
  const id = readString(record.id);
  if (!id || runtimeKind !== "openclaw" || !analysis || !hardMetrics) return null;
  const report: AgentDashboardReport = {
    agentId: readString(record.agentId),
    analysis,
    createdAt: readString(record.createdAt),
    deviceId: readString(record.deviceId),
    hardMetrics,
    id,
    modelMetadata: normalizeModelMetadata(record.modelMetadata),
    operationId: readString(record.operationId),
    organizationId: readString(record.organizationId),
    periodEnd: readString(record.periodEnd),
    periodStart: readString(record.periodStart),
    promptKind: readString(record.promptKind),
    promptVersion: readString(record.promptVersion),
    runtimeId: readString(record.runtimeId),
    runtimeKind: "openclaw",
  };
  if (!report.agentId || !report.deviceId || !report.runtimeId || !report.operationId) return null;
  return report;
}

function normalizeHardMetrics(value: unknown): AgentDashboardHardMetrics | null {
  const record = asRecord(value);
  const durationRecord = asRecord(record?.duration);
  if (!record || !durationRecord || durationRecord.basis !== "trajectoryElapsed") return null;
  const sampleCount = readNumber(durationRecord.sampleCount);
  const failedCount = readNumber(record.failedCount);
  const totalTasks = readNumber(record.totalTasks);
  const unknownCount = readNumber(record.unknownCount);
  if (sampleCount === undefined || failedCount === undefined || totalTasks === undefined || unknownCount === undefined) return null;
  return {
    duration: {
      basis: "trajectoryElapsed",
      includedStatuses: ["done", "failed"],
      sampleCount,
      ...(readNumber(durationRecord.avgMs) !== undefined ? { avgMs: readNumber(durationRecord.avgMs) } : {}),
      ...(readNumber(durationRecord.p50Ms) !== undefined ? { p50Ms: readNumber(durationRecord.p50Ms) } : {}),
      ...(readNumber(durationRecord.p90Ms) !== undefined ? { p90Ms: readNumber(durationRecord.p90Ms) } : {}),
    },
    failedCount,
    ...(readString(record.lastActiveAt) ? { lastActiveAt: readString(record.lastActiveAt) } : {}),
    periodEnd: readString(record.periodEnd),
    periodStart: readString(record.periodStart),
    statusCounts: normalizeNumberRecord(record.statusCounts),
    taskTypeCounts: normalizeNumberRecord(record.taskTypeCounts),
    totalTasks,
    unknownCount,
  };
}

function normalizeAnalysis(value: unknown): AgentDashboardAnalysis | null {
  const record = asRecord(value);
  if (!record) return null;
  const v2 = normalizeV2Analysis(record);
  if (v2) return v2;
  return normalizeLegacyV1Analysis(record);
}

function normalizeV2Analysis(record: Record<string, unknown>): AgentDashboardAnalysis | null {
  const periodPerformance = normalizePeriodPerformance(record.periodPerformance);
  if (!periodPerformance) return null;
  return {
    actions: normalizeActions(record.actions),
    periodPerformance,
    risks: normalizeRisks(record.risks),
    taskTypes: normalizeTaskTypes(record.taskTypes),
  };
}

function normalizeLegacyV1Analysis(record: Record<string, unknown>): AgentDashboardAnalysis | null {
  if (record.schemaVersion !== "agent-analysis-v1" || record.promptKind !== "daily_operation_review") return null;
  return {
    actions: [],
    periodPerformance: {
      completion: readString(record.summary) || "旧版报告未提供完成情况判断。",
      failurePattern: "旧版报告未提供异常模式判断。",
      latency: "旧版报告未提供耗时表现判断。",
      workload: readString(record.summary) || "旧版报告未提供工作量判断。",
    },
    risks: normalizeLegacyRisks(record.risks),
    taskTypes: normalizeLegacyTaskTypes(record.taskTypeBreakdown, record.typicalCases),
  };
}

function normalizePeriodPerformance(value: unknown): AgentDashboardAnalysis["periodPerformance"] | null {
  const record = asRecord(value);
  if (!record) return null;
  const workload = readString(record.workload);
  const completion = readString(record.completion);
  const latency = readString(record.latency);
  const failurePattern = readString(record.failurePattern);
  return workload && completion && latency && failurePattern
    ? { completion, failurePattern, latency, workload }
    : null;
}

function normalizeTaskTypes(value: unknown): AgentDashboardAnalysis["taskTypes"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    const label = readString(record.label);
    if (!label) return null;
    return {
      cases: normalizeCases(record.cases),
      countEstimate: readNumber(record.countEstimate) ?? 0,
      description: readString(record.description),
      label,
      satisfaction: normalizeSatisfaction(record.satisfaction),
    };
  }).filter((item): item is AgentDashboardAnalysis["taskTypes"][number] => Boolean(item));
}

function normalizeCases(value: unknown): AgentDashboardAnalysis["taskTypes"][number]["cases"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const signal = normalizeSatisfactionLevel(record?.signal);
    if (!record || !signal) return null;
    return {
      id: readString(record.id),
      outcome: readString(record.outcome),
      reason: readString(record.reason),
      signal,
      title: readString(record.title),
    };
  }).filter((item): item is AgentDashboardAnalysis["taskTypes"][number]["cases"][number] =>
    Boolean(item && item.id && item.title)
  );
}

function normalizeRisks(value: unknown): AgentDashboardAnalysis["risks"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    return {
      description: readString(record.description),
      evidenceIds: normalizeStringArray(record.evidenceIds),
      title: readString(record.title),
    };
  }).filter((item): item is AgentDashboardAnalysis["risks"][number] => Boolean(item && item.title));
}

function normalizeActions(value: unknown): AgentDashboardAnalysis["actions"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    return {
      evidenceIds: normalizeStringArray(record.evidenceIds),
      reason: readString(record.reason),
      title: readString(record.title),
    };
  }).filter((item): item is AgentDashboardAnalysis["actions"][number] => Boolean(item && item.title));
}

function normalizeSatisfaction(value: unknown): AgentDashboardAnalysis["taskTypes"][number]["satisfaction"] {
  const record = asRecord(value);
  return {
    evidenceIds: normalizeStringArray(record?.evidenceIds),
    level: normalizeSatisfactionLevel(record?.level) ?? "unknown",
    reason: readString(record?.reason),
  };
}

function normalizeLegacyTaskTypes(
  value: unknown,
  casesValue: unknown,
): AgentDashboardAnalysis["taskTypes"] {
  const legacyCases = normalizeLegacyCases(casesValue);
  if (!Array.isArray(value)) return [];
  const taskTypes: AgentDashboardAnalysis["taskTypes"] = [];
  for (const item of value) {
    const record = asRecord(item);
    const label = readString(record?.label);
    if (!record || !label) continue;
    const evidenceIds = normalizeStringArray(record.evidenceTaskIds);
    taskTypes.push({
      cases: legacyCases,
      countEstimate: readNumber(record.countEstimate) ?? 0,
      description: "旧版报告未提供任务类型说明。",
      label,
      satisfaction: {
        evidenceIds,
        level: "unknown",
        reason: "旧版报告未提供用户反馈判断。",
      },
    });
  }
  return taskTypes;
}

function normalizeLegacyCases(value: unknown): AgentDashboardAnalysis["taskTypes"][number]["cases"] {
  if (!Array.isArray(value)) return [];
  const cases: AgentDashboardAnalysis["taskTypes"][number]["cases"] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const legacyCase: AgentDashboardAnalysis["taskTypes"][number]["cases"][number] = {
      id: readString(record.taskId),
      outcome: readString(record.outcome),
      reason: readString(record.whyTypical),
      signal: "unknown",
      title: readString(record.title),
    };
    if (legacyCase.id && legacyCase.title) cases.push(legacyCase);
  }
  return cases;
}

function normalizeLegacyRisks(value: unknown): AgentDashboardAnalysis["risks"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    return {
      description: readString(record.description),
      evidenceIds: normalizeStringArray(record.evidenceTaskIds),
      title: readString(record.title),
    };
  }).filter((item): item is AgentDashboardAnalysis["risks"][number] => Boolean(item && item.title));
}

function normalizeModelMetadata(value: unknown): AgentDashboardModelMetadata {
  const record = asRecord(value);
  if (!record) return {};
  const usage = asRecord(record.usage);
  return {
    ...(readString(record.model) ? { model: readString(record.model) } : {}),
    ...(readString(record.provider) ? { provider: readString(record.provider) } : {}),
    ...(usage
      ? {
        usage: {
          ...(readNumber(usage.cacheRead) !== undefined ? { cacheRead: readNumber(usage.cacheRead) } : {}),
          ...(readNumber(usage.input) !== undefined ? { input: readNumber(usage.input) } : {}),
          ...(readNumber(usage.output) !== undefined ? { output: readNumber(usage.output) } : {}),
          ...(readNumber(usage.total) !== undefined ? { total: readNumber(usage.total) } : {}),
        },
      }
      : {}),
  };
}

function normalizeOperation(value: unknown): AgentDashboardOperation | null {
  const record = asRecord(value);
  const id = readString(record?.id);
  const status = normalizeOperationStatus(record?.status);
  const summary = readString(record?.summary);
  if (!id || !status || !summary) return null;
  return {
    id,
    status,
    summary,
    type: readString(record?.type),
    ...(readString(record?.createdAt) ? { createdAt: readString(record?.createdAt) } : {}),
    ...(readString(record?.updatedAt) ? { updatedAt: readString(record?.updatedAt) } : {}),
    errorSummary: nullableString(record?.errorSummary),
    manualInstruction: nullableString(record?.manualInstruction),
    resourceId: nullableString(record?.resourceId),
    resourceType: nullableString(record?.resourceType),
    targetId: nullableString(record?.targetId),
    targetType: nullableString(record?.targetType),
  };
}

function normalizeOperationJob(value: unknown): AgentDashboardOperationJob | null {
  const record = asRecord(value);
  const id = readString(record?.id);
  const status = normalizeOperationStatus(record?.status);
  if (!id || !status) return null;
  return {
    id,
    payload: asRecord(record?.payload) ?? {},
    status,
    type: readString(record?.type),
    ...(readString(record?.createdAt) ? { createdAt: readString(record?.createdAt) } : {}),
    ...(readString(record?.operationId) ? { operationId: readString(record?.operationId) } : {}),
    ...(readString(record?.updatedAt) ? { updatedAt: readString(record?.updatedAt) } : {}),
    finishedAt: nullableString(record?.finishedAt),
    lastErrorSummary: nullableString(record?.lastErrorSummary),
    startedAt: nullableString(record?.startedAt),
  };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json();
    return asRecord(payload) ?? {};
  } catch {
    return {};
  }
}

function errorMessageFromPayload(payload: Record<string, unknown>): string | null {
  return readString(payload.message) || readString(payload.error) || null;
}

function normalizeOperationStatus(value: unknown): AgentDashboardOperationStatus | null {
  return typeof value === "string" && operationStatuses.includes(value as AgentDashboardOperationStatus)
    ? value as AgentDashboardOperationStatus
    : null;
}

function normalizeSatisfactionLevel(value: unknown): AgentDashboardSatisfactionLevel | null {
  return typeof value === "string" && satisfactionLevels.includes(value as AgentDashboardSatisfactionLevel)
    ? value as AgentDashboardSatisfactionLevel
    : null;
}

function normalizeNumberRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, rawValue]) => [key, readNumber(rawValue)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
  );
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter(Boolean) : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}
