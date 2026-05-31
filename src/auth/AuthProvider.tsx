import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthInvitationPreview, AuthOrganizationMembership, AuthSessionContext } from "./auth-store";
import { createAuthClient, type AuthClient } from "./auth-client";
import { CreateOrganizationPage } from "./CreateOrganizationPage";
import { InviteJoinPage } from "./InviteJoinPage";
import { LoginPage } from "./LoginPage";
import { VerifyCodePage } from "./VerifyCodePage";
import { AuthPageShell } from "./AuthPageShell";
import { Button } from "@/components/ui/button";

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
  const [invitePreview, setInvitePreview] = useState<AuthInvitationPreview | null>(null);
  const [isInvitePreviewLoading, setIsInvitePreviewLoading] = useState(Boolean(inviteToken));
  const [autoCodeRequestedInviteToken, setAutoCodeRequestedInviteToken] = useState<string | null>(null);
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

  useEffect(() => {
    if (!inviteToken) {
      setInvitePreview(null);
      setIsInvitePreviewLoading(false);
      return;
    }
    if (isLoading) return;
    let isMounted = true;
    setIsInvitePreviewLoading(true);
    authClient
      .getInvitationPreview(inviteToken)
      .then(async (preview) => {
        if (!isMounted) return;
        setInvitePreview(preview);
        if (
          !session
          && preview.status === "available"
          && preview.email
          && autoCodeRequestedInviteToken !== inviteToken
        ) {
          setAutoCodeRequestedInviteToken(inviteToken);
          const result = await authClient.requestEmailCode(preview.email);
          if (!isMounted) return;
          setEmailForCode(result.email);
        }
      })
      .catch((nextError: unknown) => {
        if (isMounted) setError(formatAuthError(nextError));
      })
      .finally(() => {
        if (isMounted) setIsInvitePreviewLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [authClient, autoCodeRequestedInviteToken, inviteToken, isLoading, session]);

  const context = useMemo<AuthContextValue | null>(() => {
    if (!session) return null;
    return {
      async logout() {
        await authClient.logout();
        setSession(null);
        setEmailForCode("");
        navigateToPublicHome();
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
    if (inviteToken && isInvitePreviewLoading && !emailForCode) {
      return (
        <AuthPageShell title="确认邀请" subtitle="正在读取邀请信息，并准备邮箱验证码。">
          <p className="text-sm leading-6 text-muted-foreground">加载中...</p>
        </AuthPageShell>
      );
    }

    if (inviteToken && invitePreview && invitePreview.status !== "available") {
      return (
        <InvitationStatusPage
          error={error}
          preview={invitePreview}
          onBack={() => {
            setError(null);
            clearInviteRoute();
            setInviteToken(null);
          }}
        />
      );
    }

    if (emailForCode) {
      return (
        <VerifyCodePage
          displayEmail={invitePreview?.maskedEmail}
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
        preview={invitePreview}
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

function InvitationStatusPage({
  error,
  onBack,
  preview,
}: {
  error?: string | null;
  onBack: () => void;
  preview: AuthInvitationPreview;
}) {
  return (
    <AuthPageShell
      title="邀请不可用"
      subtitle={invitationStatusDescription(preview)}
      preview={null}
      notice="如需加入组织，请联系组织管理员重新发送邀请。"
    >
      <Button type="button" onClick={onBack}>返回登录</Button>
      {error ? (
        <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </AuthPageShell>
  );
}

function invitationStatusDescription(preview: AuthInvitationPreview): string {
  const organizationName = preview.organizationName ? `${preview.organizationName} 的` : "";
  if (preview.status === "accepted") return `${organizationName}邀请已经被接受。`;
  if (preview.status === "expired") return `${organizationName}邀请已经过期。`;
  if (preview.status === "revoked") return `${organizationName}邀请已经被撤销。`;
  return "邀请链接无效或不存在。";
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

function navigateToPublicHome() {
  if (window.location.pathname !== "/" || window.location.search) {
    window.history.replaceState({}, "", "/");
  }
  window.dispatchEvent(createPopStateEvent());
}

function createPopStateEvent(): Event {
  return typeof PopStateEvent === "function" ? new PopStateEvent("popstate") : new Event("popstate");
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
