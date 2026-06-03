export const agentAnalysisSchemaVersion = "agent-analysis-v1";
export const agentAnalysisPromptKind = "daily_operation_review";
export const agentAnalysisPromptVersion = "openclaw-agent-analysis-v1";

export type AgentAnalysisConfidence = "high" | "medium" | "low";
export type AgentAnalysisCaseStatus = "done" | "failed" | "cancelled" | "unknown";

export interface AgentAnalysisTaskRow {
  id: string;
  taskType: string;
  status: string;
  createdSourceAt?: string | null;
  updatedSourceAt?: string | null;
  userMessage?: string | null;
  agentReply?: string | null;
}

export interface AgentAnalysisTaskSample {
  id: string;
  status: string;
  taskType: string;
  updatedSourceAt?: string;
  userMessage?: string;
  agentReply?: string;
}

export interface OpenClawHardMetrics {
  duration: {
    basis: "trajectoryElapsed";
    includedStatuses: ["done", "failed"];
    sampleCount: number;
    avgMs?: number;
    p50Ms?: number;
    p90Ms?: number;
  };
  failedCount: number;
  lastActiveAt?: string;
  periodEnd: string;
  periodStart: string;
  statusCounts: Record<string, number>;
  taskTypeCounts: Record<string, number>;
  totalTasks: number;
  unknownCount: number;
}

export interface AgentAnalysisResult {
  schemaVersion: typeof agentAnalysisSchemaVersion;
  promptKind: typeof agentAnalysisPromptKind;
  summary: string;
  taskTypeBreakdown: Array<{
    type: string;
    label: string;
    countEstimate: number;
    confidence: AgentAnalysisConfidence;
    evidenceTaskIds: string[];
  }>;
  typicalCases: Array<{
    taskId: string;
    title: string;
    whyTypical: string;
    outcome: string;
    status: AgentAnalysisCaseStatus;
    evidence: string;
  }>;
  risks: Array<{
    title: string;
    severity: AgentAnalysisConfidence;
    evidenceTaskIds: string[];
    description: string;
  }>;
  dataQualityNotes: string[];
}

export type AgentAnalysisValidationResult =
  | { ok: true; result: AgentAnalysisResult }
  | { error: string; ok: false };

export function computeOpenClawHardMetrics(input: {
  periodEnd: string;
  periodStart: string;
  tasks: AgentAnalysisTaskRow[];
}): { hardMetrics: OpenClawHardMetrics; sampledTasks: AgentAnalysisTaskSample[] } {
  const statusCounts: Record<string, number> = { total: input.tasks.length };
  const taskTypeCounts: Record<string, number> = {};
  const durations: number[] = [];
  let lastActiveAt: string | undefined;

  for (const task of input.tasks) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
    taskTypeCounts[task.taskType] = (taskTypeCounts[task.taskType] ?? 0) + 1;
    if (task.updatedSourceAt && (!lastActiveAt || Date.parse(task.updatedSourceAt) > Date.parse(lastActiveAt))) {
      lastActiveAt = task.updatedSourceAt;
    }
    if (task.status === "done" || task.status === "failed") {
      const durationMs = elapsedMs(task.createdSourceAt, task.updatedSourceAt);
      if (durationMs !== null) durations.push(durationMs);
    }
  }

  const sortedDurations = [...durations].sort((left, right) => left - right);
  const hardMetrics: OpenClawHardMetrics = {
    duration: {
      basis: "trajectoryElapsed",
      includedStatuses: ["done", "failed"],
      sampleCount: sortedDurations.length,
      ...(sortedDurations.length > 0
        ? {
          avgMs: Math.round(sortedDurations.reduce((sum, value) => sum + value, 0) / sortedDurations.length),
          p50Ms: percentile(sortedDurations, 0.5),
          p90Ms: percentile(sortedDurations, 0.9),
        }
        : {}),
    },
    failedCount: statusCounts.failed ?? 0,
    ...(lastActiveAt ? { lastActiveAt } : {}),
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    statusCounts,
    taskTypeCounts,
    totalTasks: input.tasks.length,
    unknownCount: statusCounts.unknown ?? 0,
  };

  return {
    hardMetrics,
    sampledTasks: input.tasks
      .slice()
      .sort(compareTasksForSample)
      .slice(0, 20)
      .map((task) => ({
        id: task.id,
        status: task.status,
        taskType: task.taskType,
        ...(task.updatedSourceAt ? { updatedSourceAt: task.updatedSourceAt } : {}),
        ...(task.userMessage ? { userMessage: truncateText(task.userMessage, 500) } : {}),
        ...(task.agentReply ? { agentReply: truncateText(task.agentReply, 500) } : {}),
      })),
  };
}

export function buildAgentAnalysisPrompt(input: {
  agentId: string;
  hardMetrics: OpenClawHardMetrics;
  promptKind: typeof agentAnalysisPromptKind;
  promptVersion: typeof agentAnalysisPromptVersion;
  sampledTasks: AgentAnalysisTaskSample[];
}): string {
  const payload = {
    agentId: input.agentId,
    hardMetrics: input.hardMetrics,
    promptKind: input.promptKind,
    promptVersion: input.promptVersion,
    sampledTasks: input.sampledTasks,
    outputSchema: {
      schemaVersion: agentAnalysisSchemaVersion,
      promptKind: agentAnalysisPromptKind,
      summary: "string",
      taskTypeBreakdown: [{
        type: "string",
        label: "string",
        countEstimate: 0,
        confidence: "high|medium|low",
        evidenceTaskIds: ["sample-task-id"],
      }],
      typicalCases: [{
        taskId: "sample-task-id",
        title: "string",
        whyTypical: "string",
        outcome: "string",
        status: "done|failed|cancelled|unknown",
        evidence: "string",
      }],
      risks: [{
        title: "string",
        severity: "high|medium|low",
        evidenceTaskIds: ["sample-task-id"],
        description: "string",
      }],
      dataQualityNotes: ["string"],
    },
  };

  return [
    "You are reviewing one OpenClaw Agent daily operation period for Lorume.",
    "Return raw JSON only. Do not wrap the response in markdown or add prose outside JSON.",
    "Do not infer user approval, user happiness, ratings, NPS, or any equivalent subjective score.",
    "Do not send, deliver, modify, schedule, or execute any external task. Only analyze the provided data.",
    "Classify task types, select typical cases from sampledTasks only, identify risks, and explain data quality gaps.",
    "All evidence task ids must come from sampledTasks.",
    JSON.stringify(payload, null, 2),
  ].join("\n\n");
}

export function validateAgentAnalysisText(
  text: string,
  options: { allowedTaskIds: Set<string> },
): AgentAnalysisValidationResult {
  const trimmed = text.trim();
  if (!trimmed) return { error: "agent analysis result is empty", ok: false };
  if (trimmed.startsWith("```")) return { error: "agent analysis result must be raw JSON", ok: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: "agent analysis result is not valid JSON", ok: false };
  }

  return validateAgentAnalysisResult(parsed, options);
}

export function validateAgentAnalysisResult(
  value: unknown,
  options: { allowedTaskIds: Set<string> },
): AgentAnalysisValidationResult {
  if (!isRecord(value)) return { error: "agent analysis result must be an object", ok: false };
  if (containsForbiddenSatisfactionField(value)) {
    return { error: "agent analysis result contains unsupported satisfaction fields", ok: false };
  }
  if (value.schemaVersion !== agentAnalysisSchemaVersion) return { error: "agent analysis schemaVersion mismatch", ok: false };
  if (value.promptKind !== agentAnalysisPromptKind) return { error: "agent analysis promptKind mismatch", ok: false };

  const summary = readLimitedString(value.summary, 2_000);
  if (!summary) return { error: "agent analysis summary is required", ok: false };
  const taskTypeBreakdown = normalizeTaskTypeBreakdown(value.taskTypeBreakdown, options.allowedTaskIds);
  if (!taskTypeBreakdown) return { error: "agent analysis taskTypeBreakdown is invalid", ok: false };
  const typicalCases = normalizeTypicalCases(value.typicalCases, options.allowedTaskIds);
  if (!typicalCases) return { error: "agent analysis typicalCases is invalid", ok: false };
  const risks = normalizeRisks(value.risks, options.allowedTaskIds);
  if (!risks) return { error: "agent analysis risks is invalid", ok: false };
  const dataQualityNotes = normalizeStringArray(value.dataQualityNotes, 20, 1_000);
  if (!dataQualityNotes) return { error: "agent analysis dataQualityNotes is invalid", ok: false };

  return {
    ok: true,
    result: {
      dataQualityNotes,
      promptKind: agentAnalysisPromptKind,
      risks,
      schemaVersion: agentAnalysisSchemaVersion,
      summary,
      taskTypeBreakdown,
      typicalCases,
    },
  };
}

function normalizeTaskTypeBreakdown(
  input: unknown,
  allowedTaskIds: Set<string>,
): AgentAnalysisResult["taskTypeBreakdown"] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const items: AgentAnalysisResult["taskTypeBreakdown"] = [];
  for (const item of input) {
    if (!isRecord(item)) return null;
    const type = readLimitedString(item.type, 80);
    const label = readLimitedString(item.label, 120);
    const countEstimate = typeof item.countEstimate === "number" && Number.isFinite(item.countEstimate)
      ? Math.max(0, Math.round(item.countEstimate))
      : null;
    const confidence = normalizeConfidence(item.confidence);
    const evidenceTaskIds = normalizeTaskIds(item.evidenceTaskIds, allowedTaskIds);
    if (!type || !label || countEstimate === null || !confidence || !evidenceTaskIds) return null;
    items.push({ confidence, countEstimate, evidenceTaskIds, label, type });
  }
  return items;
}

function normalizeTypicalCases(
  input: unknown,
  allowedTaskIds: Set<string>,
): AgentAnalysisResult["typicalCases"] | null {
  if (!Array.isArray(input) || input.length > 10) return null;
  const items: AgentAnalysisResult["typicalCases"] = [];
  for (const item of input) {
    if (!isRecord(item)) return null;
    const taskId = readLimitedString(item.taskId, 300);
    if (!taskId || !allowedTaskIds.has(taskId)) return null;
    const title = readLimitedString(item.title, 200);
    const whyTypical = readLimitedString(item.whyTypical, 1_000);
    const outcome = readLimitedString(item.outcome, 1_000);
    const status = normalizeCaseStatus(item.status);
    const evidence = readLimitedString(item.evidence, 1_000);
    if (!title || !whyTypical || !outcome || !status || !evidence) return null;
    items.push({ evidence, outcome, status, taskId, title, whyTypical });
  }
  return items;
}

function normalizeRisks(input: unknown, allowedTaskIds: Set<string>): AgentAnalysisResult["risks"] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const items: AgentAnalysisResult["risks"] = [];
  for (const item of input) {
    if (!isRecord(item)) return null;
    const title = readLimitedString(item.title, 200);
    const severity = normalizeConfidence(item.severity);
    const evidenceTaskIds = normalizeTaskIds(item.evidenceTaskIds, allowedTaskIds);
    const description = readLimitedString(item.description, 1_500);
    if (!title || !severity || !evidenceTaskIds || !description) return null;
    items.push({ description, evidenceTaskIds, severity, title });
  }
  return items;
}

function normalizeStringArray(input: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(input) || input.length > maxItems) return null;
  const values: string[] = [];
  for (const item of input) {
    const value = readLimitedString(item, maxLength);
    if (!value) return null;
    values.push(value);
  }
  return values;
}

function normalizeTaskIds(input: unknown, allowedTaskIds: Set<string>): string[] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const values: string[] = [];
  for (const item of input) {
    const taskId = readLimitedString(item, 300);
    if (!taskId || !allowedTaskIds.has(taskId)) return null;
    values.push(taskId);
  }
  return [...new Set(values)];
}

function normalizeConfidence(value: unknown): AgentAnalysisConfidence | null {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

function normalizeCaseStatus(value: unknown): AgentAnalysisCaseStatus | null {
  return value === "done" || value === "failed" || value === "cancelled" || value === "unknown" ? value : null;
}

function containsForbiddenSatisfactionField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenSatisfactionField(entry));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
    return normalizedKey.includes("satisfaction") || containsForbiddenSatisfactionField(entry);
  });
}

function readLimitedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}...`;
}

function elapsedMs(start: string | null | undefined, end: string | null | undefined): number | null {
  const startTime = Date.parse(start ?? "");
  const endTime = Date.parse(end ?? "");
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return null;
  return endTime - startTime;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(percentileValue * sortedValues.length) - 1));
  return sortedValues[index] ?? 0;
}

function compareTasksForSample(left: AgentAnalysisTaskRow, right: AgentAnalysisTaskRow): number {
  const statusOrder = statusSampleRank(left.status) - statusSampleRank(right.status);
  if (statusOrder !== 0) return statusOrder;
  const leftTime = Date.parse(left.updatedSourceAt ?? "");
  const rightTime = Date.parse(right.updatedSourceAt ?? "");
  const timeOrder = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  if (timeOrder !== 0) return timeOrder;
  return left.id.localeCompare(right.id);
}

function statusSampleRank(status: string): number {
  if (status === "failed") return 0;
  if (status === "done") return 1;
  if (status === "cancelled") return 2;
  if (status === "unknown") return 3;
  return 4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
