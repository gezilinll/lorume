import { describe, expect, it } from "vitest";
import { createPostgresAuthStore } from "../auth/auth-store";
import {
  createTemporaryPostgresDatabase,
  runDatabaseSchemaScript,
  shouldRunPostgresTests,
} from "../test/postgres";
import { createPostgresOperationStore } from "./operation-store";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;

describeDb("Postgres operation store", () => {
  it("lists operations by organization and exposes recent jobs for details", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("ops-list@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Ops List Team",
          slug: "ops-list-team",
        });
        const otherOrganization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Other Ops Team",
          slug: "other-ops-team",
        });
        const operation = await operationStore.createOperation({
          organizationId: organization.id,
          requestedByUserId: user.id,
          resourceId: "thread_list",
          resourceType: "notification_thread",
          summary: "Deliver listed notification",
          type: "notification_delivery",
        });
        await operationStore.enqueueJob({
          operationId: operation.id,
          organizationId: organization.id,
          payload: { threadId: "thread_list" },
          type: "notification_in_app",
        });
        await operationStore.createOperation({
          organizationId: otherOrganization.id,
          requestedByUserId: user.id,
          resourceId: "thread_other",
          resourceType: "notification_thread",
          summary: "Other org operation",
          type: "notification_delivery",
        });

        const operations = await operationStore.listOperations({
          organizationId: organization.id,
          resourceId: "thread_list",
          resourceType: "notification_thread",
          status: "queued",
        });
        const jobs = await operationStore.listJobs({ operationId: operation.id });

        expect(operations).toEqual([
          expect.objectContaining({
            id: operation.id,
            organizationId: organization.id,
            resourceId: "thread_list",
          }),
        ]);
        expect(jobs).toEqual([
          expect.objectContaining({
            operationId: operation.id,
            type: "notification_in_app",
          }),
        ]);
      } finally {
        await Promise.all([authStore.close(), operationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("claims one due job with a lease and completes the owning operation", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("ops-owner@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Ops Team",
          slug: "ops-team",
        });
        const operation = await operationStore.createOperation({
          organizationId: organization.id,
          requestedByUserId: user.id,
          resourceId: "thread_1",
          resourceType: "notification_thread",
          summary: "Deliver in-app notification",
          type: "notification_delivery",
        });
        const job = await operationStore.enqueueJob({
          operationId: operation.id,
          organizationId: organization.id,
          payload: { threadId: "thread_1" },
          runAfter: new Date("2026-05-14T09:59:00.000Z"),
          type: "notification_in_app",
        });

        const claimed = await operationStore.claimNextJob({
          leaseMs: 30_000,
          now: new Date("2026-05-14T10:00:00.000Z"),
          runnerId: "runner-a",
        });
        const duplicate = await operationStore.claimNextJob({
          leaseMs: 30_000,
          now: new Date("2026-05-14T10:00:10.000Z"),
          runnerId: "runner-b",
        });
        await operationStore.completeJob({
          jobId: job.id,
          now: new Date("2026-05-14T10:00:12.000Z"),
          status: "succeeded",
        });
        const completed = await operationStore.readOperation({ operationId: operation.id });

        expect(claimed).toMatchObject({
          attemptCount: 1,
          id: job.id,
          lockedBy: "runner-a",
          operationId: operation.id,
          status: "running",
        });
        expect(duplicate).toBeNull();
        expect(completed).toMatchObject({
          id: operation.id,
          status: "succeeded",
        });
      } finally {
        await Promise.all([authStore.close(), operationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("lets a job move the owning operation into a manual-step state", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("ops-manual@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Manual Step Team",
          slug: "manual-step-team",
        });
        const operation = await operationStore.createOperation({
          organizationId: organization.id,
          requestedByUserId: user.id,
          summary: "发送设备离线通知",
          targetId: "gezilinll-claw",
          targetType: "device",
          type: "notification_delivery",
        });
        const job = await operationStore.enqueueJob({
          operationId: operation.id,
          organizationId: organization.id,
          payload: { threadId: "thread_device_offline" },
          type: "notification_email",
        });

        await operationStore.claimNextJob({
          leaseMs: 30_000,
          now: new Date("2026-05-14T10:30:00.000Z"),
          runnerId: "runner-a",
        });
        await operationStore.completeJob({
          jobId: job.id,
          manualInstruction: "邮件服务未配置，请先补齐 SMTP 配置后重试。",
          now: new Date("2026-05-14T10:30:12.000Z"),
          status: "requires_manual_step",
        });
        const completed = await operationStore.readOperation({ operationId: operation.id });
        const jobs = await operationStore.listJobs({ operationId: operation.id });

        expect(jobs[0]).toMatchObject({
          id: job.id,
          status: "requires_manual_step",
        });
        expect(completed).toMatchObject({
          id: operation.id,
          manualInstruction: "邮件服务未配置，请先补齐 SMTP 配置后重试。",
          status: "requires_manual_step",
        });
      } finally {
        await Promise.all([authStore.close(), operationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("updates notification operations without an executable job", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("notification-status@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Notification Status Team",
          slug: "notification-status-team",
        });
        const operation = await operationStore.createOperation({
          organizationId: organization.id,
          requestedByUserId: user.id,
          resourceId: "thread_1",
          resourceType: "notification_thread",
          summary: "发送通知",
          targetId: "thread_1",
          targetType: "notification_thread",
          type: "notification_delivery",
        });

        const running = await operationStore.updateOperationStatus({
          operationId: operation.id,
          now: new Date("2026-05-18T10:00:00.000Z"),
          status: "running",
        });
        const failed = await operationStore.updateOperationStatus({
          errorSummary: "通知渠道未配置",
          operationId: operation.id,
          now: new Date("2026-05-18T10:01:00.000Z"),
          status: "failed",
        });

        expect(running).toMatchObject({ id: operation.id, status: "running" });
        expect(failed).toMatchObject({
          errorSummary: "通知渠道未配置",
          id: operation.id,
          status: "failed",
        });
        expect(failed?.finishedAt).toBeInstanceOf(Date);
      } finally {
        await Promise.all([authStore.close(), operationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("persists collector upgrade progress and completes from an external device event", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("collector-upgrade@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Collector Upgrade Team",
          slug: "collector-upgrade-team",
        });
        const operation = await operationStore.createOperation({
          metadata: {
            currentVersion: "0.1.0",
            deviceId: "fixture-mac",
            targetVersion: "0.1.2",
          },
          organizationId: organization.id,
          requestedByUserId: user.id,
          summary: "Upgrade collector on fixture-mac to 0.1.2",
          targetId: "fixture-mac",
          targetType: "device",
          type: "collector_upgrade",
        });
        const job = await operationStore.enqueueJob({
          maxAttempts: 1,
          operationId: operation.id,
          organizationId: organization.id,
          payload: {
            currentVersion: "0.1.0",
            deviceId: "fixture-mac",
            stage: "queued",
            targetVersion: "0.1.2",
          },
          runAfter: new Date("2026-06-02T08:59:00.000Z"),
          type: "collector_upgrade_device",
        });

        await operationStore.claimNextJob({
          leaseMs: 30_000,
          now: new Date("2026-06-02T09:00:00.000Z"),
          runnerId: "upgrade-runner",
        });
        const progressing = await operationStore.updateJobPayload({
          jobId: job.id,
          now: new Date("2026-06-02T09:00:02.000Z"),
          payloadPatch: {
            message: "Downloading collector package",
            stage: "downloading",
          },
        });
        const completedJob = await operationStore.completeExternalJob({
          jobId: job.id,
          now: new Date("2026-06-02T09:00:30.000Z"),
          payloadPatch: {
            collectorVersion: "0.1.2",
            stage: "succeeded",
          },
          status: "succeeded",
        });
        const completedOperation = await operationStore.readOperation({ operationId: operation.id });

        expect(progressing).toMatchObject({
          id: job.id,
          payload: expect.objectContaining({
            currentVersion: "0.1.0",
            message: "Downloading collector package",
            stage: "downloading",
            targetVersion: "0.1.2",
          }),
        });
        expect(completedJob).toMatchObject({
          finishedAt: expect.any(Date),
          id: job.id,
          lockedBy: null,
          payload: expect.objectContaining({
            collectorVersion: "0.1.2",
            stage: "succeeded",
          }),
          status: "succeeded",
        });
        expect(completedOperation).toMatchObject({
          id: operation.id,
          status: "succeeded",
        });
      } finally {
        await Promise.all([authStore.close(), operationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("fails collector upgrade jobs externally without retrying", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("collector-upgrade-fail@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Collector Upgrade Failure Team",
          slug: "collector-upgrade-failure-team",
        });
        const operation = await operationStore.createOperation({
          organizationId: organization.id,
          requestedByUserId: user.id,
          summary: "Upgrade collector on fixture-mac to 0.1.2",
          targetId: "fixture-mac",
          targetType: "device",
          type: "collector_upgrade",
        });
        const job = await operationStore.enqueueJob({
          maxAttempts: 1,
          operationId: operation.id,
          organizationId: organization.id,
          payload: {
            deviceId: "fixture-mac",
            stage: "installing",
            targetVersion: "0.1.2",
          },
          runAfter: new Date("2026-06-02T09:59:00.000Z"),
          type: "collector_upgrade_device",
        });
        await operationStore.claimNextJob({
          leaseMs: 30_000,
          now: new Date("2026-06-02T10:00:00.000Z"),
          runnerId: "upgrade-runner",
        });

        const failedJob = await operationStore.completeExternalJob({
          errorSummary: "Collector reported hash mismatch",
          jobId: job.id,
          now: new Date("2026-06-02T10:00:30.000Z"),
          payloadPatch: {
            errorCode: "hash_mismatch",
            stage: "failed",
          },
          status: "failed",
        });
        const failedOperation = await operationStore.readOperation({ operationId: operation.id });

        expect(failedJob).toMatchObject({
          attemptCount: 1,
          lastErrorSummary: "Collector reported hash mismatch",
          payload: expect.objectContaining({
            errorCode: "hash_mismatch",
            stage: "failed",
          }),
          status: "failed",
        });
        expect(failedOperation).toMatchObject({
          errorSummary: "Collector reported hash mismatch",
          status: "failed",
        });
      } finally {
        await Promise.all([authStore.close(), operationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("requeues failed jobs until max attempts and then fails the operation", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("ops-retry@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Retry Team",
          slug: "retry-team",
        });
        const operation = await operationStore.createOperation({
          organizationId: organization.id,
          requestedByUserId: user.id,
          summary: "Deliver notification email",
          targetId: "thread_1",
          targetType: "notification_thread",
          type: "notification_delivery",
        });
        await operationStore.enqueueJob({
          maxAttempts: 2,
          operationId: operation.id,
          organizationId: organization.id,
          payload: { threadId: "thread_1" },
          runAfter: new Date("2026-05-14T10:59:00.000Z"),
          type: "notification_email",
        });

        const firstClaim = await operationStore.claimNextJob({
          leaseMs: 1_000,
          now: new Date("2026-05-14T11:00:00.000Z"),
          runnerId: "runner-a",
        });
        await operationStore.failJob({
          errorSummary: "email provider unavailable",
          jobId: firstClaim?.id ?? "",
          now: new Date("2026-05-14T11:00:01.000Z"),
          retryAfterMs: 5_000,
        });
        const waiting = await operationStore.readOperation({ operationId: operation.id });
        const earlyClaim = await operationStore.claimNextJob({
          leaseMs: 1_000,
          now: new Date("2026-05-14T11:00:02.000Z"),
          runnerId: "runner-b",
        });
        const secondClaim = await operationStore.claimNextJob({
          leaseMs: 1_000,
          now: new Date("2026-05-14T11:00:07.000Z"),
          runnerId: "runner-b",
        });
        await operationStore.failJob({
          errorSummary: "email provider unavailable",
          jobId: secondClaim?.id ?? "",
          now: new Date("2026-05-14T11:00:08.000Z"),
        });
        const failed = await operationStore.readOperation({ operationId: operation.id });

        expect(waiting).toMatchObject({ status: "queued" });
        expect(earlyClaim).toBeNull();
        expect(secondClaim).toMatchObject({ attemptCount: 2, status: "running" });
        expect(failed).toMatchObject({
          errorSummary: "email provider unavailable",
          status: "failed",
        });
      } finally {
        await Promise.all([authStore.close(), operationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });
});
