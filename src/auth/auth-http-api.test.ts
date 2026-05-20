import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthHttpApiHandler } from "./auth-http-api";
import type {
  AuthDeviceTokenVerification,
  AuthLoginCode,
  AuthMemberRole,
  AuthOrganizationMembership,
  AuthSessionContext,
  AuthStore,
  AuthUser,
} from "./auth-store";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("auth HTTP API", () => {
  it("logs in with an email code, creates an organization, invites a member, accepts the invite, and logs out", async () => {
    const sentCodes: Array<{ code: string; email: string }> = [];
    const store = new MemoryAuthStore();
    const { baseUrl } = await startAuthApi(store, sentCodes);

    const codeResponse = await postJson(`${baseUrl}/api/auth/email-code`, { email: "ZHANGLIANG@GAODING.COM" });
    expect(codeResponse.status).toBe(202);
    expect(sentCodes).toEqual([{ code: "246810", email: "zhangliang@gaoding.com" }]);

    const loginResponse = await postJson(`${baseUrl}/api/auth/login`, {
      code: "246810",
      email: "zhangliang@gaoding.com",
    });
    expect(loginResponse.status).toBe(200);
    const cookie = loginResponse.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("lorume_session=");
    await expect(loginResponse.json()).resolves.toMatchObject({
      user: { email: "zhangliang@gaoding.com" },
      organizations: [],
    });

    const createOrgResponse = await postJson(`${baseUrl}/api/organizations`, {
      name: "Lorume Team",
      slug: "lorume-team",
    }, cookie);
    expect(createOrgResponse.status).toBe(201);
    const orgBody = await createOrgResponse.json() as { organization: { id: string } };

    const meResponse = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
    await expect(meResponse.json()).resolves.toMatchObject({
      user: { email: "zhangliang@gaoding.com" },
      organizations: [expect.objectContaining({ role: "owner", slug: "lorume-team" })],
    });

    const inviteResponse = await postJson(`${baseUrl}/api/organizations/${orgBody.organization.id}/invitations`, {
      email: "juanbai@gaoding.com",
      role: "admin",
    }, cookie);
    expect(inviteResponse.status).toBe(201);
    await expect(inviteResponse.json()).resolves.toMatchObject({
      invitation: { email: "juanbai@gaoding.com", token: "invite-token" },
    });

    await postJson(`${baseUrl}/api/auth/email-code`, { email: "juanbai@gaoding.com" });
    const invitedLoginResponse = await postJson(`${baseUrl}/api/auth/login`, {
      code: "246810",
      email: "juanbai@gaoding.com",
    });
    const invitedCookie = invitedLoginResponse.headers.get("set-cookie") ?? "";
    const acceptResponse = await postJson(`${baseUrl}/api/invitations/invite-token/accept`, {}, invitedCookie);
    expect(acceptResponse.status).toBe(200);
    await expect(acceptResponse.json()).resolves.toMatchObject({
      organization: { organizationId: orgBody.organization.id, role: "admin" },
    });

    const logoutResponse = await postJson(`${baseUrl}/api/auth/logout`, {}, cookie);
    expect(logoutResponse.status).toBe(204);
    const loggedOutMe = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
    expect(loggedOutMe.status).toBe(401);
  });

  it("rejects anonymous organization management and invalid invitation emails", async () => {
    const store = new MemoryAuthStore();
    const { baseUrl } = await startAuthApi(store, []);

    const anonymousCreate = await postJson(`${baseUrl}/api/organizations`, { name: "Nope" });
    expect(anonymousCreate.status).toBe(401);

    await postJson(`${baseUrl}/api/auth/email-code`, { email: "owner@gaoding.com" });
    const ownerLogin = await postJson(`${baseUrl}/api/auth/login`, { email: "owner@gaoding.com", code: "246810" });
    const ownerCookie = ownerLogin.headers.get("set-cookie") ?? "";
    const orgResponse = await postJson(`${baseUrl}/api/organizations`, { name: "Lorume" }, ownerCookie);
    const orgBody = await orgResponse.json() as { organization: { id: string } };
    await postJson(`${baseUrl}/api/organizations/${orgBody.organization.id}/invitations`, {
      email: "expected@gaoding.com",
      role: "member",
    }, ownerCookie);

    await postJson(`${baseUrl}/api/auth/email-code`, { email: "other@gaoding.com" });
    const otherLogin = await postJson(`${baseUrl}/api/auth/login`, { email: "other@gaoding.com", code: "246810" });
    const otherCookie = otherLogin.headers.get("set-cookie") ?? "";
    const wrongAccept = await postJson(`${baseUrl}/api/invitations/invite-token/accept`, {}, otherCookie);

    expect(wrongAccept.status).toBe(403);
  });

  it("creates device tokens only for organization admins and returns the plaintext token once", async () => {
    const store = new MemoryAuthStore();
    const { baseUrl } = await startAuthApi(store, []);

    await postJson(`${baseUrl}/api/auth/email-code`, { email: "owner@gaoding.com" });
    const ownerLogin = await postJson(`${baseUrl}/api/auth/login`, { email: "owner@gaoding.com", code: "246810" });
    const ownerCookie = ownerLogin.headers.get("set-cookie") ?? "";
    const orgResponse = await postJson(`${baseUrl}/api/organizations`, { name: "Lorume" }, ownerCookie);
    const orgBody = await orgResponse.json() as { organization: { id: string } };

    const tokenResponse = await postJson(`${baseUrl}/api/organizations/${orgBody.organization.id}/device-tokens`, {
      deviceId: "fixture-device",
      name: "Fixture collector",
    }, ownerCookie);
    const tokenBody = await tokenResponse.json() as {
      deviceToken: { deviceId: string; name?: string; token?: string; tokenHash?: string; tokenPrefix: string };
    };

    expect(tokenResponse.status).toBe(201);
    expect(tokenBody.deviceToken).toMatchObject({
      deviceId: "fixture-device",
      tokenPrefix: expect.stringMatching(/^agt_device_/),
    });
    expect(tokenBody.deviceToken.token).toEqual(expect.stringMatching(/^agt_device_/));
    expect(tokenBody.deviceToken.tokenHash).toBeUndefined();
    expect(store.createdDeviceTokens).toEqual([
      expect.not.objectContaining({ token: expect.any(String) }),
    ]);

    const inviteResponse = await postJson(`${baseUrl}/api/organizations/${orgBody.organization.id}/invitations`, {
      email: "member@gaoding.com",
      role: "member",
    }, ownerCookie);
    expect(inviteResponse.status).toBe(201);
    await postJson(`${baseUrl}/api/auth/email-code`, { email: "member@gaoding.com" });
    const memberLogin = await postJson(`${baseUrl}/api/auth/login`, { email: "member@gaoding.com", code: "246810" });
    const memberCookie = memberLogin.headers.get("set-cookie") ?? "";
    const acceptResponse = await postJson(`${baseUrl}/api/invitations/invite-token/accept`, {}, memberCookie);
    expect(acceptResponse.status).toBe(200);

    const forbiddenTokenResponse = await postJson(`${baseUrl}/api/organizations/${orgBody.organization.id}/device-tokens`, {
      name: "Member collector",
    }, memberCookie);

    expect(forbiddenTokenResponse.status).toBe(403);
  });

  it("returns a readable message when the email provider is unavailable", async () => {
    const store = new MemoryAuthStore();
    const handler = createAuthHttpApiHandler({
      createLoginCode: () => "246810",
      emailProvider: {
        sendLoginCode: async () => {
          throw new Error("email_provider_not_configured");
        },
      },
      now: () => new Date("2026-05-12T10:00:00.000Z"),
      pepper: "test-pepper",
      store,
    });
    const server = createServer((request, response) => {
      void handler(request, response, () => {
        response.statusCode = 404;
        response.end("not found");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const response = await postJson(`http://127.0.0.1:${address.port}/api/auth/email-code`, {
      email: "zhangliang@gaoding.com",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "email_provider_unavailable",
      message: "验证码暂时无法发送，请确认邮件服务已配置后重试。",
    });
  });
});

async function startAuthApi(store: AuthStore, sentCodes: Array<{ code: string; email: string }>) {
  const handler = createAuthHttpApiHandler({
    createInvitationToken: () => "invite-token",
    createLoginCode: () => "246810",
    createSessionToken: () => `session-${sentCodes.length + 1}`,
    emailProvider: {
      sendLoginCode: async ({ code, email }) => {
        sentCodes.push({ code, email });
      },
    },
    now: () => new Date("2026-05-12T10:00:00.000Z"),
    pepper: "test-pepper",
    store,
  });
  const server = createServer((request, response) => {
    void handler(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function postJson(url: string, payload: unknown, cookie?: string): Promise<Response> {
  return fetch(url, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    method: "POST",
  });
}

class MemoryAuthStore implements AuthStore {
  private codeCounter = 0;
  private invitationCounter = 0;
  private organizationCounter = 0;
  private sessionCounter = 0;
  private userCounter = 0;
  private readonly codes: AuthLoginCode[] = [];
  private readonly invitations: Array<{
    acceptedAt?: Date;
    email: string;
    expiresAt: Date;
    id: string;
    invitedByUserId: string;
    organizationId: string;
    role: AuthMemberRole;
    tokenHash: string;
  }> = [];
  private readonly memberships: AuthOrganizationMembership[] = [];
  private readonly organizations: Array<{ createdByUserId: string; id: string; name: string; slug: string }> = [];
  private readonly sessions: Array<{ expiresAt: Date; id: string; revokedAt?: Date; sessionHash: string; userId: string }> = [];
  private readonly users: AuthUser[] = [];
  readonly createdDeviceTokens: AuthDeviceTokenVerification[] = [];

  async createLoginCode(input: { codeHash: string; email: string; expiresAt: Date }): Promise<AuthLoginCode> {
    const code = {
      attempts: 0,
      codeHash: input.codeHash,
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      email: normalizeEmail(input.email),
      expiresAt: input.expiresAt,
      id: `code-${++this.codeCounter}`,
    };
    this.codes.push(code);
    return code;
  }

  async consumeLoginCode(input: { codeHash: string; email: string; now: Date }): Promise<AuthLoginCode | null> {
    const code = this.codes.find((item) =>
      item.email === normalizeEmail(input.email)
      && item.codeHash === input.codeHash
      && !item.consumedAt
      && item.expiresAt > input.now
    );
    if (!code) return null;
    code.consumedAt = input.now;
    return code;
  }

  async upsertUserForEmail(email: string): Promise<AuthUser> {
    const normalized = normalizeEmail(email);
    const existing = this.users.find((user) => user.email === normalized);
    if (existing) return existing;
    const user = {
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
      email: normalized,
      id: `user-${++this.userCounter}`,
      updatedAt: new Date("2026-05-12T10:00:00.000Z"),
    };
    this.users.push(user);
    return user;
  }

  async createSession(input: { expiresAt: Date; sessionHash: string; userId: string }) {
    const session = { ...input, createdAt: new Date("2026-05-12T10:00:00.000Z"), id: `session-${++this.sessionCounter}` };
    this.sessions.push(session);
    return session;
  }

  async readSessionByHash(sessionHash: string, now: Date): Promise<AuthSessionContext | null> {
    const session = this.sessions.find((item) => item.sessionHash === sessionHash && !item.revokedAt && item.expiresAt > now);
    const user = session ? this.users.find((item) => item.id === session.userId) : undefined;
    if (!session || !user) return null;
    return { id: session.id, organizations: await this.listOrganizationsForUser(user.id), user };
  }

  async revokeSession(sessionHash: string): Promise<void> {
    const session = this.sessions.find((item) => item.sessionHash === sessionHash);
    if (session) session.revokedAt = new Date("2026-05-12T10:00:00.000Z");
  }

  async createOrganization(input: { createdByUserId: string; name: string; slug: string }) {
    const organization = { ...input, id: `org-${++this.organizationCounter}` };
    this.organizations.push(organization);
    this.linkUserToOrganization(input.createdByUserId, organization.id);
    const membership = { id: `${organization.id}:owner`, name: input.name, organizationId: organization.id, role: "owner" as const, slug: input.slug };
    this.memberships.push(membership);
    this.membershipUserIds.set(membership.id, input.createdByUserId);
    return organization;
  }

  async listOrganizationsForUser(userId: string): Promise<AuthOrganizationMembership[]> {
    return this.memberships.filter((membership) => this.membershipUserIds.get(membership.id) === userId);
  }

  async listOrganizationAdminUserIds(organizationId: string): Promise<string[]> {
    const adminRoles = new Set<AuthMemberRole>(["owner", "admin"]);
    return this.memberships
      .filter((membership) => membership.organizationId === organizationId && adminRoles.has(membership.role))
      .map((membership) => this.membershipUserIds.get(membership.id) ?? "")
      .filter(Boolean);
  }

  async createInvitation(input: {
    email: string;
    expiresAt: Date;
    invitedByUserId: string;
    organizationId: string;
    role: AuthMemberRole;
    tokenHash: string;
  }) {
    const invitation = { ...input, email: normalizeEmail(input.email), id: `invitation-${++this.invitationCounter}` };
    this.invitations.push(invitation);
    return invitation;
  }

  async acceptInvitation(input: { email: string; now: Date; tokenHash: string; userId: string }) {
    const invitation = this.invitations.find((item) =>
      item.tokenHash === input.tokenHash
      && item.email === normalizeEmail(input.email)
      && !item.acceptedAt
      && item.expiresAt > input.now
    );
    if (!invitation) return null;
    invitation.acceptedAt = input.now;
    const organization = this.organizations.find((item) => item.id === invitation.organizationId);
    if (!organization) return null;
    this.linkUserToOrganization(input.userId, invitation.organizationId);
    const membership = {
      id: `${invitation.organizationId}:${input.userId}`,
      name: organization.name,
      organizationId: organization.id,
      role: invitation.role,
      slug: organization.slug,
    };
    this.memberships.push(membership);
    this.membershipUserIds.set(membership.id, input.userId);
    return membership;
  }

  async createDeviceToken(input: {
    deviceId?: string | null;
    name: string;
    organizationId: string;
    tokenHash: string;
    tokenPrefix: string;
  }): Promise<AuthDeviceTokenVerification> {
    const token = {
      deviceId: input.deviceId ?? null,
      id: `devtok-${this.createdDeviceTokens.length + 1}`,
      organizationId: input.organizationId,
      tokenPrefix: input.tokenPrefix,
    };
    this.createdDeviceTokens.push(token);
    return token;
  }

  async verifyDeviceToken(): Promise<AuthDeviceTokenVerification | null> {
    throw new Error("not needed by HTTP unit tests");
  }

  async close(): Promise<void> {}

  private readonly membershipUserIds = new Map<string, string>();

  private linkUserToOrganization(_userId: string, _organizationId: string): void {
    // Membership rows carry their user mapping through membershipUserIds.
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
