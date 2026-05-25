import { useState, type ReactNode } from "react";
import { Bell, ChevronDown, ListChecks, LogOut, Play, Server, Settings } from "lucide-react";
import type { AuthOrganizationMembership } from "@/auth/auth-store";
import { LorumeLogo } from "@/components/brand/LorumeLogo";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ConsolePageKey = "runtime" | "runs" | "settings";
export type ConsoleUtilityKey = "notifications" | "operations";

const navItems = [
  { icon: Server, label: "Runtime Fleet", page: "runtime" },
  { icon: Play, label: "Runs", page: "runs" },
  { icon: Settings, label: "组织设置", page: "settings" },
] as const;

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
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar variant="inset" collapsible="icon">
          <SidebarHeader>
            <LorumeLogo />
            {organization ? (
              <Button variant="ghost" className="h-auto justify-start gap-2 px-2 py-2" type="button" aria-label="切换组织">
                <span className="flex size-8 items-center justify-center rounded-md bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground">
                  {initialFromText(organization.name)}
                </span>
                <span className="grid min-w-0 text-left text-xs">
                  <span className="text-muted-foreground">当前组织</span>
                  <span className="truncate font-medium">{organization.name}</span>
                </span>
                <ChevronDown className="ml-auto size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <ConsoleNavigation activePage={activePage} onNavigate={onNavigate} />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            {userEmail ? (
              <div className="rounded-lg border border-sidebar-border p-2 text-xs">
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  type="button"
                  aria-label="打开个人入口"
                  aria-expanded={isProfileOpen}
                  aria-haspopup="menu"
                  onClick={() => setIsProfileOpen((current) => !current)}
                >
                  <span className="flex size-8 items-center justify-center rounded-md bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground" aria-hidden="true">
                    {initialFromText(userEmail)}
                  </span>
                  <span className="grid min-w-0">
                    <strong className="truncate font-medium">个人入口</strong>
                    <span className="truncate text-muted-foreground">账户与偏好</span>
                  </span>
                </button>
                {isProfileOpen ? (
                  <div className="mt-2 rounded-md border border-sidebar-border bg-sidebar p-2 shadow-sm" role="menu">
                    <p className="truncate px-2 py-1 text-sidebar-foreground">{userEmail}</p>
                    {onLogout ? (
                      <Button variant="ghost" size="sm" className="mt-1 w-full justify-start" type="button" role="menuitem" onClick={onLogout}>
                        <LogOut className="size-4" aria-hidden="true" />
                        退出登录
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur">
            <SidebarTrigger aria-label="打开主导航" className="md:hidden" />
            <div className="flex items-center gap-2">
              {utilityBar ?? (
                <>
                  <Button
                    aria-expanded={activeUtility === "operations"}
                    variant={activeUtility === "operations" ? "secondary" : "ghost"}
                    size="sm"
                    type="button"
                    onClick={() => onOpenUtility("operations")}
                  >
                    <ListChecks className="size-4" aria-hidden="true" />
                    Operations
                  </Button>
                  <Button
                    aria-expanded={activeUtility === "notifications"}
                    variant={activeUtility === "notifications" ? "secondary" : "ghost"}
                    size="sm"
                    type="button"
                    onClick={() => onOpenUtility("notifications")}
                  >
                    <Bell className="size-4" aria-hidden="true" />
                    Notifications
                  </Button>
                </>
              )}
            </div>
          </header>
          <div className={cn("min-h-[calc(100svh-3.5rem)] bg-muted/30 p-4 md:p-6")}>{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
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
