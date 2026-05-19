import { useEffect, useState } from "react";
import { AuthProvider, useOptionalAuthSession } from "./auth/AuthProvider";
import type { AuthOrganizationMembership } from "./auth/auth-store";
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

export type AppAuthMode = "disabled" | "required";

export function App({ authMode = "disabled" }: { authMode?: AppAuthMode }) {
  if (authMode === "required" && getCurrentPath() === "/") {
    return <HomePage />;
  }

  const consoleApp = <ConsoleApp />;
  return authMode === "required" ? <AuthProvider>{consoleApp}</AuthProvider> : consoleApp;
}

function ConsoleApp() {
  const auth = useOptionalAuthSession();
  const [activePage, setActivePage] = useState<PageKey>(() => pageFromPath(getCurrentPath()) ?? "runtime");
  const [utilityView, setUtilityView] = useState<ConsoleUtilityView | null>(() => utilityViewFromPath(getCurrentPath()));
  const [utilityReturnPath, setUtilityReturnPath] = useState(() => pagePathByKey[pageFromPath(getCurrentPath()) ?? "runtime"]);
  const organizationId = auth?.session.organizations[0]?.organizationId;

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
        <OrganizationSwitcher onSettings={() => navigateToPage("settings")} />
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
        <AccountMenu />
      </aside>
      <ConsoleUtilityBar activeView={utilityView} organizationId={organizationId} onOpen={openUtility} />

      {activePage === "runtime" ? (
        <RuntimeFleetPage />
      ) : activePage === "runs" ? (
        <RuntimeWorkBoardPage />
      ) : (
        <OrganizationSettingsPage session={auth?.session} />
      )}
      <ConsoleUtilityDrawer
        organizationId={organizationId}
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

function OrganizationSwitcher({ onSettings }: { onSettings: () => void }) {
  const auth = useOptionalAuthSession();
  const [isOpen, setIsOpen] = useState(false);
  const organization = auth?.session.organizations[0];
  if (!organization) return null;

  return (
    <div className="navOrgSwitcher">
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`当前组织 ${organization.name}`}
        className="orgSwitcherButton"
        type="button"
        onClick={() => setIsOpen((value) => !value)}
      >
        <span className="orgAvatar" aria-hidden="true">
          {formatOrganizationInitial(organization)}
        </span>
        <span className="orgSwitcherText">
          <span className="orgSwitcherLabel">当前组织</span>
          <span className="orgSwitcherName">{organization.name}</span>
        </span>
        <PixelIcon name="chevron-down" size={16} />
      </button>
      {isOpen ? (
        <div className="orgSwitcherMenu" role="menu" aria-label="组织菜单">
          <div className="orgMenuSummary">
            <span>已选组织</span>
            <strong>{organization.name}</strong>
          </div>
          <button
            className="orgMenuItem"
            role="menuitem"
            type="button"
            onClick={() => {
              setIsOpen(false);
              onSettings();
            }}
          >
            <PixelIcon name="settings" size={16} />
            <span>组织设置</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AccountMenu() {
  const auth = useOptionalAuthSession();
  const [isOpen, setIsOpen] = useState(false);
  if (!auth) return null;

  const displayName = auth.session.user.displayName?.trim() || auth.session.user.email;

  return (
    <div className="navFooter">
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`打开个人菜单 ${displayName}`}
        className="accountButton"
        type="button"
        onClick={() => setIsOpen((value) => !value)}
      >
        <span className="accountAvatar" aria-hidden="true">
          {formatUserInitial(displayName)}
        </span>
        <span className="accountButtonText">
          <span>个人入口</span>
          <small>账户与偏好</small>
        </span>
      </button>
      {isOpen ? (
        <div className="accountMenu" role="menu" aria-label="个人菜单">
          <div className="accountMenuHeader">
            <strong>{displayName}</strong>
            {displayName === auth.session.user.email ? null : <span>{auth.session.user.email}</span>}
          </div>
          <button className="accountMenuItem" role="menuitem" type="button" onClick={() => void auth.logout()}>
            退出登录
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatOrganizationInitial(organization: AuthOrganizationMembership): string {
  return (organization.name.trim()[0] || organization.slug.trim()[0] || "L").toUpperCase();
}

function formatUserInitial(displayName: string): string {
  const text = displayName.trim();
  if (!text) return "U";
  if (text.includes("@")) return text[0]?.toUpperCase() || "U";
  return text.slice(0, 2).toUpperCase();
}
