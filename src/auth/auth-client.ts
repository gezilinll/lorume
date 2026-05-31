import type { AuthInvitationPreview, AuthOrganizationMembership, AuthSessionContext } from "./auth-store";
import { authErrorMessage } from "./auth-errors";

/** Browser auth API client for email-code login, organization setup, invitations, and logout. */
export interface AuthClient {
  acceptInvitation: (token: string) => Promise<{ organization: AuthOrganizationMembership }>;
  createOrganization: (input: { name: string; slug: string }) => Promise<{ organizations: AuthOrganizationMembership[] }>;
  getInvitationPreview: (token: string) => Promise<AuthInvitationPreview>;
  getMe: () => Promise<AuthSessionContext | null>;
  loginWithCode: (input: { code: string; email: string }) => Promise<AuthSessionContext>;
  logout: () => Promise<void>;
  requestEmailCode: (email: string) => Promise<{ email: string; ok: boolean }>;
}

/** Create the default browser auth client backed by Lorume HTTP APIs. */
export function createAuthClient(): AuthClient {
  return {
    acceptInvitation(token) {
      return requestJson(`/api/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
    },
    createOrganization(input) {
      return requestJson("/api/organizations", {
        body: JSON.stringify({ name: input.name.trim(), slug: input.slug.trim() }),
        method: "POST",
      });
    },
    async getInvitationPreview(token) {
      const result = await requestJson<{ invitation: AuthInvitationPreview }>(`/api/invitations/${encodeURIComponent(token)}/preview`, {
        method: "GET",
      });
      return result.invitation;
    },
    async getMe() {
      const response = await fetch("/api/me", { credentials: "include" });
      if (response.status === 401 || response.status === 404) return null;
      if (!response.ok) throw new Error(await readErrorMessage(response));
      return response.json() as Promise<AuthSessionContext>;
    },
    loginWithCode(input) {
      return requestJson("/api/auth/login", {
        body: JSON.stringify({ code: input.code.trim(), email: normalizeEmail(input.email) }),
        method: "POST",
      });
    },
    async logout() {
      const response = await fetch("/api/auth/logout", {
        credentials: "include",
        method: "POST",
      });
      if (!response.ok && response.status !== 204) throw new Error(await readErrorMessage(response));
    },
    requestEmailCode(email) {
      return requestJson("/api/auth/email-code", {
        body: JSON.stringify({ email: normalizeEmail(email) }),
        method: "POST",
      });
    },
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return response.json() as Promise<T>;
}

async function readErrorMessage(response: Response): Promise<string> {
  if (response.status === 502 || response.status === 504) return authErrorMessage("auth_backend_unavailable");
  try {
    const body = await response.json();
    if (body && typeof body.message === "string") return body.message;
    if (body && typeof body.error === "string") return authErrorMessage(body.error);
  } catch {
    // Fall through to the status text.
  }
  if (response.status === 503) return authErrorMessage("auth_backend_unavailable");
  return response.statusText || authErrorMessage("request_failed");
}
