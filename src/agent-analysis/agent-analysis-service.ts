import { randomUUID } from "node:crypto";
import type { OperationJobRow, OperationRow, OperationStore } from "../operations/operation-store";
import {
  agentAnalysisPromptKind,
  agentAnalysisPromptVersion,
} from "./agent-analysis-model";
import type { AgentAnalysisStore, AgentAnalysisTarget } from "./agent-analysis-store";

export const defaultAgentAnalysisTimeoutSeconds = 600;

export interface AgentAnalysisRunInput {
  agentId: string;
  organizationId: string;
  periodEnd?: string;
  periodStart?: string;
  requestedByUserId?: string | null;
}

export type AgentAnalysisRunResult =
  | { job: OperationJobRow; operation: OperationRow; status: "created" }
  | { reason: "invalid_period" | "unsupported"; status: "rejected" };

export interface AgentAnalysisRunServiceOptions {
  agentAnalysisStore: Pick<AgentAnalysisStore, "readOpenClawAgentTarget">;
  operationStore: Pick<OperationStore, "createOperation" | "enqueueJob">;
  now?: () => Date;
}

export async function createAgentAnalysisRun(
  options: AgentAnalysisRunServiceOptions,
  input: AgentAnalysisRunInput,
): Promise<AgentAnalysisRunResult> {
  const now = options.now ?? (() => new Date());
  const period = resolveAgentAnalysisPeriod({
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
  }, now());
  if (!period) return { reason: "invalid_period", status: "rejected" };
  const target = await options.agentAnalysisStore.readOpenClawAgentTarget({
    agentId: input.agentId,
    organizationId: input.organizationId,
  });
  if (!target) return { reason: "unsupported", status: "rejected" };
  return createAgentAnalysisRunForTarget({
    now,
    operationStore: options.operationStore,
  }, {
    organizationId: input.organizationId,
    periodEnd: period.periodEnd,
    periodStart: period.periodStart,
    requestedByUserId: input.requestedByUserId,
    target,
  });
}

export async function createAgentAnalysisRunForTarget(
  options: {
    operationStore: Pick<OperationStore, "createOperation" | "enqueueJob">;
    now?: () => Date;
  },
  input: {
    organizationId: string;
    periodEnd: string;
    periodStart: string;
    requestedByUserId?: string | null;
    target: AgentAnalysisTarget;
  },
): Promise<{ job: OperationJobRow; operation: OperationRow; status: "created" }> {
  const now = options.now ?? (() => new Date());
  const operation = await options.operationStore.createOperation({
    organizationId: input.organizationId,
    requestedByUserId: input.requestedByUserId ?? null,
    resourceId: input.target.agentId,
    resourceType: "agent",
    summary: "Analyze OpenClaw Agent daily operation",
    targetId: input.target.deviceId,
    targetType: "device",
    type: "agent_analysis",
    metadata: {
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
      promptKind: agentAnalysisPromptKind,
      promptVersion: agentAnalysisPromptVersion,
      runtimeKind: "openclaw",
    },
  });
  const timeoutSeconds = defaultAgentAnalysisTimeoutSeconds;
  const job = await options.operationStore.enqueueJob({
    operationId: operation.id,
    organizationId: input.organizationId,
    payload: {
      agentId: input.target.agentId,
      deadlineAt: new Date(now().getTime() + (timeoutSeconds + 60) * 1000).toISOString(),
      deviceId: input.target.deviceId,
      nonce: randomUUID(),
      openclawAgentId: input.target.openclawAgentId,
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
      promptKind: agentAnalysisPromptKind,
      promptVersion: agentAnalysisPromptVersion,
      runtimeId: input.target.runtimeId,
      runtimeKind: input.target.runtimeKind,
      stage: "queued",
      status: "queued",
      timeoutSeconds,
    },
    type: "agent_analysis_openclaw",
  });
  return { job, operation, status: "created" };
}

export function resolveAgentAnalysisPeriod(
  input: { periodEnd?: string; periodStart?: string },
  now: Date,
): { periodEnd: string; periodStart: string } | null {
  if (!input.periodStart && !input.periodEnd) return previousShanghaiDayPeriod(now);
  if (!input.periodStart || !input.periodEnd) return null;
  const startMs = Date.parse(input.periodStart);
  const endMs = Date.parse(input.periodEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
  return {
    periodEnd: new Date(endMs).toISOString(),
    periodStart: new Date(startMs).toISOString(),
  };
}

export function previousShanghaiDayPeriod(now: Date): { periodEnd: string; periodStart: string } {
  const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
  const localDate = new Date(now.getTime() + shanghaiOffsetMs);
  const localDayStartUtcMs = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
  ) - shanghaiOffsetMs;
  const periodEndMs = localDayStartUtcMs;
  const periodStartMs = periodEndMs - 24 * 60 * 60 * 1000;
  return {
    periodEnd: new Date(periodEndMs).toISOString(),
    periodStart: new Date(periodStartMs).toISOString(),
  };
}
