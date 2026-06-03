import type { AgentAnalysisStore } from "../agent-analysis/agent-analysis-store";
import {
  agentAnalysisPromptKind,
  agentAnalysisPromptVersion,
  buildAgentAnalysisPrompt,
  validateAgentAnalysisResult,
  type OpenClawHardMetrics,
} from "../agent-analysis/agent-analysis-model";
import type {
  AgentAnalysisProgressMessage,
  AgentAnalysisRequestMessage,
  AgentAnalysisResultMessage,
} from "../server/runtime-control-channel";
import type { OperationJobHandler, OperationJobHandlerResult } from "./job-runner";
import type { OperationJobRow, OperationStore } from "./operation-store";

export interface AgentAnalysisDispatchOptions {
  readonly agentAnalysisStore: Pick<AgentAnalysisStore, "computeOpenClawAgentMetrics">;
  readonly controlChannel: Pick<{
    sendAgentAnalysisRequest: (message: AgentAnalysisRequestMessage) => boolean;
  }, "sendAgentAnalysisRequest">;
  readonly operationStore: Pick<OperationStore, "completeExternalJob" | "updateJobPayload">;
  readonly now?: () => Date;
}

export interface AgentAnalysisResultOptions {
  readonly agentAnalysisStore: Pick<AgentAnalysisStore, "upsertReport">;
  readonly operationStore: Pick<OperationStore, "completeExternalJob" | "listJobs" | "updateJobPayload">;
  readonly now?: () => Date;
}

export interface AgentAnalysisProgressOptions {
  readonly operationStore: Pick<OperationStore, "completeExternalJob" | "listJobs" | "updateJobPayload">;
  readonly now?: () => Date;
}

export type AgentAnalysisProgressResult =
  | { readonly status: "updated" }
  | { readonly status: "completed" }
  | { readonly status: "ignored" };

export function createAgentAnalysisJobHandler(options: AgentAnalysisDispatchOptions): OperationJobHandler {
  return (job) => dispatchAgentAnalysisJob(options, job);
}

export async function dispatchAgentAnalysisJob(
  options: AgentAnalysisDispatchOptions,
  job: OperationJobRow,
): Promise<OperationJobHandlerResult> {
  const payload = requireAgentAnalysisJobPayload(job);
  const now = options.now ?? (() => new Date());
  const currentTime = now();

  if (Date.parse(payload.deadlineAt) <= currentTime.getTime()) {
    await options.operationStore.completeExternalJob({
      errorSummary: "Agent analysis deadline elapsed",
      jobId: job.id,
      now: currentTime,
      payloadPatch: {
        deadlineAt: payload.deadlineAt,
        failedAt: currentTime.toISOString(),
        message: "Agent analysis deadline elapsed",
        stage: "failed",
        status: "failed",
      },
      status: "failed",
    });
    return { status: "external_running" };
  }

  const metrics = await options.agentAnalysisStore.computeOpenClawAgentMetrics({
    agentId: payload.agentId,
    organizationId: job.organizationId,
    periodEnd: payload.periodEnd,
    periodStart: payload.periodStart,
  });
  const prompt = buildAgentAnalysisPrompt({
    agentId: payload.agentId,
    hardMetrics: metrics.hardMetrics,
    promptKind: agentAnalysisPromptKind,
    promptVersion: agentAnalysisPromptVersion,
    sampledTasks: metrics.sampledTasks,
  });
  const request: AgentAnalysisRequestMessage = {
    agentId: payload.agentId,
    deadlineAt: payload.deadlineAt,
    deviceId: payload.deviceId,
    jobId: job.id,
    nonce: payload.nonce,
    openclawAgentId: "main",
    operationId: job.operationId,
    periodEnd: payload.periodEnd,
    periodStart: payload.periodStart,
    prompt,
    promptKind: agentAnalysisPromptKind,
    promptVersion: agentAnalysisPromptVersion,
    protocolVersion: 1,
    runtimeId: payload.runtimeId,
    timeoutSeconds: payload.timeoutSeconds,
  };

  if (!options.controlChannel.sendAgentAnalysisRequest(request)) {
    throw new Error("agent analysis request was not accepted by the device socket");
  }

  await options.operationStore.updateJobPayload({
    jobId: job.id,
    now: currentTime,
    payloadPatch: {
      allowedTaskIds: metrics.sampledTasks.map((task) => task.id),
      dispatchedAt: currentTime.toISOString(),
      hardMetrics: metrics.hardMetrics,
      message: "Agent analysis request dispatched",
      promptKind: agentAnalysisPromptKind,
      promptVersion: agentAnalysisPromptVersion,
      stage: "dispatched",
      status: "running",
    },
  });
  return { status: "external_running" };
}

export async function applyAgentAnalysisProgress(
  options: AgentAnalysisProgressOptions,
  progress: AgentAnalysisProgressMessage,
): Promise<AgentAnalysisProgressResult> {
  const now = options.now ?? (() => new Date());
  const job = await readMatchingAgentAnalysisJob(options.operationStore, progress);
  if (!job) return { status: "ignored" };
  const patch = analysisProgressPayloadPatch(progress, now().toISOString());

  if (progress.status === "running") {
    await options.operationStore.updateJobPayload({
      jobId: job.id,
      now: now(),
      payloadPatch: patch,
    });
    return { status: "updated" };
  }

  await options.operationStore.completeExternalJob({
    errorSummary: progress.message ?? "Agent analysis failed",
    jobId: job.id,
    now: now(),
    payloadPatch: patch,
    status: "failed",
  });
  return { status: "completed" };
}

export async function applyAgentAnalysisResult(
  options: AgentAnalysisResultOptions,
  result: AgentAnalysisResultMessage,
): Promise<AgentAnalysisProgressResult> {
  const now = options.now ?? (() => new Date());
  const job = await readMatchingAgentAnalysisJob(options.operationStore, result);
  if (!job) return { status: "ignored" };
  const payload = requireAgentAnalysisJobPayload(job);

  if (result.status !== "succeeded") {
    await options.operationStore.completeExternalJob({
      errorSummary: result.message ?? (result.status === "unsupported" ? "Agent analysis unsupported" : "Agent analysis failed"),
      jobId: job.id,
      now: now(),
      payloadPatch: {
        ...analysisResultPayloadPatch(result, now().toISOString()),
        stage: result.status,
        status: result.status,
      },
      status: result.status,
    });
    return { status: "completed" };
  }

  const hardMetrics = readHardMetrics(job.payload);
  if (!hardMetrics) {
    await completeInvalidResult(options.operationStore, job.id, now(), "Agent analysis hard metrics missing from Job payload");
    return { status: "completed" };
  }
  const allowedTaskIds = new Set(readStringList(job.payload.allowedTaskIds));
  const validation = validateAgentAnalysisResult(result.analysis, { allowedTaskIds });
  if (!validation.ok) {
    await completeInvalidResult(options.operationStore, job.id, now(), validation.error);
    return { status: "completed" };
  }

  const report = await options.agentAnalysisStore.upsertReport({
    agentId: payload.agentId,
    analysis: validation.result,
    deviceId: payload.deviceId,
    hardMetrics,
    modelMetadata: result.modelMetadata ?? {},
    operationId: job.operationId,
    organizationId: job.organizationId,
    periodEnd: payload.periodEnd,
    periodStart: payload.periodStart,
    promptKind: agentAnalysisPromptKind,
    promptVersion: agentAnalysisPromptVersion,
    runtimeId: payload.runtimeId,
    runtimeKind: payload.runtimeKind,
  });

  await options.operationStore.completeExternalJob({
    jobId: job.id,
    now: now(),
    payloadPatch: {
      ...analysisResultPayloadPatch(result, now().toISOString()),
      reportId: report.id,
      stage: "succeeded",
      status: "succeeded",
    },
    status: "succeeded",
  });
  return { status: "completed" };
}

function requireAgentAnalysisJobPayload(job: OperationJobRow): {
  agentId: string;
  deadlineAt: string;
  deviceId: string;
  nonce: string;
  openclawAgentId: "main";
  periodEnd: string;
  periodStart: string;
  promptKind: typeof agentAnalysisPromptKind;
  runtimeId: string;
  runtimeKind: "openclaw";
  timeoutSeconds: number;
} {
  const payload = asRecord(job.payload);
  const agentId = readString(payload.agentId);
  const deadlineAt = readString(payload.deadlineAt);
  const deviceId = readString(payload.deviceId);
  const nonce = readString(payload.nonce);
  const openclawAgentId = readString(payload.openclawAgentId);
  const periodEnd = readString(payload.periodEnd);
  const periodStart = readString(payload.periodStart);
  const promptKind = readString(payload.promptKind);
  const runtimeId = readString(payload.runtimeId);
  const runtimeKind = readString(payload.runtimeKind);
  const timeoutSeconds = typeof payload.timeoutSeconds === "number" && Number.isFinite(payload.timeoutSeconds)
    ? Math.max(1, Math.min(600, Math.trunc(payload.timeoutSeconds)))
    : 120;
  if (
    !agentId ||
    !deadlineAt ||
    !deviceId ||
    !nonce ||
    openclawAgentId !== "main" ||
    !periodEnd ||
    !periodStart ||
    promptKind !== agentAnalysisPromptKind ||
    !runtimeId ||
    runtimeKind !== "openclaw"
  ) {
    throw new Error("agent analysis job payload is incomplete");
  }
  return {
    agentId,
    deadlineAt,
    deviceId,
    nonce,
    openclawAgentId: "main",
    periodEnd,
    periodStart,
    promptKind: agentAnalysisPromptKind,
    runtimeId,
    runtimeKind: "openclaw",
    timeoutSeconds,
  };
}

async function readMatchingAgentAnalysisJob(
  operationStore: Pick<OperationStore, "listJobs">,
  message: { deviceId: string; jobId: string; nonce: string; operationId: string },
): Promise<OperationJobRow | null> {
  const jobs = await operationStore.listJobs({ operationId: message.operationId, limit: 100 });
  const job = jobs.find((entry) => entry.id === message.jobId && entry.type === "agent_analysis_openclaw");
  if (!job) return null;
  if (isTerminalJobStatus(job.status)) return null;
  const payload = asRecord(job.payload);
  if (readString(payload.deviceId) !== message.deviceId) return null;
  if (readString(payload.nonce) !== message.nonce) return null;
  return job;
}

function analysisProgressPayloadPatch(progress: AgentAnalysisProgressMessage, fallbackObservedAt: string): Record<string, unknown> {
  return {
    deviceId: progress.deviceId,
    jobId: progress.jobId,
    nonce: progress.nonce,
    observedAt: progress.observedAt ?? fallbackObservedAt,
    operationId: progress.operationId,
    stage: progress.stage,
    status: progress.status,
    ...(progress.message ? { message: progress.message } : {}),
  };
}

function analysisResultPayloadPatch(result: AgentAnalysisResultMessage, fallbackObservedAt: string): Record<string, unknown> {
  return {
    deviceId: result.deviceId,
    jobId: result.jobId,
    nonce: result.nonce,
    observedAt: result.observedAt ?? fallbackObservedAt,
    operationId: result.operationId,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.runtimeRunId ? { runtimeRunId: result.runtimeRunId } : {}),
  };
}

async function completeInvalidResult(
  operationStore: Pick<OperationStore, "completeExternalJob">,
  jobId: string,
  now: Date,
  errorSummary: string,
): Promise<void> {
  await operationStore.completeExternalJob({
    errorSummary,
    jobId,
    now,
    payloadPatch: {
      failedAt: now.toISOString(),
      message: errorSummary,
      stage: "failed",
      status: "failed",
    },
    status: "failed",
  });
}

function readHardMetrics(payload: Record<string, unknown>): OpenClawHardMetrics | null {
  const hardMetrics = payload.hardMetrics;
  if (!isRecord(hardMetrics)) return null;
  const duration = asRecord(hardMetrics.duration);
  if (duration.basis !== "trajectoryElapsed") return null;
  if (!Array.isArray(duration.includedStatuses)) return null;
  return hardMetrics as unknown as OpenClawHardMetrics;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isTerminalJobStatus(status: OperationJobRow["status"]): boolean {
  return status === "succeeded" ||
    status === "failed" ||
    status === "unsupported" ||
    status === "requires_manual_step" ||
    status === "cancelled";
}
