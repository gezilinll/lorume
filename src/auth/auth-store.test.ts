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
        await expect(store.readInvitationPreview({
          now,
          tokenHash: invitationTokenHash,
        })).resolves.toMatchObject({
          email: "juanbai@gaoding.com",
          maskedEmail: "j***@gaoding.com",
          organizationName: "Lorume Team",
          role: "admin",
          status: "available",
        });
        const invitationList = await store.listOrganizationInvitations({ now, organizationId: organization.id });
        expect(invitationList).toEqual([
          expect.objectContaining({
            email: "juanbai@gaoding.com",
            maskedEmail: "j***@gaoding.com",
            role: "admin",
            status: "available",
          }),
        ]);
        await expect(store.readOrganizationInvitation({
          id: invitationList[0]?.id ?? "missing",
          now,
          organizationId: organization.id,
        })).resolves.toMatchObject({
          email: "juanbai@gaoding.com",
          status: "available",
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
        await expect(store.leaveOrganization({
          now,
          organizationId: organization.id,
          userId: memberUser.id,
        })).resolves.toEqual({ ok: true, organizations: [] });
        await expect(store.listOrganizationMembers({ organizationId: organization.id })).resolves.toEqual([
          expect.objectContaining({ email: "zhangliang@gaoding.com", role: "owner" }),
          expect.objectContaining({ email: "juanbai@gaoding.com", role: "admin" }),
        ]);
        await expect(store.leaveOrganization({
          now,
          organizationId: organization.id,
          userId: user.id,
        })).resolves.toEqual({ ok: false, reason: "last_owner" });
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
        const createdDeviceToken = await store.createDeviceToken({
          name: "gezilinll-claw collector",
          organizationId: organization.id,
          tokenCiphertext: "encrypted-device-secret",
          tokenHash: deviceTokenHash,
          tokenPrefix: "agt_dev",
        });
        expect(createdDeviceToken).toMatchObject({
          deviceId: null,
          id: expect.stringMatching(/^devtok_[0-9a-f-]{36}$/),
          status: "pending",
        });
        await expect(store.readDeviceTokenInstallSecret({
          id: createdDeviceToken.id,
          now,
          organizationId: organization.id,
        })).resolves.toMatchObject({
          deviceToken: expect.objectContaining({ id: createdDeviceToken.id }),
          tokenCiphertext: "encrypted-device-secret",
        });
        await expect(store.verifyDeviceToken(deviceTokenHash, now, "gezilinll-claw")).resolves.toMatchObject({
          deviceId: "gezilinll-claw",
          organizationId: organization.id,
          status: "occupied",
        });
        await expect(store.listDeviceTokens({ now, organizationId: organization.id })).resolves.toEqual([
          expect.objectContaining({
            deviceId: "gezilinll-claw",
            name: "gezilinll-claw collector",
            status: "occupied",
          }),
        ]);
        await expect(store.verifyDeviceToken(deviceTokenHash, now, "other-device")).resolves.toBeNull();
        await expect(store.listAuditEvents({ organizationId: organization.id })).resolves.toEqual([
          expect.objectContaining({
            eventType: "device_token.reuse_rejected",
            metadata: expect.objectContaining({ attemptedDeviceId: "other-device" }),
          }),
          expect.objectContaining({
            eventType: "device_token.occupied",
            metadata: expect.objectContaining({ deviceId: "gezilinll-claw" }),
          }),
          expect.objectContaining({
            eventType: "organization.member_left",
            metadata: expect.objectContaining({ role: "member" }),
          }),
        ]);
      } finally {
        await store.close();
      }
    } finally {
      await database.drop();
    }
  });
});
