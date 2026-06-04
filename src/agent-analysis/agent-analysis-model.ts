export const agentAnalysisPromptKind = "daily_operation_review";
export const agentAnalysisPromptVersion = "openclaw-agent-operation-analysis-v2";

export type AgentAnalysisSatisfactionLevel = "positive" | "mixed" | "negative" | "unknown";
export type AgentAnalysisCaseSignal = AgentAnalysisSatisfactionLevel;

export interface AgentAnalysisTaskRow {
  id: string;
  taskType: string;
  status: string;
  createdSourceAt?: string | null;
  updatedSourceAt?: string | null;
  userMessage?: string | null;
  agentReply?: string | null;
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
  periodPerformance: {
    workload: string;
    completion: string;
    latency: string;
    failurePattern: string;
  };
  taskTypes: Array<{
    label: string;
    countEstimate: number;
    description: string;
    satisfaction: {
      level: AgentAnalysisSatisfactionLevel;
      reason: string;
      evidenceIds: string[];
    };
    cases: Array<{
      id: string;
      title: string;
      signal: AgentAnalysisCaseSignal;
      outcome: string;
      reason: string;
    }>;
  }>;
  risks: Array<{
    title: string;
    description: string;
    evidenceIds: string[];
  }>;
  actions: Array<{
    title: string;
    reason: string;
    evidenceIds: string[];
  }>;
}

export interface AgentAnalysisOverallSatisfaction {
  level: AgentAnalysisSatisfactionLevel;
  score?: number;
}

export type AgentAnalysisValidationResult =
  | { ok: true; result: AgentAnalysisResult }
  | { error: string; ok: false };

export function computeOpenClawHardMetrics(input: {
  periodEnd: string;
  periodStart: string;
  tasks: AgentAnalysisTaskRow[];
}): { hardMetrics: OpenClawHardMetrics } {
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

  return { hardMetrics };
}

export function buildAgentAnalysisPrompt(input: {
  agentId: string;
  hardMetrics: OpenClawHardMetrics;
  promptKind: typeof agentAnalysisPromptKind;
  promptVersion: typeof agentAnalysisPromptVersion;
}): string {
  const payload = {
    agentId: input.agentId,
    hardMetrics: input.hardMetrics,
    periodEnd: input.hardMetrics.periodEnd,
    periodStart: input.hardMetrics.periodStart,
    promptKind: input.promptKind,
    promptVersion: input.promptVersion,
    outputJsonContract: {
      periodPerformance: {
        workload: "string，本周期工作量判断",
        completion: "string，本周期完成情况判断",
        latency: "string，本周期耗时表现判断",
        failurePattern: "string，本周期失败或异常模式",
      },
      taskTypes: [{
        label: "string，业务可理解的任务类型名称",
        countEstimate: "number，该类型在本周期内的大致数量",
        description: "string，该类任务在本周期内主要处理什么",
        satisfaction: {
          level: "positive|mixed|negative|unknown",
          reason: "string，基于周期内会话反馈的判断",
          evidenceIds: ["string，周期内会话、trajectory、task 或稳定历史记录 id"],
        },
        cases: [{
          id: "string，周期内会话、trajectory、task 或稳定历史记录 id",
          title: "string，案例标题",
          signal: "positive|negative|mixed|unknown",
          outcome: "string，周期内结果",
          reason: "string，为什么这个案例典型",
        }],
      }],
      risks: [{
        title: "string",
        description: "string",
        evidenceIds: ["string，周期内证据 id"],
      }],
      actions: [{
        title: "string",
        reason: "string",
        evidenceIds: ["string，周期内证据 id"],
      }],
    },
  };

  return [
    "你是一名 Agent 运行分析助手。请分析目标 Agent 在指定时间周期内的真实会话记录，输出 JSON 结果，帮助管理者理解该周期内的任务类型、用户反馈信号、典型案例、风险和改进建议。",
    `分析周期：\nperiodStart: ${input.hardMetrics.periodStart}\nperiodEnd: ${input.hardMetrics.periodEnd}`,
    "可参考的系统统计见下方 JSON 中的 hardMetrics。它只用于辅助理解整体工作量、状态和耗时，不替代会话级分析。",
    [
      "取证要求：",
      "1. 在当前运行环境中，查找目标 Agent 在分析周期内的历史会话、轨迹、运行记录或等价记录。",
      "2. 只分析 eventTime 满足 periodStart <= eventTime < periodEnd 的记录。",
      "3. 如果存在跨周期 session，只把周期内的消息、运行记录、用户反馈和 Agent 响应用作本周期证据。",
      "4. 周期外记录只能在理解上下文必需时轻量参考，不能作为本周期任务量、用户反馈、典型案例或风险证据。",
      "5. 只分析目标 Agent 自己承接的用户任务，不分析系统心跳、内部调度、安装、升级、无用户语义的后台事件。",
      "6. 以会话/session 为主要分析粒度。同一会话在周期内的多轮追问、纠正、确认、失败和继续推进，应作为连续上下文理解。",
      "7. 不要修改文件、发送消息、执行外部任务或触发任何会产生副作用的操作。只允许读取和分析历史记录。",
      "8. 如果某些会话证据不足，可以跳过，不要编造。",
    ].join("\n"),
    [
      "分析步骤：",
      "1. 找出周期内相关会话和记录片段。",
      "2. 按会话理解周期内用户目标、Agent 响应、结果状态和后续反馈。",
      "3. 归纳主要任务类型，每类任务使用业务可理解的名称。",
      "4. 对每类任务判断用户反馈倾向：positive 表示用户表达认可、感谢、确认继续推进或周期内任务顺利闭环；mixed 表示任务有推进但出现多次澄清、返工、部分失败或用户反复补充；negative 表示用户明显否定、反复指出问题、任务失败、卡住或需要重新来过；unknown 表示缺少足够用户反馈或会话上下文。",
      "5. 每类任务选择典型案例，案例必须来自周期内真实会话片段。",
      "6. 提炼风险和改进建议，建议必须有周期内会话证据支撑。",
    ].join("\n"),
    "输出要求：只输出 JSON；不要 markdown；不要输出分析过程；输出 JSON 必须符合 outputJsonContract，不要增加其他字段；evidenceIds 和 cases[].id 使用会话 id、trajectory id、task id 或你能稳定引用的历史记录 id。",
    JSON.stringify(payload, null, 2),
  ].join("\n\n");
}

export function validateAgentAnalysisText(text: string): AgentAnalysisValidationResult {
  const trimmed = text.trim();
  if (!trimmed) return { error: "agent analysis result is empty", ok: false };
  if (trimmed.startsWith("```")) return { error: "agent analysis result must be raw JSON", ok: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: "agent analysis result is not valid JSON", ok: false };
  }

  return validateAgentAnalysisResult(parsed);
}

export function validateAgentAnalysisResult(
  value: unknown,
): AgentAnalysisValidationResult {
  if (!isRecord(value)) return { error: "agent analysis result must be an object", ok: false };
  if (!hasExactKeys(value, ["actions", "periodPerformance", "risks", "taskTypes"])) {
    return { error: "agent analysis result contains unsupported top-level fields", ok: false };
  }

  const periodPerformance = normalizePeriodPerformance(value.periodPerformance);
  if (!periodPerformance) return { error: "agent analysis periodPerformance is invalid", ok: false };
  const taskTypes = normalizeTaskTypes(value.taskTypes);
  if (!taskTypes) return { error: "agent analysis taskTypes is invalid", ok: false };
  const risks = normalizeRisks(value.risks);
  if (!risks) return { error: "agent analysis risks is invalid", ok: false };
  const actions = normalizeActions(value.actions);
  if (!actions) return { error: "agent analysis actions is invalid", ok: false };

  return {
    ok: true,
    result: {
      actions,
      periodPerformance,
      risks,
      taskTypes,
    },
  };
}

export function deriveOverallSatisfaction(
  taskTypes: Array<{ countEstimate: number; satisfaction: { level: AgentAnalysisSatisfactionLevel } }>,
): AgentAnalysisOverallSatisfaction {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const taskType of taskTypes) {
    const score = satisfactionScore(taskType.satisfaction.level);
    if (score === null) continue;
    const weight = Math.max(0, Math.round(taskType.countEstimate));
    if (weight <= 0) continue;
    weightedScore += score * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return { level: "unknown" };
  const score = Math.round(weightedScore / totalWeight * 100) / 100;
  if (score >= 0.67) return { level: "positive", score };
  if (score <= 0.2) return { level: "negative", score };
  return { level: "mixed", score };
}

function normalizePeriodPerformance(input: unknown): AgentAnalysisResult["periodPerformance"] | null {
  if (!isRecord(input)) return null;
  if (!hasExactKeys(input, ["completion", "failurePattern", "latency", "workload"])) return null;
  const workload = readLimitedString(input.workload, 1_000);
  const completion = readLimitedString(input.completion, 1_000);
  const latency = readLimitedString(input.latency, 1_000);
  const failurePattern = readLimitedString(input.failurePattern, 1_000);
  if (!workload || !completion || !latency || !failurePattern) return null;
  return { completion, failurePattern, latency, workload };
}

function normalizeTaskTypes(input: unknown): AgentAnalysisResult["taskTypes"] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const items: AgentAnalysisResult["taskTypes"] = [];
  for (const item of input) {
    if (!isRecord(item)) return null;
    if (!hasExactKeys(item, ["cases", "countEstimate", "description", "label", "satisfaction"])) return null;
    const label = readLimitedString(item.label, 120);
    const countEstimate = typeof item.countEstimate === "number" && Number.isFinite(item.countEstimate)
      ? Math.max(0, Math.round(item.countEstimate))
      : null;
    const description = readLimitedString(item.description, 1_000);
    const satisfaction = normalizeTaskTypeSatisfaction(item.satisfaction);
    const cases = normalizeCases(item.cases);
    if (!label || countEstimate === null || !description || !satisfaction || !cases) return null;
    items.push({ cases, countEstimate, description, label, satisfaction });
  }
  return items;
}

function normalizeTaskTypeSatisfaction(input: unknown): AgentAnalysisResult["taskTypes"][number]["satisfaction"] | null {
  if (!isRecord(input)) return null;
  if (!hasExactKeys(input, ["evidenceIds", "level", "reason"])) return null;
  const level = normalizeSatisfactionLevel(input.level);
  const reason = readLimitedString(input.reason, 1_500);
  const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
  if (!level || !reason || !evidenceIds) return null;
  return { evidenceIds, level, reason };
}

function normalizeCases(input: unknown): AgentAnalysisResult["taskTypes"][number]["cases"] | null {
  if (!Array.isArray(input) || input.length > 10) return null;
  const items: AgentAnalysisResult["taskTypes"][number]["cases"] = [];
  for (const item of input) {
    if (!isRecord(item)) return null;
    if (!hasExactKeys(item, ["id", "outcome", "reason", "signal", "title"])) return null;
    const id = readLimitedString(item.id, 300);
    const title = readLimitedString(item.title, 200);
    const signal = normalizeSatisfactionLevel(item.signal);
    const outcome = readLimitedString(item.outcome, 1_000);
    const reason = readLimitedString(item.reason, 1_000);
    if (!id || !title || !signal || !outcome || !reason) return null;
    items.push({ id, outcome, reason, signal, title });
  }
  return items;
}

function normalizeRisks(input: unknown): AgentAnalysisResult["risks"] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const items: AgentAnalysisResult["risks"] = [];
  for (const item of input) {
    if (!isRecord(item)) return null;
    if (!hasExactKeys(item, ["description", "evidenceIds", "title"])) return null;
    const title = readLimitedString(item.title, 200);
    const description = readLimitedString(item.description, 1_500);
    const evidenceIds = normalizeEvidenceIds(item.evidenceIds);
    if (!title || !description || !evidenceIds) return null;
    items.push({ description, evidenceIds, title });
  }
  return items;
}

function normalizeActions(input: unknown): AgentAnalysisResult["actions"] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const items: AgentAnalysisResult["actions"] = [];
  for (const item of input) {
    if (!isRecord(item)) return null;
    if (!hasExactKeys(item, ["evidenceIds", "reason", "title"])) return null;
    const title = readLimitedString(item.title, 200);
    const reason = readLimitedString(item.reason, 1_500);
    const evidenceIds = normalizeEvidenceIds(item.evidenceIds);
    if (!title || !reason || !evidenceIds) return null;
    items.push({ evidenceIds, reason, title });
  }
  return items;
}

function normalizeStringArray(input: unknown, maxItems: number, maxLength: number, minItems = 0): string[] | null {
  if (!Array.isArray(input) || input.length > maxItems) return null;
  const values: string[] = [];
  for (const item of input) {
    const value = readLimitedString(item, maxLength);
    if (!value) return null;
    values.push(value);
  }
  if (values.length < minItems) return null;
  return values;
}

function normalizeEvidenceIds(input: unknown): string[] | null {
  const values = normalizeStringArray(input, 20, 300, 1);
  return values ? [...new Set(values)] : null;
}

function normalizeSatisfactionLevel(value: unknown): AgentAnalysisSatisfactionLevel | null {
  return value === "positive" || value === "mixed" || value === "negative" || value === "unknown" ? value : null;
}

function satisfactionScore(value: AgentAnalysisSatisfactionLevel): number | null {
  if (value === "positive") return 1;
  if (value === "mixed") return 0.5;
  if (value === "negative") return 0;
  return null;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function readLimitedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
