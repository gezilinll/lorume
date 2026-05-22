import { describe, expect, it } from "vitest";
import { hashSecret } from "./auth-crypto";
import { createPostgresAuthStore } from "./auth-store";
import {
  createTemporaryPostgresDatabase,
  runDatabaseSchemaScript,
  shouldRunPostgresTests,
} from "../test/postgres";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;

describeDb("Postgres auth store", () => {
  it("persists the email login, organization, invitation, session, and device-token flow", async () => {
    const database = await createTemporaryPostgresDatabase();
    const now = new Date("2026-05-12T10:00:00.000Z");

    try {
      runDatabaseSchemaScript(database.url);
      const store = createPostgresAuthStore({ connectionString: database.url });

      try {
        const loginCodeHash = hashSecret("246810", "login-code", "test-pepper");
        await store.createLoginCode({
          codeHash: loginCodeHash,
          email: "ZHANGLIANG@GAODING.COM",
          expiresAt: new Date("2026-05-12T10:10:00.000Z"),
        });

        await expect(store.consumeLoginCode({
          codeHash: loginCodeHash,
          email: "zhangliang@gaoding.com",
          now,
        })).resolves.toMatchObject({ email: "zhangliang@gaoding.com" });
        await expect(store.consumeLoginCode({
          codeHash: loginCodeHash,
          email: "zhangliang@gaoding.com",
          now,
        })).resolves.toBeNull();

        const user = await store.upsertUserForEmail("zhangliang@gaoding.com");
        const organization = await store.createOrganization({
          createdByUserId: user.id,
          name: "Lorume Team",
          slug: "lorume-team",
        });
        await expect(store.listOrganizationsForUser(user.id)).resolves.toEqual([
          expect.objectContaining({ organizationId: organization.id, role: "owner" }),
        ]);
        await expect(store.listOrganizationAdminUserIds(organization.id)).resolves.toEqual([user.id]);

        const invitedUser = await store.upsertUserForEmail("juanbai@gaoding.com");
        const invitationTokenHash = hashSecret("invite-token", "invitation-token", "test-pepper");
        await store.createInvitation({
          email: "juanbai@gaoding.com",
          expiresAt: new Date("2026-05-13T10:00:00.000Z"),
          invitedByUserId: user.id,
          organizationId: organization.id,
          role: "admin",
          tokenHash: invitationTokenHash,
        });
        const accepted = await store.acceptInvitation({
          email: "juanbai@gaoding.com",
          now,
          tokenHash: invitationTokenHash,
          userId: invitedUser.id,
        });
        expect(accepted).toMatchObject({ organizationId: organization.id, role: "admin" });
        const memberUser = await store.upsertUserForEmail("member@gaoding.com");
        const memberInvitationTokenHash = hashSecret("member-invite-token", "invitation-token", "test-pepper");
        await store.createInvitation({
          email: "member@gaoding.com",
          expiresAt: new Date("2026-05-13T10:00:00.000Z"),
          invitedByUserId: user.id,
          organizationId: organization.id,
          role: "member",
          tokenHash: memberInvitationTokenHash,
        });
        await store.acceptInvitation({
          email: "member@gaoding.com",
          now,
          tokenHash: memberInvitationTokenHash,
          userId: memberUser.id,
        });
        await expect(store.listOrganizationAdminUserIds(organization.id)).resolves.toEqual([
          user.id,
          invitedUser.id,
        ]);

        const sessionHash = hashSecret("session-token", "session-token", "test-pepper");
        const session = await store.createSession({
          expiresAt: new Date("2026-06-12T10:00:00.000Z"),
          sessionHash,
          userId: user.id,
        });
        await expect(store.readSessionByHash(sessionHash, now)).resolves.toMatchObject({
          id: session.id,
          user: expect.objectContaining({ email: "zhangliang@gaoding.com" }),
          organizations: [expect.objectContaining({ slug: "lorume-team", role: "owner" })],
        });

        const deviceTokenHash = hashSecret("device-secret", "device-token", "test-pepper");
        await store.createDeviceToken({
          deviceId: "gezilinll-claw",
          name: "gezilinll-claw collector",
          organizationId: organization.id,
          tokenHash: deviceTokenHash,
          tokenPrefix: "agt_dev",
        });
        await expect(store.verifyDeviceToken(deviceTokenHash, now)).resolves.toMatchObject({
          deviceId: "gezilinll-claw",
          organizationId: organization.id,
        });
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });
});
