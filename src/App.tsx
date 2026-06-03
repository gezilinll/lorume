import { useEffect, useState } from "react";
import type { LorumeAppMode } from "./app-mode";
import { AuthProvider, AuthSessionProvider, useOptionalAuthSession, type AuthContextValue } from "./auth/AuthProvider";
import { AppShell, type ConsolePageKey, type ConsoleUtilityKey } from "./components/layout/AppShell";
import { AgentDashboardPage } from "./agent-dashboard/AgentDashboardPage";
import {
  ConsoleUtilityBar,
  ConsoleUtilityDrawer,
  type ConsoleUtilityView,
} from "./console/ConsoleUtilityDrawer";
import { HomePage } from "./HomePage";
import { SkillWarehousePage } from "./runtime/SkillWarehousePage";
import { RuntimeFleetPage } from "./runtime/RuntimeFleetPage";
import { RuntimeScheduledTasksPage } from "./runtime/RuntimeScheduledTasksPage";
import { RuntimeWorkBoardPage } from "./runtime/RuntimeWorkBoardPage";
import { OrganizationSettingsPage } from "./settings/OrganizationSettingsPage";
import type { AuthOrganizationMembership } from "./auth/auth-store";
import type { RuntimeSkillInventoryFilters } from "./runtime/runtime-skill-inventory";

type PageKey = ConsolePageKey;
type UtilityKey = ConsoleUtilityKey;
const emptyOrganizations: AuthOrganizationMembership[] = [];

const pagePathByKey: Record<PageKey, string> = {
  runtime: "/runtime",
  runs: "/runs",
  scheduled: "/scheduled-tasks",
  skills: "/skills",
  agentDashboard: "/agent-dashboard",
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
  const [currentPath, setCurrentPath] = useState(() => getCurrentPath());

  useEffect(() => {
    const syncCurrentPath = () => setCurrentPath(getCurrentPath());
    window.addEventListener("popstate", syncCurrentPath);
    return () => window.removeEventListener("popstate", syncCurrentPath);
  }, []);

  if (mode !== "agent" && currentPath === "/") {
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
  const [routeSearch, setRouteSearch] = useState(() => getCurrentSearch());
  const [utilityView, setUtilityView] = useState<ConsoleUtilityView | null>(() => utilityViewFromPath(getCurrentPath()));
  const [utilityReturnPath, setUtilityReturnPath] = useState(() => pagePathByKey[pageFromPath(getCurrentPath()) ?? "runtime"]);
  const organizations = auth?.session.organizations ?? emptyOrganizations;
  const [activeOrganizationId, setActiveOrganizationId] = useState("");
  const currentOrganization = organizations.find((organization) => organization.organizationId === activeOrganizationId) ?? organizations[0];
  const organizationId = currentOrganization?.organizationId;
  const runtimeOrganizationId = utilityDataEnabled ? organizationId : undefined;

  useEffect(() => {
    if (!organizations.length) {
      setActiveOrganizationId("");
      return;
    }
    setActiveOrganizationId((current) => {
      if (current && organizations.some((organization) => organization.organizationId === current)) return current;
      const stored = readStoredActiveOrganizationId(auth?.session.user.id);
      if (stored && organizations.some((organization) => organization.organizationId === stored)) return stored;
      return organizations[0].organizationId;
    });
  }, [auth?.session.user.id, organizations]);

  useEffect(() => {
    const syncPageFromUrl = () => {
      const path = getCurrentPath();
      const nextPage = pageFromPath(path);
      const nextUtilityView = utilityViewFromPath(path);
      if (nextPage) {
        setActivePage(nextPage);
        setRouteSearch(getCurrentSearch());
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
    setRouteSearch("");
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

  const openSkillWarehouse = (filters: { runtimeId?: string; agentId?: string }) => {
    const searchParams = new URLSearchParams();
    if (filters.runtimeId) searchParams.set("runtimeId", filters.runtimeId);
    if (filters.agentId) searchParams.set("agentId", filters.agentId);
    const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
    const nextPath = `${pagePathByKey.skills}${search}`;
    window.history.pushState({}, "", nextPath);
    setRouteSearch(search);
    setActivePage("skills");
    setUtilityView(null);
    setUtilityReturnPath(nextPath);
  };

  const openAgentDashboard = (filters: { agentId?: string }) => {
    const searchParams = new URLSearchParams();
    if (filters.agentId) searchParams.set("agentId", filters.agentId);
    const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
    const nextPath = `${pagePathByKey.agentDashboard}${search}`;
    window.history.pushState({}, "", nextPath);
    setRouteSearch(search);
    setActivePage("agentDashboard");
    setUtilityView(null);
    setUtilityReturnPath(nextPath);
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
      organizations={organizations}
      userDisplayName={auth?.session.user.displayName}
      userEmail={auth?.session.user.email}
      onLogout={auth ? () => void auth.logout() : undefined}
      onNavigate={navigateToPage}
      onOpenUtility={openUtility}
      onSwitchOrganization={(nextOrganizationId) => {
        setActiveOrganizationId(nextOrganizationId);
        writeStoredActiveOrganizationId(auth?.session.user.id, nextOrganizationId);
      }}
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
        <RuntimeFleetPage
          organizationId={runtimeOrganizationId}
          onOpenAgentDashboard={openAgentDashboard}
          onOpenSkillWarehouse={openSkillWarehouse}
        />
      ) : activePage === "runs" ? (
        <RuntimeWorkBoardPage organizationId={runtimeOrganizationId} />
      ) : activePage === "scheduled" ? (
        <RuntimeScheduledTasksPage organizationId={runtimeOrganizationId} />
      ) : activePage === "skills" ? (
        <SkillWarehousePage
          initialFilters={skillFiltersFromSearch(routeSearch)}
          key={routeSearch}
          organizationId={runtimeOrganizationId}
        />
      ) : activePage === "agentDashboard" ? (
        <AgentDashboardPage
          initialAgentId={agentDashboardFiltersFromSearch(routeSearch).agentId}
          key={routeSearch}
          organizationId={organizationId}
        />
      ) : (
        <OrganizationSettingsPage
          organization={currentOrganization}
          session={auth?.session}
          onLeaveOrganization={auth?.leaveOrganization}
        />
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

function getCurrentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

function pageFromPath(path: string): PageKey | null {
  if (path === "/runtime") return "runtime";
  if (path === "/runs") return "runs";
  if (path === "/scheduled-tasks") return "scheduled";
  if (path === "/skills") return "skills";
  if (path === "/agent-dashboard") return "agentDashboard";
  if (path === "/settings") return "settings";
  return null;
}

function utilityViewFromPath(path: string): ConsoleUtilityView | null {
  if (path === "/operations") return "operations";
  if (path === "/notifications") return "notifications";
  return null;
}

function storedActiveOrganizationKey(userId?: string): string {
  return `lorume.activeOrganization.${userId || "anonymous"}`;
}

function readStoredActiveOrganizationId(userId?: string): string {
  try {
    return window.localStorage.getItem(storedActiveOrganizationKey(userId)) ?? "";
  } catch {
    return "";
  }
}

function writeStoredActiveOrganizationId(userId: string | undefined, organizationId: string): void {
  try {
    window.localStorage.setItem(storedActiveOrganizationKey(userId), organizationId);
  } catch {
    // Persistence is a convenience; the in-memory active organization remains authoritative.
  }
}

function skillFiltersFromSearch(search: string): RuntimeSkillInventoryFilters {
  const params = new URLSearchParams(search);
  return {
    ...(params.get("runtimeId") ? { runtimeId: params.get("runtimeId") ?? undefined } : {}),
    ...(params.get("agentId") ? { agentId: params.get("agentId") ?? undefined } : {}),
  };
}

function agentDashboardFiltersFromSearch(search: string): { agentId?: string } {
  const params = new URLSearchParams(search);
  return {
    ...(params.get("agentId") ? { agentId: params.get("agentId") ?? undefined } : {}),
  };
}

function createAgentAuthContext(): AuthContextValue {
  return {
    async leaveOrganization() {
      return [];
    },
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
