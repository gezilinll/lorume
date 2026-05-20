import type { IncomingMessage, ServerResponse } from "node:http";
import { createNumericCode, createSecretToken, hashSecret } from "./auth-crypto";
import type {
  AuthDeviceTokenVerification,
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
  verifyDeviceTokenValue: (token: string) => Promise<AuthDeviceTokenVerification | null>;
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
      sendJson(response, 200, {
        id: session.id,
        organizations: await options.store.listOrganizationsForUser(user.id),
        user,
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
      const sessionToken = readSessionToken(request);
      if (sessionToken) {
        await options.store.revokeSession(hashSecret(sessionToken, "session-token", pepper));
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
      const role = normalizeRole(readString(body, "role"));
      if (!email || !role) {
        sendAuthError(response, 400, "invitation_email_and_role_required");
        return;
      }
      const token = createInvitationToken();
      const invitation = await options.store.createInvitation({
        email,
        expiresAt: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000),
        invitedByUserId: session.user.id,
        organizationId,
        role,
        tokenHash: hashSecret(token, "invitation-token", pepper),
      });
      sendJson(response, 201, {
        invitation: { ...invitation, token },
      });
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
        sendAuthError(response, 403, "invitation_not_available");
        return;
      }
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
        tokenHash: hashSecret(token, "device-token", pepper),
        tokenPrefix,
      });
      sendJson(response, 201, { deviceToken: { ...deviceToken, token } });
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
    verifyDeviceTokenValue(token) {
      return verifyDeviceTokenValue(store, token, now(), options.pepper);
    },
  };
}

function verifyDeviceTokenValue(
  store: AuthStore,
  token: string,
  now: Date,
  pepper?: string,
): Promise<AuthDeviceTokenVerification | null> {
  if (!token.trim()) return Promise.resolve(null);
  return store.verifyDeviceToken(hashSecret(token, "device-token", pepper), now);
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

function normalizeRole(value: string): AuthMemberRole | null {
  if (value === "owner" || value === "admin" || value === "member") return value;
  return null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
