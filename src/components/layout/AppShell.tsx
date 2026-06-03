import { useEffect, useState, type ReactNode } from "react";
import { BarChart3, Bell, CalendarClock, Check, ChevronDown, Layers3, ListChecks, LogOut, Play, Plus, RefreshCw, Server, Settings } from "lucide-react";
import type { AuthOrganizationMembership } from "@/auth/auth-store";
import { InitialAvatar, initialFromText } from "@/components/data/InitialAvatar";
import { ConsoleWorkbarContext, type ConsoleWorkbarState } from "@/components/layout/ConsoleWorkbar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ConsolePageKey = "runtime" | "runs" | "scheduled" | "skills" | "agentDashboard" | "settings";
export type ConsoleUtilityKey = "notifications" | "operations";
type ConsoleLayoutTier = "workspace" | "data-dense" | "standard";

const navItems = [
  { icon: Server, label: "Runtime Fleet", page: "runtime" },
  { icon: Play, label: "Runs", page: "runs" },
  { icon: CalendarClock, label: "定时任务", page: "scheduled" },
  { icon: Layers3, label: "Skill 仓库", page: "skills" },
  { icon: BarChart3, label: "Agent 看板", page: "agentDashboard" },
  { icon: Settings, label: "组织设置", page: "settings" },
] as const;

const pageTitles: Record<ConsolePageKey, string> = {
  runtime: "运行资产",
  runs: "Runs",
  scheduled: "定时任务",
  skills: "Skill 仓库",
  agentDashboard: "Agent 看板",
  settings: "组织设置",
};

const layoutTierByPage: Record<ConsolePageKey, ConsoleLayoutTier> = {
  runtime: "data-dense",
  runs: "workspace",
  scheduled: "data-dense",
  skills: "data-dense",
  agentDashboard: "data-dense",
  settings: "standard",
};

const nonNavigationKeys = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Meta",
  "NumLock",
  "ScrollLock",
  "Shift",
  "Symbol",
  "SymbolLock",
]);

function isKeyboardNavigationKey(event: KeyboardEvent): boolean {
  if (nonNavigationKeys.has(event.key)) return false;
  return true;
}

function useConsoleInputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const setPointerModality = () => {
      root.dataset.inputModality = "pointer";
    };
    const setKeyboardModality = (event: KeyboardEvent) => {
      if (!isKeyboardNavigationKey(event)) return;
      root.dataset.inputModality = "keyboard";
    };

    setPointerModality();
    window.addEventListener("keydown", setKeyboardModality, true);
    window.addEventListener("pointerdown", setPointerModality, true);
    window.addEventListener("mousedown", setPointerModality, true);
    window.addEventListener("touchstart", setPointerModality, true);
    return () => {
      window.removeEventListener("keydown", setKeyboardModality, true);
      window.removeEventListener("pointerdown", setPointerModality, true);
      window.removeEventListener("mousedown", setPointerModality, true);
      window.removeEventListener("touchstart", setPointerModality, true);
      delete root.dataset.inputModality;
    };
  }, []);
}

export function AppShell({
  activePage,
  activeUtility,
  children,
  organization,
  organizations = organization ? [organization] : [],
  onLogout,
  onNavigate,
  onOpenUtility,
  onSwitchOrganization,
  utilityBar,
  userDisplayName,
  userEmail,
}: {
  activePage: ConsolePageKey;
  activeUtility: ConsoleUtilityKey | null;
  children: ReactNode;
  organization?: AuthOrganizationMembership;
  organizations?: AuthOrganizationMembership[];
  onLogout?: () => void;
  onNavigate: (page: ConsolePageKey) => void;
  onOpenUtility: (view: ConsoleUtilityKey) => void;
  onSwitchOrganization?: (organizationId: string) => void;
  utilityBar?: ReactNode;
  userDisplayName?: string | null;
  userEmail?: string;
}) {
  useConsoleInputModality();
  const [workbar, setWorkbar] = useState<ConsoleWorkbarState | null>(null);
  const currentWorkbar = workbar ?? { title: pageTitles[activePage] };
  const layoutTier = layoutTierByPage[activePage];

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar variant="sidebar" collapsible="icon">
          <SidebarHeader className="gap-2 px-[14px] pt-5 pb-2">
            <SidebarMenu>
              <SidebarMenuItem>
                {organization ? (
                  <WorkspaceAccountMenu
                    activeOrganization={organization}
                    organizations={organizations}
                    userDisplayName={userDisplayName}
                    userEmail={userEmail}
                    onLogout={onLogout}
                    onSwitchOrganization={onSwitchOrganization}
                  />
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent className="px-[14px]">
            <SidebarGroup className="p-0">
              <SidebarGroupLabel className="h-auto px-1 pb-2 pt-3 text-[10px] font-bold uppercase tracking-[0.09em] text-sidebar-foreground/50">
                Main Menu
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <ConsoleNavigation activePage={activePage} onNavigate={onNavigate} />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <ConsoleWorkbarContext.Provider value={setWorkbar}>
          <SidebarInset
            className={cn(
              "bg-background",
              activePage === "runs" && "overflow-hidden md:max-h-svh",
            )}
          >
            <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-xl" data-console-workbar="true">
              <div
                className="flex h-14 items-center gap-4 px-4 md:px-6"
                data-console-workbar-surface="true"
              >
                <SidebarTrigger aria-label="打开主导航" className="md:hidden" />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <h1 className="truncate text-[15px] font-bold text-foreground">{currentWorkbar.title}</h1>
                  {currentWorkbar.meta ? (
                    <div className="hidden min-w-0 items-center gap-2 truncate text-xs text-muted-foreground sm:flex">
                      {currentWorkbar.meta}
                    </div>
                  ) : null}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {utilityBar ?? (
                    <>
                      <Button
                        aria-expanded={activeUtility === "operations"}
                        aria-label="任务 0"
                        variant={activeUtility === "operations" ? "secondary" : "ghost"}
                        size="icon-sm"
                        type="button"
                        onClick={() => onOpenUtility("operations")}
                      >
                        <ListChecks className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        aria-expanded={activeUtility === "notifications"}
                        aria-label="通知 0"
                        variant={activeUtility === "notifications" ? "secondary" : "ghost"}
                        size="icon-sm"
                        type="button"
                        onClick={() => onOpenUtility("notifications")}
                      >
                        <Bell className="size-4" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                  {currentWorkbar.refresh ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label={currentWorkbar.refresh.label ?? "刷新"}
                          disabled={currentWorkbar.refresh.disabled}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                          onClick={currentWorkbar.refresh.onClick}
                        >
                          <RefreshCw aria-hidden="true" className={cn("size-4", currentWorkbar.refresh.isLoading && "animate-spin")} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{currentWorkbar.refresh.label ?? "刷新"}</TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              </div>
            </header>
            <div
              className={cn(
                "bg-background px-[var(--console-page-padding-x)] py-[var(--console-page-padding-y)]",
                activePage === "runs"
                  ? "min-h-0 flex-1 overflow-hidden"
                  : "min-h-[calc(100svh-3.5rem)]",
              )}
            >
              <div
                className={cn(
                  "w-full",
                  layoutTier === "workspace" && "max-w-none",
                  layoutTier === "data-dense" && "mx-auto max-w-[var(--console-content-max-data)]",
                  layoutTier === "standard" && "mx-auto max-w-[var(--console-content-max-standard)]",
                  activePage === "runs" && "h-full",
                )}
                data-console-layout-tier={layoutTier}
              >
                {children}
              </div>
            </div>
            <Toaster position="bottom-right" />
          </SidebarInset>
        </ConsoleWorkbarContext.Provider>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function WorkspaceAccountMenu({
  activeOrganization,
  onLogout,
  organizations,
  onSwitchOrganization,
  userDisplayName,
  userEmail,
}: {
  activeOrganization: AuthOrganizationMembership;
  onLogout?: () => void;
  organizations: AuthOrganizationMembership[];
  onSwitchOrganization?: (organizationId: string) => void;
  userDisplayName?: string | null;
  userEmail?: string;
}) {
  const displayName = userDisplayName?.trim() || "Agent";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          aria-label="切换组织和账号"
          className="h-11 gap-2 rounded-[10px] bg-sidebar-accent px-2 text-sidebar-foreground data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground hover:bg-sidebar-accent"
          size="lg"
          type="button"
        >
          <span className="flex aspect-square size-7 items-center justify-center rounded-[8px] border border-border bg-background text-xs font-bold text-muted-foreground" aria-hidden="true">
            {initialFromText(activeOrganization.name)}
          </span>
          <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
            <span className="truncate text-[15px] font-bold tracking-normal text-foreground">{activeOrganization.name}</span>
          </span>
          <ChevronDown className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="切换组织和账号"
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-[min(276px,calc(100vw-24px))] overflow-hidden border-border bg-card p-0 text-card-foreground shadow-[var(--menu-shadow)]"
      >
        <DropdownMenuLabel className="flex items-center gap-2.5 px-3 py-3">
          <InitialAvatar
            size="md"
            text={displayName || userEmail || activeOrganization.name}
            tone="blue"
            variant="solid"
          />
          <span className="grid min-w-0">
            <span className="truncate text-[14px] font-bold leading-tight text-foreground">{displayName}</span>
            {userEmail ? (
              <span className="truncate text-[12px] font-normal leading-tight text-muted-foreground">{userEmail}</span>
            ) : null}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="m-0" />
        <DropdownMenuLabel className="px-3 py-2 text-[12px] font-semibold text-muted-foreground">组织</DropdownMenuLabel>
        <div className="grid gap-1 px-2 pb-2">
          {organizations.map((organization) => {
            const isActive = organization.organizationId === activeOrganization.organizationId;
            return (
              <DropdownMenuItem
                className={cn(
                  "min-h-9 rounded-[9px] px-2 py-1.5 text-sm",
                  isActive && "bg-accent text-accent-foreground",
                )}
                key={organization.organizationId}
                onSelect={() => {
                  onSwitchOrganization?.(organization.organizationId);
                }}
              >
                <InitialAvatar size="sm" text={organization.name} tone="brand" />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-[13px] font-semibold">{organization.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{organization.slug} · {organization.role}</span>
                </span>
                {isActive ? <Check className="size-4 text-foreground" aria-hidden="true" /> : null}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem
            className="min-h-9 rounded-[9px] px-2 py-1.5 text-[13px] font-medium"
            disabled
          >
            <Plus className="size-4" aria-hidden="true" />
            创建组织
          </DropdownMenuItem>
        </div>
        {onLogout ? (
          <>
            <DropdownMenuSeparator className="m-0" />
            <DropdownMenuItem
              className="mx-2 my-2 h-9 rounded-[9px] px-2 text-[13px] font-medium text-destructive focus:text-destructive"
              variant="destructive"
              onSelect={onLogout}
            >
              <LogOut className="size-4" aria-hidden="true" />
              退出登录
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConsoleNavigation({
  activePage,
  onNavigate,
}: {
  activePage: ConsolePageKey;
  onNavigate: (page: ConsolePageKey) => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();

  const handleNavigate = (page: ConsolePageKey) => {
    onNavigate(page);
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <nav aria-label="主导航">
      <SidebarMenu>
        {navItems.map((item) => (
          <SidebarMenuItem key={item.page}>
            <SidebarMenuButton
              aria-current={activePage === item.page ? "page" : undefined}
              className="h-8 rounded-[7px] px-2 text-xs font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-semibold data-active:text-sidebar-accent-foreground [&_svg]:size-[15px]"
              isActive={activePage === item.page}
              tooltip={item.label}
              type="button"
              onClick={() => handleNavigate(item.page)}
            >
              <item.icon aria-hidden="true" />
              <span>{item.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </nav>
  );
}
