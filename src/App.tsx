import { useEffect, useState } from "react";
import type { LorumeAppMode } from "./app-mode";
import { AuthProvider, AuthSessionProvider, useOptionalAuthSession, type AuthContextValue } from "./auth/AuthProvider";
import { AppShell, type ConsolePageKey, type ConsoleUtilityKey } from "./components/layout/AppShell";
import {
  ConsoleUtilityBar,
  ConsoleUtilityDrawer,
  type ConsoleUtilityView,
} from "./console/ConsoleUtilityDrawer";
import { HomePage } from "./HomePage";
import { RuntimeFleetPage } from "./runtime/RuntimeFleetPage";
import { RuntimeWorkBoardPage } from "./runtime/RuntimeWorkBoardPage";
import { OrganizationSettingsPage } from "./settings/OrganizationSettingsPage";

type PageKey = ConsolePageKey;
type UtilityKey = ConsoleUtilityKey;

const pagePathByKey: Record<PageKey, string> = {
  runtime: "/runtime",
  runs: "/runs",
  settings: "/settings",
};

const utilityPathByView: Record<UtilityKey, string> = {
  notifications: "/notifications",
  operations: "/operations",
};

export function App({
  runtimeMode,
}: {
  runtimeMode?: LorumeAppMode;
}) {
  const mode = runtimeMode ?? "production";
  if (mode !== "agent" && getCurrentPath() === "/") {
    return <HomePage />;
  }

  const consoleApp = <ConsoleApp utilityDataEnabled={mode !== "agent"} />;
  if (mode === "agent") {
    return <AuthSessionProvider value={createAgentAuthContext()}>{consoleApp}</AuthSessionProvider>;
  }
  return <AuthProvider>{consoleApp}</AuthProvider>;
}

function ConsoleApp({ utilityDataEnabled }: { utilityDataEnabled: boolean }) {
  const auth = useOptionalAuthSession();
  const [activePage, setActivePage] = useState<PageKey>(() => pageFromPath(getCurrentPath()) ?? "runtime");
  const [utilityView, setUtilityView] = useState<ConsoleUtilityView | null>(() => utilityViewFromPath(getCurrentPath()));
  const [utilityReturnPath, setUtilityReturnPath] = useState(() => pagePathByKey[pageFromPath(getCurrentPath()) ?? "runtime"]);
  const currentOrganization = auth?.session.organizations[0];
  const organizationId = currentOrganization?.organizationId;

  useEffect(() => {
    const syncPageFromUrl = () => {
      const path = getCurrentPath();
      const nextPage = pageFromPath(path);
      const nextUtilityView = utilityViewFromPath(path);
      if (nextPage) {
        setActivePage(nextPage);
        setUtilityView(null);
        setUtilityReturnPath(pagePathByKey[nextPage]);
        return;
      }
      if (nextUtilityView) {
        setUtilityView(nextUtilityView);
        return;
      }
      setActivePage("runtime");
      setUtilityView(null);
      setUtilityReturnPath(pagePathByKey.runtime);
    };
    window.addEventListener("popstate", syncPageFromUrl);
    return () => window.removeEventListener("popstate", syncPageFromUrl);
  }, []);

  const navigateToPage = (page: PageKey) => {
    const nextPath = pagePathByKey[page];
    if (getCurrentPath() !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setActivePage(page);
    setUtilityView(null);
    setUtilityReturnPath(nextPath);
  };

  const openUtility = (view: UtilityKey) => {
    const nextPath = utilityPathByView[view];
    const currentRoute = `${getCurrentPath()}${window.location.search}`;
    const currentPage = pageFromPath(getCurrentPath());
    setUtilityReturnPath(currentPage ? currentRoute : pagePathByKey[activePage]);
    if (getCurrentPath() !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setUtilityView(view);
  };

  const closeUtility = () => {
    const nextPath = utilityReturnPath || pagePathByKey[activePage];
    if (getCurrentPath() !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setUtilityView(null);
  };

  return (
    <AppShell
      activePage={activePage}
      activeUtility={utilityView}
      organization={currentOrganization}
      userEmail={auth?.session.user.email}
      onLogout={auth ? () => void auth.logout() : undefined}
      onNavigate={navigateToPage}
      onOpenUtility={openUtility}
      utilityBar={(
        <ConsoleUtilityBar
          activeView={utilityView}
          organizationId={organizationId}
          utilityDataEnabled={utilityDataEnabled}
          onOpen={openUtility}
        />
      )}
    >
      {activePage === "runtime" ? (
        <RuntimeFleetPage />
      ) : activePage === "runs" ? (
        <RuntimeWorkBoardPage />
      ) : (
        <OrganizationSettingsPage session={auth?.session} />
      )}
      <ConsoleUtilityDrawer
        organizationId={organizationId}
        utilityDataEnabled={utilityDataEnabled}
        view={utilityView}
        onClose={closeUtility}
        onViewChange={openUtility}
      />
    </AppShell>
  );
}

function getCurrentPath(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

function pageFromPath(path: string): PageKey | null {
  if (path === "/runtime") return "runtime";
  if (path === "/runs") return "runs";
  if (path === "/settings") return "settings";
  return null;
}

function utilityViewFromPath(path: string): ConsoleUtilityView | null {
  if (path === "/operations") return "operations";
  if (path === "/notifications") return "notifications";
  return null;
}

function createAgentAuthContext(): AuthContextValue {
  return {
    async logout() {
      window.history.pushState({}, "", "/");
    },
    session: {
      id: "agent-local-session",
      organizations: [{
        id: "agent-local-membership",
        name: "精选AI",
        organizationId: "agent-local-organization",
        role: "owner",
        slug: "agent-local",
      }],
      user: {
        createdAt: new Date("2026-05-20T00:00:00.000Z"),
        displayName: "Agent",
        email: "agent@local.lorume",
        id: "agent-local-user",
        updatedAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    },
  };
}
