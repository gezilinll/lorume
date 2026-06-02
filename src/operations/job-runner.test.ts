import { describe, expect, it } from "vitest";
import type { CreateNotificationEventInput, CreateNotificationEventResult } from "../notifications/notification-store";
import { createOperationJobRunner } from "./job-runner";
import type { OperationJobRow, OperationRow, OperationStore } from "./operation-store";

describe("operation job runner", () => {
  it("claims one due job and completes it through the matching handler", async () => {
    const job = createJob({ type: "notification_in_app", payload: { threadId: "thread_1" } });
    const store = createFakeOperationStore(job);
    const runner = createOperationJobRunner({
      handlers: {
        notification_in_app: async (claimedJob) => {
          expect(claimedJob.payload).toEqual({ threadId: "thread_1" });
          return { status: "succeeded" };
        },
      },
      leaseMs: 30_000,
      now: () => new Date("2026-05-14T12:00:00.000Z"),
      operationStore: store,
      runnerId: "runner-a",
    });

    await expect(runner.runDueJobOnce()).resolves.toEqual({
      jobId: "job_1",
      jobType: "notification_in_app",
      outcome: "succeeded",
      status: "handled",
    });
    expect(store.completed).toEqual([{ jobId: "job_1", status: "succeeded" }]);
    expect(store.failed).toEqual([]);
  });

  it("marks unsupported jobs without retrying when no handler is registered", async () => {
    const store = createFakeOperationStore(createJob({ type: "notification_email" }));
    const runner = createOperationJobRunner({
      handlers: {},
      leaseMs: 30_000,
      now: () => new Date("2026-05-14T12:05:00.000Z"),
      operationStore: store,
      runnerId: "runner-a",
    });

    await expect(runner.runDueJobOnce()).resolves.toEqual({
      jobId: "job_1",
      jobType: "notification_email",
      outcome: "unsupported",
      status: "handled",
    });
    expect(store.completed).toEqual([{ jobId: "job_1", status: "unsupported" }]);
    expect(store.failed).toEqual([]);
  });

  it("passes manual-step handler results through the operation store and notification path", async () => {
    const notifications: CreateNotificationEventInput[] = [];
    const store = createFakeOperationStore(
      createJob({ type: "notification_email" }),
      createOperation({
        requestedByUserId: "user_1",
        status: "queued",
        summary: "发送通知邮件",
        targetId: "thread_1",
        targetType: "notification_thread",
        type: "notification_delivery",
      }),
    );
    const runner = createOperationJobRunner({
      handlers: {
        notification_email: () => ({
          manualInstruction: "邮件服务未配置，请先补齐 SMTP 配置。",
          status: "requires_manual_step",
        }),
      },
      notificationStore: {
        createNotificationEvent: async (input) => {
          notifications.push(input);
          return createNotificationResult(input);
        },
      },
      now: () => new Date("2026-05-14T12:07:00.000Z"),
      operationStore: store,
      runnerId: "runner-a",
    });

    await expect(runner.runDueJobOnce()).resolves.toEqual({
      jobId: "job_1",
      jobType: "notification_email",
      outcome: "requires_manual_step",
      status: "handled",
    });
    expect(store.completed).toEqual([{
      jobId: "job_1",
      manualInstruction: "邮件服务未配置，请先补齐 SMTP 配置。",
      status: "requires_manual_step",
    }]);
    expect(notifications).toEqual([
      expect.objectContaining({
        dedupeKey: "operation:operation_1:requires_manual_step",
        eventType: "operation_requires_manual_step",
        severity: "warning",
        sourceModule: "system",
        title: "发送通知邮件 需要人工处理",
      }),
    ]);
  });

  it("records failed handler attempts through the operation store", async () => {
    const store = createFakeOperationStore(createJob({ type: "notification_in_app" }));
    const runner = createOperationJobRunner({
      handlers: {
        notification_in_app: async () => {
          throw new Error("notification write failed");
        },
      },
      leaseMs: 30_000,
      now: () => new Date("2026-05-14T12:10:00.000Z"),
      operationStore: store,
      retryAfterMs: 10_000,
      runnerId: "runner-a",
    });

    await expect(runner.runDueJobOnce()).resolves.toEqual({
      errorSummary: "notification write failed",
      jobId: "job_1",
      jobType: "notification_in_app",
      status: "failed",
    });
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([
      {
        errorSummary: "notification write failed",
        jobId: "job_1",
        retryAfterMs: 10_000,
      },
    ]);
  });

  it("leaves external-running jobs open after the handler dispatches work", async () => {
    const job = createJob({ type: "collector_upgrade_device" });
    const store = createFakeOperationStore(job);
    const runner = createOperationJobRunner({
      handlers: {
        collector_upgrade_device: () => ({ status: "external_running" }),
      },
      leaseMs: 30_000,
      now: () => new Date("2026-06-02T12:00:00.000Z"),
      operationStore: store,
      runnerId: "runner-a",
    });

    await expect(runner.runDueJobOnce()).resolves.toEqual({
      jobId: "job_1",
      jobType: "collector_upgrade_device",
      outcome: "external_running",
      status: "handled",
    });
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
  });

  it("returns idle when no due job can be claimed", async () => {
    const store = createFakeOperationStore(null);
    const runner = createOperationJobRunner({
      handlers: {},
      operationStore: store,
      runnerId: "runner-a",
    });

    await expect(runner.runDueJobOnce()).resolves.toEqual({ status: "idle" });
    expect(store.claims).toBe(1);
  });

  it("creates a notification when a user-requested operation reaches a terminal status", async () => {
    const notifications: CreateNotificationEventInput[] = [];
    const store = createFakeOperationStore(
      createJob({ type: "notification_in_app" }),
      createOperation({
        requestedByUserId: "user_1",
        resourceId: "thread_1",
        resourceType: "notification_thread",
        status: "queued",
        summary: "发送通知",
        type: "notification_delivery",
      }),
    );
    const runner = createOperationJobRunner({
      handlers: {
        notification_in_app: () => ({ status: "succeeded" }),
      },
      notificationStore: {
        createNotificationEvent: async (input) => {
          notifications.push(input);
          throw new Error("test should not depend on notification return value");
        },
      },
      now: () => new Date("2026-05-14T12:15:00.000Z"),
      operationStore: store,
      runnerId: "runner-a",
    });

    await expect(runner.runDueJobOnce()).resolves.toMatchObject({
      outcome: "succeeded",
      status: "handled",
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        dedupeKey: "operation:operation_1:succeeded",
        eventType: "operation_succeeded",
        recipientUserIds: ["user_1"],
        resourceId: "thread_1",
        resourceType: "notification_thread",
        severity: "info",
        sourceModule: "system",
        summary: "发送通知",
        title: "发送通知 已完成",
      }),
    ]);
  });
});

function createJob(input: Partial<OperationJobRow>): OperationJobRow {
  const now = new Date("2026-05-14T12:00:00.000Z");
  return {
    attemptCount: 1,
    createdAt: now,
    finishedAt: null,
    id: "job_1",
    lastErrorSummary: null,
    lockedBy: "runner-a",
    lockedUntil: new Date("2026-05-14T12:01:00.000Z"),
    maxAttempts: 3,
    operationId: "operation_1",
    organizationId: "organization_1",
    payload: {},
    runAfter: now,
    startedAt: now,
    status: "running",
    type: "notification_in_app",
    updatedAt: now,
    ...input,
  };
}

function createOperation(input: Partial<OperationRow>): OperationRow {
  const now = new Date("2026-05-14T12:00:00.000Z");
  return {
    createdAt: now,
    errorSummary: null,
    finishedAt: null,
    id: "operation_1",
    manualInstruction: null,
    metadata: {},
    organizationId: "organization_1",
    requestedByUserId: null,
    resourceId: null,
    resourceType: null,
    startedAt: null,
    status: "queued",
    summary: "Operation",
    targetId: null,
    targetType: null,
    type: "notification_delivery",
    updatedAt: now,
    ...input,
  };
}

function createNotificationResult(input: CreateNotificationEventInput): CreateNotificationEventResult {
  const createdAt = input.createdAt ?? new Date("2026-05-14T12:00:00.000Z");
  return {
    deliveries: [],
    event: {
      actorUserId: input.actorUserId ?? null,
      createdAt,
      dedupeKey: input.dedupeKey,
      eventType: input.eventType,
      id: "notification_event_1",
      operationId: input.operationId ?? null,
      organizationId: input.organizationId,
      recipientUserIds: input.recipientUserIds,
      resourceId: input.resourceId ?? null,
      resourceType: input.resourceType ?? null,
      severity: input.severity,
      sourceModule: input.sourceModule,
      summary: input.summary,
      title: input.title,
    },
    thread: {
      cooldownUntil: null,
      createdAt,
      dedupeKey: input.dedupeKey,
      eventType: input.eventType,
      firstOccurredAt: createdAt,
      id: "notification_thread_1",
      isRead: false,
      lastOccurredAt: createdAt,
      latestSummary: input.summary,
      occurrenceCount: 1,
      organizationId: input.organizationId,
      readAt: null,
      resolvedAt: null,
      resourceId: input.resourceId ?? null,
      resourceType: input.resourceType ?? null,
      severity: input.severity,
      status: "open",
      title: input.title,
      updatedAt: createdAt,
    },
  };
}

function createFakeOperationStore(claimedJob: OperationJobRow | null, initialOperation?: OperationRow): OperationStore & {
  claims: number;
  completed: Array<{ jobId: string; manualInstruction?: string; status: "succeeded" | "unsupported" | "requires_manual_step" }>;
  completedExternal: Array<{ jobId: string; status: "succeeded" | "failed" | "unsupported" | "requires_manual_step" }>;
  failed: Array<{ jobId: string; errorSummary: string; retryAfterMs?: number }>;
  operation?: OperationRow;
} {
  return {
    claims: 0,
    completed: [],
    completedExternal: [],
    failed: [],
    operation: initialOperation,
    createOperation: async () => {
      throw new Error("not implemented");
    },
    enqueueJob: async () => {
      throw new Error("not implemented");
    },
    listOperations: async () => [],
    listJobs: async () => [],
    async claimNextJob() {
      this.claims += 1;
      return claimedJob;
    },
    async updateJobPayload() {
      return claimedJob;
    },
    async completeJob(input) {
      this.completed.push({
        jobId: input.jobId,
        manualInstruction: input.manualInstruction,
        status: input.status,
      });
      if (this.operation) {
        this.operation = {
          ...this.operation,
          finishedAt: input.now,
          manualInstruction: input.manualInstruction ?? this.operation.manualInstruction,
          status: input.status === "succeeded"
            ? "succeeded"
            : input.status === "requires_manual_step"
              ? "requires_manual_step"
              : "unsupported",
          updatedAt: input.now,
        };
      }
      return claimedJob ? { ...claimedJob, status: input.status } : null;
    },
    async completeExternalJob(input) {
      this.completedExternal.push({
        jobId: input.jobId,
        status: input.status,
      });
      return claimedJob ? { ...claimedJob, status: input.status } : null;
    },
    async failJob(input) {
      this.failed.push({
        errorSummary: input.errorSummary,
        jobId: input.jobId,
        retryAfterMs: input.retryAfterMs,
      });
      return claimedJob ? { ...claimedJob, lastErrorSummary: input.errorSummary, status: "queued" } : null;
    },
    async readOperation() {
      return this.operation ?? null;
    },
    async updateOperationStatus(input) {
      if (!this.operation) return null;
      this.operation = {
        ...this.operation,
        errorSummary: input.errorSummary ?? this.operation.errorSummary,
        manualInstruction: input.manualInstruction ?? this.operation.manualInstruction,
        status: input.status,
        updatedAt: input.now ?? this.operation.updatedAt,
      };
      return this.operation;
    },
    close: async () => {},
  };
}
