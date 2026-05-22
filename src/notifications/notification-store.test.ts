import { describe, expect, it } from "vitest";
import { createPostgresAuthStore } from "../auth/auth-store";
import {
  createTemporaryPostgresDatabase,
  runDatabaseSchemaScript,
  shouldRunPostgresTests,
} from "../test/postgres";
import { createPostgresNotificationStore } from "./notification-store";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;

describeDb("Postgres notification store", () => {
  it("reads a notification thread and its deliveries for an in-app detail view", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const notificationStore = createPostgresNotificationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("notify-detail@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Notify Detail Team",
          slug: "notify-detail-team",
        });
        const result = await notificationStore.createNotificationEvent({
          actorUserId: user.id,
          dedupeKey: "runtime:device_detail:state_collected",
          eventType: "device_state_collected",
          organizationId: organization.id,
          recipientUserIds: [user.id],
          resourceId: "gezilinll-claw",
          resourceType: "device",
          severity: "info",
          sourceModule: "runtime",
          summary: "设备状态已采集。",
          title: "设备状态采集完成",
        });

        const thread = await notificationStore.readThread({ threadId: result.thread.id });
        const deliveries = await notificationStore.listDeliveries({ threadId: result.thread.id });

        expect(thread).toMatchObject({
          id: result.thread.id,
          latestSummary: "设备状态已采集。",
          title: "设备状态采集完成",
        });
        expect(deliveries).toEqual([
          expect.objectContaining({
            channel: "in_app",
            recipientUserId: user.id,
            status: "sent",
          }),
        ]);
      } finally {
        await Promise.all([authStore.close(), notificationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("tracks in-app read state per notification recipient", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const notificationStore = createPostgresNotificationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("notify-read@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Notify Read Team",
          slug: "notify-read-team",
        });
        const result = await notificationStore.createNotificationEvent({
          actorUserId: user.id,
          dedupeKey: "runtime:device_read:state_collection_queued",
          eventType: "device_state_collection_queued",
          organizationId: organization.id,
          recipientUserIds: [user.id],
          resourceId: "gezilinll-claw",
          resourceType: "device",
          severity: "info",
          sourceModule: "runtime",
          summary: "设备状态采集通知等待处理。",
          title: "设备状态采集排队中",
        });

        await expect(notificationStore.listThreads({
          organizationId: organization.id,
          recipientUserId: user.id,
        })).resolves.toEqual([
          expect.objectContaining({ id: result.thread.id, isRead: false }),
        ]);

        await notificationStore.markThreadRead({ recipientUserId: user.id, threadId: result.thread.id });

        await expect(notificationStore.listThreads({
          organizationId: organization.id,
          recipientUserId: user.id,
        })).resolves.toEqual([
          expect.objectContaining({ id: result.thread.id, isRead: true, readAt: expect.any(Date) }),
        ]);
        await expect(notificationStore.listDeliveries({ threadId: result.thread.id })).resolves.toEqual([
          expect.objectContaining({ channel: "in_app", readAt: expect.any(Date) }),
        ]);
      } finally {
        await Promise.all([authStore.close(), notificationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("aggregates duplicate events and always records in-app delivery", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const notificationStore = createPostgresNotificationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("notify-owner@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Notify Team",
          slug: "notify-team",
        });

        await notificationStore.createNotificationEvent({
          actorUserId: user.id,
          dedupeKey: "runtime:device_1:state_collection_failed",
          eventType: "device_state_collection_failed",
          organizationId: organization.id,
          recipientUserIds: [user.id],
          resourceId: "device_1",
          resourceType: "device",
          severity: "warning",
          sourceModule: "runtime",
          summary: "Collector rejected device state collection.",
          title: "设备状态采集失败",
        });
        const second = await notificationStore.createNotificationEvent({
          actorUserId: user.id,
          dedupeKey: "runtime:device_1:state_collection_failed",
          eventType: "device_state_collection_failed",
          organizationId: organization.id,
          recipientUserIds: [user.id],
          resourceId: "device_1",
          resourceType: "device",
          severity: "warning",
          sourceModule: "runtime",
          summary: "Collector still rejects device state collection.",
          title: "设备状态采集失败",
        });

        const threads = await notificationStore.listThreads({
          organizationId: organization.id,
          recipientUserId: user.id,
        });
        const deliveries = await notificationStore.listDeliveries({
          threadId: second.thread.id,
        });

        expect(threads).toEqual([
          expect.objectContaining({
            dedupeKey: "runtime:device_1:state_collection_failed",
            latestSummary: "Collector still rejects device state collection.",
            occurrenceCount: 2,
          }),
        ]);
        expect(deliveries.filter((delivery) => delivery.channel === "in_app")).toHaveLength(2);
      } finally {
        await Promise.all([authStore.close(), notificationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });

  it("rate limits duplicate email deliveries by thread cooldown", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const notificationStore = createPostgresNotificationStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("notify-email@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Notify Email Team",
          slug: "notify-email-team",
        });

        const first = await notificationStore.createNotificationEvent({
          actorUserId: user.id,
          createdAt: new Date("2026-05-14T12:00:00.000Z"),
          dedupeKey: "device:claw:offline",
          emailCooldownMs: 30 * 60 * 1000,
          eventType: "device_offline",
          organizationId: organization.id,
          recipientUserIds: [user.id],
          resourceId: "gezilinll-claw",
          resourceType: "device",
          severity: "critical",
          sourceModule: "runtime",
          summary: "Collector heartbeat timed out.",
          title: "设备离线",
        });
        await notificationStore.createNotificationEvent({
          actorUserId: user.id,
          createdAt: new Date("2026-05-14T12:10:00.000Z"),
          dedupeKey: "device:claw:offline",
          emailCooldownMs: 30 * 60 * 1000,
          eventType: "device_offline",
          organizationId: organization.id,
          recipientUserIds: [user.id],
          resourceId: "gezilinll-claw",
          resourceType: "device",
          severity: "critical",
          sourceModule: "runtime",
          summary: "Collector heartbeat still timed out.",
          title: "设备离线",
        });

        const deliveries = await notificationStore.listDeliveries({ threadId: first.thread.id });

        expect(deliveries.filter((delivery) => delivery.channel === "email" && delivery.status === "pending")).toHaveLength(1);
        expect(deliveries.filter((delivery) => delivery.channel === "email" && delivery.status === "skipped")).toHaveLength(1);
      } finally {
        await Promise.all([authStore.close(), notificationStore.close()]);
      }
    } finally {
      await database.drop();
    }
  });
});
