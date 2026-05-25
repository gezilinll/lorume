import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthOrganizationMembership, AuthSessionContext } from "./auth-store";
import { createAuthClient, type AuthClient } from "./auth-client";
import { CreateOrganizationPage } from "./CreateOrganizationPage";
import { InviteJoinPage } from "./InviteJoinPage";
import { LoginPage } from "./LoginPage";
import { VerifyCodePage } from "./VerifyCodePage";
import { AuthPageShell } from "./AuthPageShell";

export interface AuthContextValue {
  logout: () => Promise<void>;
  session: AuthSessionContext;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthSessionProvider({ children, value }: { children: ReactNode; value: AuthContextValue }) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

interface AuthProviderProps {
  children: ReactNode;
  client?: AuthClient;
}

/** Session gate for the Lorume console. */
export function AuthProvider({ children, client }: AuthProviderProps) {
  const authClient = useMemo(() => client ?? createAuthClient(), [client]);
  const [session, setSession] = useState<AuthSessionContext | null>(null);
  const [emailForCode, setEmailForCode] = useState("");
  const [inviteToken, setInviteToken] = useState(readInviteToken());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    authClient
      .getMe()
      .then((nextSession) => {
        if (isMounted) setSession(nextSession);
      })
      .catch((nextError: unknown) => {
        if (isMounted) {
          setError(formatAuthError(nextError));
        }
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [authClient]);

  const context = useMemo<AuthContextValue | null>(() => {
    if (!session) return null;
    return {
      async logout() {
        await authClient.logout();
        setSession(null);
        setEmailForCode("");
      },
      session,
    };
  }, [authClient, session]);

  if (isLoading) {
    return (
      <AuthPageShell title="连接 Lorume" subtitle="正在确认当前会话，请稍等片刻。">
        <p className="text-sm leading-6 text-muted-foreground">加载中...</p>
      </AuthPageShell>
    );
  }

  if (!session) {
    if (emailForCode) {
      return (
        <VerifyCodePage
          email={emailForCode}
          error={error}
          onBack={() => {
            setError(null);
            setEmailForCode("");
          }}
          onSubmit={async (code) => {
            setError(null);
            try {
              setSession(await authClient.loginWithCode({ code, email: emailForCode }));
            } catch (nextError) {
              setError(formatAuthError(nextError));
            }
          }}
        />
      );
    }

    return (
      <LoginPage
        error={error}
        onSubmit={async (email) => {
          setError(null);
          try {
            const result = await authClient.requestEmailCode(email);
            setEmailForCode(result.email);
          } catch (nextError) {
            setError(formatAuthError(nextError));
          }
        }}
      />
    );
  }

  if (inviteToken) {
    return (
      <InviteJoinPage
        error={error}
        session={session}
        onSkip={() => {
          setError(null);
          clearInviteRoute();
          setInviteToken(null);
        }}
        onSubmit={async () => {
          setError(null);
          try {
            const result = await authClient.acceptInvitation(inviteToken);
            clearInviteRoute();
            setInviteToken(null);
            setSession(addOrganizationToSession(session, result.organization));
          } catch (nextError) {
            setError(formatAuthError(nextError));
          }
        }}
      />
    );
  }

  if (session.organizations.length === 0) {
    return (
      <CreateOrganizationPage
        error={error}
        onSubmit={async (input) => {
          setError(null);
          try {
            const result = await authClient.createOrganization(input);
            setSession({ ...session, organizations: result.organizations });
          } catch (nextError) {
            setError(formatAuthError(nextError));
          }
        }}
      />
    );
  }

  return <AuthContext.Provider value={context}>{children}</AuthContext.Provider>;
}

/** Optional session hook used by shell actions that disappear when auth is disabled. */
export function useOptionalAuthSession(): AuthContextValue | null {
  return useContext(AuthContext);
}

function readInviteToken(): string | null {
  const invitePathMatch = window.location.pathname.match(/^\/invite\/([^/]+)$/);
  if (invitePathMatch?.[1]) return decodeURIComponent(invitePathMatch[1]);
  const inviteQueryToken = new URLSearchParams(window.location.search).get("invite");
  return inviteQueryToken?.trim() || null;
}

function clearInviteRoute() {
  if (window.location.pathname.startsWith("/invite/") || window.location.search.includes("invite=")) {
    window.history.replaceState({}, "", "/");
  }
}

function addOrganizationToSession(
  session: AuthSessionContext,
  organization: AuthOrganizationMembership,
): AuthSessionContext {
  if (session.organizations.some((item) => item.organizationId === organization.organizationId)) return session;
  return { ...session, organizations: [...session.organizations, organization] };
}

function formatAuthError(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}
