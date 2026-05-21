import type { NotificationSourceModule, NotificationStore } from "../notifications/notification-store";
import type { OperationJobRow, OperationJobType, OperationRow, OperationStatus, OperationStore } from "./operation-store";

/** Handler result for a claimed operation job. */
export interface OperationJobHandlerResult {
  manualInstruction?: string;
  status: "succeeded" | "unsupported" | "requires_manual_step";
}

/** Handler for one executable operation job type. */
export type OperationJobHandler = (job: OperationJobRow) => Promise<OperationJobHandlerResult> | OperationJobHandlerResult;

/** Operation job runner options. */
export interface OperationJobRunnerOptions {
  operationStore: OperationStore;
  notificationStore?: Pick<NotificationStore, "createNotificationEvent">;
  handlers: Partial<Record<OperationJobType, OperationJobHandler>>;
  runnerId: string;
  leaseMs?: number;
  retryAfterMs?: number;
  now?: () => Date;
}

/** Result of one runner tick. */
export type OperationJobRunResult =
  | { status: "idle" }
  | {
    status: "handled";
    jobId: string;
    jobType: OperationJobType;
    outcome: "succeeded" | "unsupported" | "requires_manual_step";
  }
  | { status: "failed"; jobId: string; jobType: OperationJobType; errorSummary: string };

/** Minimal Postgres-backed job runner. */
export interface OperationJobRunner {
  runDueJobOnce: () => Promise<OperationJobRunResult>;
}

/** Create a single-process job runner over OperationStore claim/lease semantics. */
export function createOperationJobRunner(options: OperationJobRunnerOptions): OperationJobRunner {
  const leaseMs = options.leaseMs ?? 60_000;
  const retryAfterMs = options.retryAfterMs ?? 30_000;
  const now = options.now ?? (() => new Date());

  return {
    async runDueJobOnce() {
      const claimedJob = await options.operationStore.claimNextJob({
        leaseMs,
        now: now(),
        runnerId: options.runnerId,
      });
      if (!claimedJob) return { status: "idle" };

      const handler = options.handlers[claimedJob.type];
      if (!handler) {
        await options.operationStore.completeJob({
          jobId: claimedJob.id,
          now: now(),
          status: "unsupported",
        });
        await notifyOperationStatusChanged(options, claimedJob.operationId, now());
        return {
          jobId: claimedJob.id,
          jobType: claimedJob.type,
          outcome: "unsupported",
          status: "handled",
        };
      }

      try {
        const result = await handler(claimedJob);
        await options.operationStore.completeJob({
          jobId: claimedJob.id,
          manualInstruction: result.manualInstruction,
          now: now(),
          status: result.status,
        });
        await notifyOperationStatusChanged(options, claimedJob.operationId, now());
        return {
          jobId: claimedJob.id,
          jobType: claimedJob.type,
          outcome: result.status,
          status: "handled",
        };
      } catch (error) {
        const errorSummary = normalizeErrorSummary(error);
        await options.operationStore.failJob({
          errorSummary,
          jobId: claimedJob.id,
          now: now(),
          retryAfterMs,
        });
        await notifyOperationStatusChanged(options, claimedJob.operationId, now());
        return {
          errorSummary,
          jobId: claimedJob.id,
          jobType: claimedJob.type,
          status: "failed",
        };
      }
    },
  };
}

async function notifyOperationStatusChanged(
  options: OperationJobRunnerOptions,
  operationId: string,
  createdAt: Date,
): Promise<void> {
  if (!options.notificationStore) return;
  const operation = await options.operationStore.readOperation({ operationId });
  if (!operation || !operation.requestedByUserId || !isNotifiableOperationStatus(operation.status)) return;
  try {
    await options.notificationStore.createNotificationEvent({
      actorUserId: operation.requestedByUserId,
      createdAt,
      dedupeKey: `operation:${operation.id}:${operation.status}`,
      emailCooldownMs: 30 * 60 * 1000,
      eventType: `operation_${operation.status}`,
      operationId: operation.id,
      organizationId: operation.organizationId,
      recipientUserIds: [operation.requestedByUserId],
      resourceId: operation.resourceId,
      resourceType: operation.resourceType,
      severity: operation.status === "succeeded" ? "info" : "warning",
      sourceModule: sourceModuleForOperation(operation),
      summary: operation.errorSummary ? `${operation.summary}: ${operation.errorSummary}` : operation.summary,
      title: `${operation.summary} ${titleSuffixForStatus(operation.status)}`,
    });
  } catch {
    // Operation completion must not be rolled back by notification delivery or persistence issues.
  }
}

function isNotifiableOperationStatus(status: OperationStatus): boolean {
  return status === "succeeded"
    || status === "failed"
    || status === "unsupported"
    || status === "requires_manual_step";
}

function titleSuffixForStatus(status: OperationStatus): string {
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  if (status === "unsupported") return "不支持自动处理";
  if (status === "requires_manual_step") return "需要人工处理";
  return "状态更新";
}

function sourceModuleForOperation(operation: OperationRow): NotificationSourceModule {
  void operation;
  return "system";
}

function normalizeErrorSummary(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 500);
  return "operation job failed";
}
