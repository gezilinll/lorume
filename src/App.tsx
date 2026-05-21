import { useEffect, useState } from "react";
import type { LorumeAppMode } from "./app-mode";
import type { AuthOrganizationMembership } from "./auth/auth-store";
import { AuthProvider, AuthSessionProvider, useOptionalAuthSession, type AuthContextValue } from "./auth/AuthProvider";
import {
  ConsoleUtilityBar,
  ConsoleUtilityDrawer,
  type ConsoleUtilityView,
} from "./console/ConsoleUtilityDrawer";
import { HomePage } from "./HomePage";
import { RuntimeFleetPage } from "./runtime/RuntimeFleetPage";
import { RuntimeWorkBoardPage } from "./runtime/RuntimeWorkBoardPage";
import { OrganizationSettingsPage } from "./settings/OrganizationSettingsPage";
import { PixelIcon, type PixelIconName } from "./ui/PixelIcon";
import { PixelLogo } from "./ui/PixelLogo";

type PageKey = "runtime" | "runs" | "settings";

const navItems: Array<{ label: string; icon: PixelIconName; page: PageKey }> = [
  { label: "Runtime Fleet", icon: "server", page: "runtime" },
  { label: "Runs", icon: "play", page: "runs" },
  { label: "组织设置", icon: "settings", page: "settings" },
] as const;

const pagePathByKey: Record<PageKey, string> = {
  runtime: "/runtime",
  runs: "/runs",
  settings: "/settings",
};

const utilityPathByView: Record<ConsoleUtilityView, string> = {
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

  const openUtility = (view: ConsoleUtilityView) => {
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
    <main className="appShell">
      <aside className="sideNav" aria-label="主导航">
        <div className="brandMark">
          <PixelLogo />
        </div>
        <OrganizationSwitcher organization={currentOrganization} />
        <nav className="navList" aria-label="主导航">
          {navItems.map((item) => {
            const isActive = item.page === activePage;
            return (
              <button
                aria-current={isActive ? "page" : undefined}
                className={isActive ? "navItem navItemActive" : "navItem"}
                key={item.label}
                type="button"
                onClick={() => navigateToPage(item.page)}
              >
                <span className="navIconFrame">
                  <PixelIcon name={item.icon} size={16} />
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <AuthSessionActions />
      </aside>
      <ConsoleUtilityBar
        activeView={utilityView}
        organizationId={organizationId}
        utilityDataEnabled={utilityDataEnabled}
        onOpen={openUtility}
      />

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
    </main>
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

function OrganizationSwitcher({ organization }: { organization?: AuthOrganizationMembership }) {
  if (!organization) return null;

  return (
    <button className="organizationSwitch" type="button" aria-label="切换组织">
      <span className="organizationAvatar" aria-hidden="true">{initialFromText(organization.name)}</span>
      <span className="organizationCopy">
        <span>当前组织</span>
        <strong>{organization.name}</strong>
      </span>
      <PixelIcon name="chevron-down" size={14} />
    </button>
  );
}

function AuthSessionActions() {
  const auth = useOptionalAuthSession();
  const [isOpen, setIsOpen] = useState(false);
  if (!auth) return null;

  return (
    <div className="navFooter">
      <button
        className="profileEntry"
        type="button"
        aria-label="打开个人入口"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="profileAvatar" aria-hidden="true">{initialFromText(auth.session.user.displayName || auth.session.user.email)}</span>
        <span className="profileCopy">
          <strong>个人入口</strong>
          <span>账户与偏好</span>
        </span>
      </button>
      {isOpen ? (
        <div className="profileMenu" role="menu">
          <p>{auth.session.user.email}</p>
          <button type="button" role="menuitem" onClick={() => void auth.logout()}>
            退出登录
          </button>
        </div>
      ) : null}
    </div>
  );
}

function initialFromText(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "L";
  return normalized.slice(0, 1).toUpperCase();
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
