import type { IncomingMessage, ServerResponse } from "node:http";
import { createNumericCode, createSecretToken, decryptSecret, encryptSecret, hashSecret } from "./auth-crypto";
import type {
  AuthAuditEventType,
  AuthDeviceTokenVerification,
  AuthInvitableMemberRole,
  AuthMemberRole,
  AuthSessionContext,
  AuthStore,
} from "./auth-store";
import { authErrorMessage } from "./auth-errors";

const maxJsonBodyChars = 1_000_000;
const sessionCookieName = "lorume_session";

/** Email provider contract for login codes. */
export interface AuthEmailProvider {
  sendLoginCode: (input: { code: string; email: string }) => Promise<void>;
  sendOrganizationInvitation: (input: {
    email: string;
    expiresAt: Date | null;
    inviteUrl: string;
    organizationName: string;
    role: AuthInvitableMemberRole;
  }) => Promise<void>;
}

/** Dependencies for the auth HTTP API. */
export interface AuthHttpApiHandlerOptions {
  createInvitationToken?: () => string;
  createLoginCode?: () => string;
  createSessionToken?: () => string;
  emailProvider: AuthEmailProvider;
  now?: () => Date;
  pepper?: string;
  store: AuthStore;
}

/** Auth API middleware compatible with the backend runtime API shape. */
export type AuthHttpApiHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => Promise<void>;

/** Runtime API guard functions derived from auth sessions and device tokens. */
export interface AuthRuntimeGuards {
  requireDeviceToken: (request: IncomingMessage) => Promise<AuthDeviceTokenVerification | null>;
  requireUserSession: (request: IncomingMessage) => Promise<AuthSessionContext | null>;
  verifyDeviceTokenValue: (token: string, deviceId?: string | null) => Promise<AuthDeviceTokenVerification | null>;
}

/** Create auth routes for login, organization management, invitations, and logout. */
export function createAuthHttpApiHandler(options: AuthHttpApiHandlerOptions): AuthHttpApiHandler {
  const now = options.now ?? (() => new Date());
  const pepper = options.pepper;
  const createLoginCode = options.createLoginCode ?? (() => createNumericCode({ length: 6 }));
  const createSessionToken = options.createSessionToken ?? (() => createSecretToken("agt_ses"));
  const createInvitationToken = options.createInvitationToken ?? (() => createSecretToken("agt_inv"));

  return async function authHttpApiHandler(request, response, next) {
    const requestUrl = new URL(request.url || "/", "http://lorume.local");

    if (request.method === "POST" && requestUrl.pathname === "/api/auth/email-code") {
      const body = await readJsonBody(request);
      const email = normalizeEmail(readString(body, "email"));
      if (!email) {
        sendAuthError(response, 400, "email_required");
        return;
      }
      const code = createLoginCode();
      await options.store.createLoginCode({
        codeHash: hashSecret(code, "login-code", pepper),
        email,
        expiresAt: new Date(now().getTime() + 10 * 60 * 1000),
      });
      try {
        await options.emailProvider.sendLoginCode({ code, email });
      } catch (error) {
        sendAuthError(response, 503, "email_provider_unavailable");
        return;
      }
      sendJson(response, 202, { ok: true, email });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      const email = normalizeEmail(readString(body, "email"));
      const code = readString(body, "code").trim();
      if (!email || !code) {
        sendAuthError(response, 400, "email_and_code_required");
        return;
      }
      const consumedCode = await options.store.consumeLoginCode({
        codeHash: hashSecret(code, "login-code", pepper),
        email,
        now: now(),
      });
      if (!consumedCode) {
        await options.store.createAuditEvent({
          eventType: "auth.login_failed",
          metadata: { email: maskEmail(email), reason: "invalid_or_expired_code" },
        });
        sendAuthError(response, 401, "invalid_or_expired_code");
        return;
      }
      const user = await options.store.upsertUserForEmail(email);
      const sessionToken = createSessionToken();
      const sessionHash = hashSecret(sessionToken, "session-token", pepper);
      const session = await options.store.createSession({
        expiresAt: new Date(now().getTime() + 30 * 24 * 60 * 60 * 1000),
        sessionHash,
        userId: user.id,
      });
      setSessionCookie(response, sessionToken, 30 * 24 * 60 * 60);
      await options.store.createAuditEvent({
        actorUserId: user.id,
        eventType: "auth.login_succeeded",
        metadata: { email: maskEmail(email) },
      });
      sendJson(response, 200, {
        id: session.id,
        organizations: await options.store.listOrganizationsForUser(user.id),
        user,
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
      const sessionToken = readSessionToken(request);
      const session = sessionToken ? await options.store.readSessionByHash(hashSecret(sessionToken, "session-token", pepper), now()) : null;
      if (sessionToken) {
        await options.store.revokeSession(hashSecret(sessionToken, "session-token", pepper));
      }
      if (session) {
        await options.store.createAuditEvent({
          actorUserId: session.user.id,
          eventType: "auth.logout",
          metadata: { email: maskEmail(session.user.email) },
        });
      }
      setSessionCookie(response, "", 0);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/me") {
      const session = await readSessionContext(request, options.store, now(), pepper);
      if (!session) {
        sendAuthError(response, 401, "unauthorized");
        return;
      }
      sendJson(response, 200, session);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/organizations") {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      sendJson(response, 200, { organizations: session.organizations });
      return;
    }

    const organizationMembersMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/members$/);
    if (request.method === "GET" && organizationMembersMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(organizationMembersMatch[1] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      sendJson(response, 200, {
        members: await options.store.listOrganizationMembers({ organizationId }),
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/organizations") {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const body = await readJsonBody(request);
      const name = readString(body, "name").trim();
      const slug = readString(body, "slug").trim() || slugify(name);
      if (!name || !slug) {
        sendAuthError(response, 400, "organization_name_required");
        return;
      }
      const organization = await options.store.createOrganization({
        createdByUserId: session.user.id,
        name,
        slug,
      });
      sendJson(response, 201, {
        organization,
        organizations: await options.store.listOrganizationsForUser(session.user.id),
      });
      return;
    }

    const invitationCreateMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/invitations$/);
    if (request.method === "GET" && invitationCreateMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(invitationCreateMatch[1] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      sendJson(response, 200, {
        invitations: await options.store.listOrganizationInvitations({ now: now(), organizationId }),
      });
      return;
    }

    if (request.method === "POST" && invitationCreateMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(invitationCreateMatch[1] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      const body = await readJsonBody(request);
      const email = normalizeEmail(readString(body, "email"));
      const rawRole = readString(body, "role").trim();
      const role = normalizeInvitableRole(rawRole);
      const expiresAt = resolveInvitationExpiresAt(readString(body, "expiresIn"), now());
      if (!email || !rawRole) {
        sendAuthError(response, 400, "invitation_email_and_role_required");
        return;
      }
      if (!role) {
        sendAuthError(response, 400, "invitation_role_not_allowed");
        return;
      }
      const token = createInvitationToken();
      const invitation = await options.store.createInvitation({
        email,
        expiresAt,
        invitedByUserId: session.user.id,
        organizationId,
        role,
        tokenHash: hashSecret(token, "invitation-token", pepper),
      });
      const inviteUrl = `${originFromRequest(request)}/invite/${encodeURIComponent(token)}`;
      try {
        await options.emailProvider.sendOrganizationInvitation({
          email,
          expiresAt,
          inviteUrl,
          organizationName: membership.name,
          role,
        });
      } catch (error) {
        await options.store.revokeInvitation({ id: invitation.id, now: now() });
        sendAuthError(response, 503, "email_provider_unavailable");
        return;
      }
      await options.store.createAuditEvent({
        actorUserId: session.user.id,
        eventType: "invitation.sent",
        metadata: {
          email: maskEmail(email),
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          role,
        },
        organizationId,
        targetId: invitation.id,
        targetType: "invitation",
      });
      sendJson(response, 201, {
        invitation,
      });
      return;
    }

    const invitationResendMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/invitations\/([^/]+)\/resend$/);
    if (request.method === "POST" && invitationResendMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(invitationResendMatch[1] ?? "");
      const invitationId = decodeURIComponent(invitationResendMatch[2] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      const previousInvitation = await options.store.readOrganizationInvitation({
        id: invitationId,
        now: now(),
        organizationId,
      });
      if (!previousInvitation) {
        sendAuthError(response, 404, "invitation_not_found");
        return;
      }
      if (previousInvitation.status === "accepted") {
        sendAuthError(response, 409, "invitation_not_resendable");
        return;
      }
      const role = normalizeInvitableRole(previousInvitation.role);
      if (!role) {
        sendAuthError(response, 400, "invitation_role_not_allowed");
        return;
      }
      const token = createInvitationToken();
      const expiresAt = resolveResentInvitationExpiresAt(previousInvitation, now());
      const invitation = await options.store.createInvitation({
        email: previousInvitation.email,
        expiresAt,
        invitedByUserId: session.user.id,
        organizationId,
        role,
        tokenHash: hashSecret(token, "invitation-token", pepper),
      });
      const inviteUrl = `${originFromRequest(request)}/invite/${encodeURIComponent(token)}`;
      try {
        await options.emailProvider.sendOrganizationInvitation({
          email: previousInvitation.email,
          expiresAt,
          inviteUrl,
          organizationName: membership.name,
          role,
        });
      } catch (error) {
        await options.store.revokeInvitation({ id: invitation.id, now: now() });
        sendAuthError(response, 503, "email_provider_unavailable");
        return;
      }
      await options.store.revokeInvitation({ id: previousInvitation.id, now: now() });
      await options.store.createAuditEvent({
        actorUserId: session.user.id,
        eventType: "invitation.sent",
        metadata: {
          email: maskEmail(previousInvitation.email),
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          resendOf: previousInvitation.id,
          role,
        },
        organizationId,
        targetId: invitation.id,
        targetType: "invitation",
      });
      sendJson(response, 200, {
        invitation: await options.store.readOrganizationInvitation({
          id: invitation.id,
          now: now(),
          organizationId,
        }),
      });
      return;
    }

    const invitationRevokeMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/invitations\/([^/]+)\/revoke$/);
    if (request.method === "POST" && invitationRevokeMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(invitationRevokeMatch[1] ?? "");
      const invitationId = decodeURIComponent(invitationRevokeMatch[2] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      const invitation = await options.store.readOrganizationInvitation({
        id: invitationId,
        now: now(),
        organizationId,
      });
      if (!invitation) {
        sendAuthError(response, 404, "invitation_not_found");
        return;
      }
      if (invitation.status === "accepted") {
        sendAuthError(response, 409, "invitation_not_revocable");
        return;
      }
      await options.store.revokeInvitation({ id: invitationId, now: now() });
      await options.store.createAuditEvent({
        actorUserId: session.user.id,
        eventType: "invitation.rejected",
        metadata: { email: maskEmail(invitation.email), reason: "revoked_by_admin" },
        organizationId,
        targetId: invitationId,
        targetType: "invitation",
      });
      sendJson(response, 200, {
        invitation: await options.store.readOrganizationInvitation({
          id: invitationId,
          now: now(),
          organizationId,
        }),
      });
      return;
    }

    const invitationPreviewMatch = requestUrl.pathname.match(/^\/api\/invitations\/([^/]+)\/preview$/);
    if (request.method === "GET" && invitationPreviewMatch) {
      const token = decodeURIComponent(invitationPreviewMatch[1] ?? "");
      const invitation = await options.store.readInvitationPreview({
        now: now(),
        tokenHash: hashSecret(token, "invitation-token", pepper),
      });
      sendJson(response, 200, { invitation });
      return;
    }

    const invitationAcceptMatch = requestUrl.pathname.match(/^\/api\/invitations\/([^/]+)\/accept$/);
    if (request.method === "POST" && invitationAcceptMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const token = decodeURIComponent(invitationAcceptMatch[1] ?? "");
      const organization = await options.store.acceptInvitation({
        email: session.user.email,
        now: now(),
        tokenHash: hashSecret(token, "invitation-token", pepper),
        userId: session.user.id,
      });
      if (!organization) {
        await options.store.createAuditEvent({
          actorUserId: session.user.id,
          eventType: "invitation.rejected",
          metadata: { email: maskEmail(session.user.email), reason: "invitation_not_available" },
        });
        sendAuthError(response, 403, "invitation_not_available");
        return;
      }
      await options.store.createAuditEvent({
        actorUserId: session.user.id,
        eventType: "invitation.accepted",
        metadata: {
          email: maskEmail(session.user.email),
          role: organization.role,
        },
        organizationId: organization.organizationId,
        targetType: "invitation",
      });
      sendJson(response, 200, { organization });
      return;
    }

    const deviceTokenCreateMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/device-tokens$/);
    if (request.method === "POST" && deviceTokenCreateMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(deviceTokenCreateMatch[1] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      const body = await readJsonBody(request);
      const name = readString(body, "name").trim() || "Device collector";
      const deviceId = readString(body, "deviceId").trim() || null;
      const token = createSecretToken("agt_device");
      const tokenPrefix = token.slice(0, 12);
      const deviceToken = await options.store.createDeviceToken({
        deviceId,
        name,
        organizationId,
        tokenCiphertext: encryptSecret(token, "device-token", pepper),
        tokenHash: hashSecret(token, "device-token", pepper),
        tokenPrefix,
      });
      await options.store.createAuditEvent({
        actorUserId: session.user.id,
        eventType: "device_token.created",
        metadata: {
          deviceId,
          tokenPrefix,
        },
        organizationId,
        targetId: deviceToken.id,
        targetType: "device_token",
      });
      sendJson(response, 201, {
        deviceToken: { ...deviceToken, token },
        installCommand: buildInstallCommand({
          deviceId: deviceToken.deviceId || name,
          origin: originFromRequest(request),
          token,
        }),
      });
      return;
    }

    const deviceTokenListMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/device-tokens$/);
    if (request.method === "GET" && deviceTokenListMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(deviceTokenListMatch[1] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      sendJson(response, 200, {
        deviceTokens: await options.store.listDeviceTokens({ now: now(), organizationId }),
      });
      return;
    }

    const deviceTokenInstallCommandMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/device-tokens\/([^/]+)\/install-command$/);
    if (request.method === "GET" && deviceTokenInstallCommandMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(deviceTokenInstallCommandMatch[1] ?? "");
      const tokenId = decodeURIComponent(deviceTokenInstallCommandMatch[2] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      const payload = await options.store.readDeviceTokenInstallSecret({
        id: tokenId,
        now: now(),
        organizationId,
      });
      if (!payload) {
        sendAuthError(response, 404, "device_token_not_found");
        return;
      }
      if (payload.deviceToken.status === "revoked" || payload.deviceToken.status === "expired") {
        sendAuthError(response, 409, "device_token_not_installable");
        return;
      }
      if (!payload.tokenCiphertext) {
        sendAuthError(response, 409, "device_token_secret_unavailable");
        return;
      }
      let token: string;
      try {
        token = decryptSecret(payload.tokenCiphertext, "device-token", pepper);
      } catch {
        sendAuthError(response, 409, "device_token_secret_unavailable");
        return;
      }
      sendJson(response, 200, {
        installCommand: buildInstallCommand({
          deviceId: payload.deviceToken.deviceId || payload.deviceToken.name,
          origin: originFromRequest(request),
          token,
        }),
      });
      return;
    }

    const deviceTokenRevokeMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/device-tokens\/([^/]+)\/revoke$/);
    if (request.method === "POST" && deviceTokenRevokeMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(deviceTokenRevokeMatch[1] ?? "");
      const tokenId = decodeURIComponent(deviceTokenRevokeMatch[2] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      const body = await readJsonBody(request);
      const deviceToken = await options.store.revokeDeviceToken({
        actorUserId: session.user.id,
        id: tokenId,
        now: now(),
        organizationId,
        reason: readString(body, "reason").trim() || "manual",
      });
      if (!deviceToken) {
        sendAuthError(response, 404, "device_token_not_found");
        return;
      }
      sendJson(response, 200, { deviceToken });
      return;
    }

    const auditEventsMatch = requestUrl.pathname.match(/^\/api\/organizations\/([^/]+)\/audit-events$/);
    if (request.method === "GET" && auditEventsMatch) {
      const session = await requireSession(request, response, options.store, now(), pepper);
      if (!session) return;
      const organizationId = decodeURIComponent(auditEventsMatch[1] ?? "");
      const membership = session.organizations.find((item) => item.organizationId === organizationId);
      if (!membership || !canManageOrganization(membership.role)) {
        sendAuthError(response, 403, "forbidden");
        return;
      }
      sendJson(response, 200, {
        auditEvents: await options.store.listAuditEvents({
          eventType: normalizeAuditEventType(requestUrl.searchParams.get("eventType") ?? ""),
          limit: parseLimit(requestUrl.searchParams.get("limit")),
          organizationId,
        }),
      });
      return;
    }

    next();
  };
}

/** Create guards that protect runtime APIs using auth sessions and device tokens. */
export function createAuthRuntimeGuards(
  store: AuthStore,
  options: { now?: () => Date; pepper?: string } = {},
): AuthRuntimeGuards {
  const now = options.now ?? (() => new Date());
  return {
    requireDeviceToken(request) {
      const token = readBearerToken(request);
      if (!token) return Promise.resolve(null);
      return verifyDeviceTokenValue(store, token, now(), options.pepper);
    },
    requireUserSession(request) {
      return readSessionContext(request, store, now(), options.pepper);
    },
    verifyDeviceTokenValue(token, deviceId) {
      return verifyDeviceTokenValue(store, token, now(), options.pepper, deviceId);
    },
  };
}

function verifyDeviceTokenValue(
  store: AuthStore,
  token: string,
  now: Date,
  pepper?: string,
  deviceId?: string | null,
): Promise<AuthDeviceTokenVerification | null> {
  if (!token.trim()) return Promise.resolve(null);
  return store.verifyDeviceToken(hashSecret(token, "device-token", pepper), now, deviceId);
}

async function requireSession(
  request: IncomingMessage,
  response: ServerResponse,
  store: AuthStore,
  now: Date,
  pepper?: string,
): Promise<AuthSessionContext | null> {
  const session = await readSessionContext(request, store, now, pepper);
  if (!session) {
    sendAuthError(response, 401, "unauthorized");
    return null;
  }
  return session;
}

async function readSessionContext(
  request: IncomingMessage,
  store: AuthStore,
  now: Date,
  pepper?: string,
): Promise<AuthSessionContext | null> {
  const sessionToken = readSessionToken(request);
  if (!sessionToken) return null;
  return store.readSessionByHash(hashSecret(sessionToken, "session-token", pepper), now);
}

function readBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || null;
  }
  return null;
}

function readSessionToken(request: IncomingMessage): string | null {
  const cookies = parseCookies(request.headers.cookie);
  return cookies.get(sessionCookieName) ?? null;
}

function parseCookies(cookieHeader: string | string[] | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!raw) return cookies;
  for (const part of raw.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) continue;
    cookies.set(name, decodeURIComponent(valueParts.join("=")));
  }
  return cookies;
}

function setSessionCookie(response: ServerResponse, token: string, maxAgeSeconds: number): void {
  const encodedToken = encodeURIComponent(token);
  response.setHeader("set-cookie", `${sessionCookieName}=${encodedToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

function canManageOrganization(role: AuthMemberRole): boolean {
  return role === "owner" || role === "admin";
}

function normalizeInvitableRole(value: string): AuthInvitableMemberRole | null {
  if (value === "admin" || value === "member") return value;
  return null;
}

function resolveInvitationExpiresAt(value: string, now: Date): Date | null {
  const normalized = value.trim();
  if (normalized === "never") return null;
  const days = normalized === "1d" ? 1 : normalized === "30d" ? 30 : 7;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function resolveResentInvitationExpiresAt(
  previousInvitation: { createdAt: Date | string; expiresAt: Date | string | null },
  now: Date,
): Date | null {
  if (previousInvitation.expiresAt === null) return null;
  const createdAt = new Date(previousInvitation.createdAt).getTime();
  const expiresAt = new Date(previousInvitation.expiresAt).getTime();
  const defaultDuration = 7 * 24 * 60 * 60 * 1000;
  const duration = Number.isFinite(createdAt) && Number.isFinite(expiresAt) && expiresAt > createdAt
    ? expiresAt - createdAt
    : defaultDuration;
  return new Date(now.getTime() + duration);
}

function buildInstallCommand(input: { deviceId: string; origin: string; token: string }): string {
  const installerUrl = `${input.origin}/api/device-collector/install.sh`;
  return [
    `curl -fsSL ${shellQuote(installerUrl)} | bash -s --`,
    "--server-url",
    shellQuote(input.origin),
    "--device-id",
    shellQuote(input.deviceId),
    "--device-token",
    shellQuote(input.token),
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeAuditEventType(value: string): AuthAuditEventType | undefined {
  if (
    value === "auth.login_failed"
    || value === "auth.login_succeeded"
    || value === "auth.logout"
    || value === "device_token.created"
    || value === "device_token.occupied"
    || value === "device_token.reuse_rejected"
    || value === "device_token.revoked"
    || value === "invitation.accepted"
    || value === "invitation.rejected"
    || value === "invitation.sent"
  ) {
    return value;
  }
  return undefined;
}

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, 1), 200);
}

function originFromRequest(request: IncomingMessage): string {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.trim()) return origin.trim().replace(/\/+$/, "");
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" && forwardedProto.trim()
    ? forwardedProto.split(",")[0]?.trim() || "http"
    : "http";
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = typeof forwardedHost === "string" && forwardedHost.trim()
    ? forwardedHost.split(",")[0]?.trim()
    : request.headers.host;
  return `${proto}://${host || "lorume.local"}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = normalizeEmail(email).split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "organization";
}

function readString(body: unknown, key: string): string {
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxJsonBodyChars) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendAuthError(response: ServerResponse, statusCode: number, code: string): void {
  sendJson(response, statusCode, { error: code, message: authErrorMessage(code) });
}
