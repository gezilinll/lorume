import { useState, type ReactNode } from "react";
import { Bell, ChevronsUpDown, ListChecks, LogOut, Play, RefreshCw, Server, Settings } from "lucide-react";
import type { AuthOrganizationMembership } from "@/auth/auth-store";
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
  SidebarFooter,
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

export type ConsolePageKey = "runtime" | "runs" | "settings";
export type ConsoleUtilityKey = "notifications" | "operations";

const navItems = [
  { icon: Server, label: "Runtime Fleet", page: "runtime" },
  { icon: Play, label: "Runs", page: "runs" },
  { icon: Settings, label: "组织设置", page: "settings" },
] as const;

const pageTitles: Record<ConsolePageKey, string> = {
  runtime: "运行资产",
  runs: "Runs",
  settings: "组织设置",
};

export function AppShell({
  activePage,
  activeUtility,
  children,
  organization,
  onLogout,
  onNavigate,
  onOpenUtility,
  utilityBar,
  userEmail,
}: {
  activePage: ConsolePageKey;
  activeUtility: ConsoleUtilityKey | null;
  children: ReactNode;
  organization?: AuthOrganizationMembership;
  onLogout?: () => void;
  onNavigate: (page: ConsolePageKey) => void;
  onOpenUtility: (view: ConsoleUtilityKey) => void;
  utilityBar?: ReactNode;
  userEmail?: string;
}) {
  const [workbar, setWorkbar] = useState<ConsoleWorkbarState | null>(null);
  const currentWorkbar = workbar ?? { title: pageTitles[activePage] };

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar variant="inset" collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                {organization ? (
                  <OrganizationSwitcher organization={organization} />
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Console</SidebarGroupLabel>
              <SidebarGroupContent>
                <ConsoleNavigation activePage={activePage} onNavigate={onNavigate} />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                {userEmail ? <UserAccountMenu userEmail={userEmail} onLogout={onLogout} /> : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <ConsoleWorkbarContext.Provider value={setWorkbar}>
          <SidebarInset
            className={cn(
              "md:peer-data-[variant=inset]:m-0 md:peer-data-[variant=inset]:rounded-none md:peer-data-[variant=inset]:shadow-none",
              activePage === "runs" && "overflow-hidden md:max-h-svh",
            )}
          >
            <header className="sticky top-0 z-20 border-b border-border bg-background" data-console-workbar="true">
              <div
                className="flex h-12 items-center gap-2 px-4"
                data-console-workbar-surface="true"
              >
                <SidebarTrigger aria-label="打开主导航" className="md:hidden" />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <h1 className="truncate text-sm font-semibold text-foreground">{currentWorkbar.title}</h1>
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
                "bg-muted/30 p-3 md:p-4",
                activePage === "runs"
                  ? "min-h-0 flex-1 overflow-hidden"
                  : "min-h-[calc(100svh-3rem)]",
              )}
            >
              {children}
            </div>
            <Toaster position="bottom-right" />
          </SidebarInset>
        </ConsoleWorkbarContext.Provider>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function OrganizationSwitcher({ organization }: { organization: AuthOrganizationMembership }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          aria-label="切换组织"
          className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
          size="lg"
          type="button"
        >
          <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
            {initialFromText(organization.name)}
          </span>
          <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">{organization.name}</span>
            <span className="truncate text-xs text-muted-foreground">当前组织</span>
          </span>
          <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56 border-border bg-card text-card-foreground">
        <DropdownMenuLabel>组织</DropdownMenuLabel>
        <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
          <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
            {initialFromText(organization.name)}
          </span>
          <span className="grid min-w-0">
            <span className="truncate font-medium">{organization.name}</span>
            <span className="truncate text-xs text-muted-foreground">{organization.role}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserAccountMenu({
  onLogout,
  userEmail,
}: {
  onLogout?: () => void;
  userEmail: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton aria-label="打开个人入口" size="lg" type="button">
          <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground" aria-hidden="true">
            {initialFromText(userEmail)}
          </span>
          <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">个人入口</span>
            <span className="truncate text-xs text-muted-foreground">{userEmail}</span>
          </span>
          <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56 border-border bg-card text-card-foreground">
        <DropdownMenuLabel className="grid gap-0.5">
          <span>个人入口</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{userEmail}</span>
        </DropdownMenuLabel>
        {onLogout ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout}>
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

function initialFromText(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "L";
  return normalized.slice(0, 1).toUpperCase();
}
