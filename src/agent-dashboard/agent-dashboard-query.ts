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

export type AgentDashboardConfidence = "high" | "medium" | "low";
export type AgentDashboardCaseStatus = "done" | "failed" | "cancelled" | "unknown";

export interface AgentDashboardAnalysis {
  schemaVersion: "agent-analysis-v1";
  promptKind: "daily_operation_review";
  summary: string;
  taskTypeBreakdown: Array<{
    confidence: AgentDashboardConfidence;
    countEstimate: number;
    evidenceTaskIds: string[];
    label: string;
    type: string;
  }>;
  typicalCases: Array<{
    evidence: string;
    outcome: string;
    status: AgentDashboardCaseStatus;
    taskId: string;
    title: string;
    whyTypical: string;
  }>;
  risks: Array<{
    description: string;
    evidenceTaskIds: string[];
    severity: AgentDashboardConfidence;
    title: string;
  }>;
  dataQualityNotes: string[];
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

const confidenceValues: AgentDashboardConfidence[] = ["high", "medium", "low"];
const caseStatuses: AgentDashboardCaseStatus[] = ["done", "failed", "cancelled", "unknown"];

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
  if (record.schemaVersion !== "agent-analysis-v1" || record.promptKind !== "daily_operation_review") return null;
  const summary = readString(record.summary);
  if (!summary) return null;
  return {
    dataQualityNotes: normalizeStringArray(record.dataQualityNotes),
    promptKind: "daily_operation_review",
    risks: normalizeRisks(record.risks),
    schemaVersion: "agent-analysis-v1",
    summary,
    taskTypeBreakdown: normalizeTaskTypeBreakdown(record.taskTypeBreakdown),
    typicalCases: normalizeTypicalCases(record.typicalCases),
  };
}

function normalizeTaskTypeBreakdown(value: unknown): AgentDashboardAnalysis["taskTypeBreakdown"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const confidence = normalizeConfidence(record?.confidence);
    if (!record || !confidence) return null;
    return {
      confidence,
      countEstimate: readNumber(record.countEstimate) ?? 0,
      evidenceTaskIds: normalizeStringArray(record.evidenceTaskIds),
      label: readString(record.label),
      type: readString(record.type),
    };
  }).filter((item): item is AgentDashboardAnalysis["taskTypeBreakdown"][number] =>
    Boolean(item && item.label && item.type)
  );
}

function normalizeTypicalCases(value: unknown): AgentDashboardAnalysis["typicalCases"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const status = normalizeCaseStatus(record?.status);
    if (!record || !status) return null;
    return {
      evidence: readString(record.evidence),
      outcome: readString(record.outcome),
      status,
      taskId: readString(record.taskId),
      title: readString(record.title),
      whyTypical: readString(record.whyTypical),
    };
  }).filter((item): item is AgentDashboardAnalysis["typicalCases"][number] =>
    Boolean(item && item.taskId && item.title)
  );
}

function normalizeRisks(value: unknown): AgentDashboardAnalysis["risks"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const severity = normalizeConfidence(record?.severity);
    if (!record || !severity) return null;
    return {
      description: readString(record.description),
      evidenceTaskIds: normalizeStringArray(record.evidenceTaskIds),
      severity,
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

function normalizeConfidence(value: unknown): AgentDashboardConfidence | null {
  return typeof value === "string" && confidenceValues.includes(value as AgentDashboardConfidence)
    ? value as AgentDashboardConfidence
    : null;
}

function normalizeCaseStatus(value: unknown): AgentDashboardCaseStatus | null {
  return typeof value === "string" && caseStatuses.includes(value as AgentDashboardCaseStatus)
    ? value as AgentDashboardCaseStatus
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
