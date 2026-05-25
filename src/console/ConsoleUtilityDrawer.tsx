import { useEffect, useMemo, useState } from "react";
import { Pill } from "@/components/data/Pill";
import { DetailSection, DetailSurface } from "@/components/surfaces/DetailSurface";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Activity, Mail } from "lucide-react";

export type ConsoleUtilityView = "operations" | "notifications";

type OperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unsupported"
  | "requires_manual_step"
  | "cancelled";

interface OperationListItem {
  createdAt: string;
  errorSummary?: string | null;
  id: string;
  resourceId?: string | null;
  resourceType?: string | null;
  status: OperationStatus;
  summary: string;
  targetId?: string | null;
  targetType?: string | null;
  type: string;
  updatedAt: string;
}

type NotificationSeverity = "info" | "warning" | "critical";
type NotificationStatus = "open" | "resolved" | "recovered" | "muted";

interface NotificationThread {
  firstOccurredAt: string;
  id: string;
  isRead?: boolean;
  lastOccurredAt: string;
  latestSummary: string;
  readAt?: string | null;
  resourceId?: string | null;
  resourceType?: string | null;
  severity: NotificationSeverity;
  status: NotificationStatus;
  title: string;
}

interface ConsoleUtilityBarProps {
  activeView: ConsoleUtilityView | null;
  organizationId?: string;
  utilityDataEnabled?: boolean;
  onOpen: (view: ConsoleUtilityView) => void;
}

interface ConsoleUtilityDrawerProps {
  organizationId?: string;
  utilityDataEnabled?: boolean;
  view: ConsoleUtilityView | null;
  onClose: () => void;
  onViewChange: (view: ConsoleUtilityView) => void;
}

const operationStatusLabels: Record<OperationStatus, string> = {
  cancelled: "已取消",
  failed: "失败",
  queued: "排队中",
  requires_manual_step: "需人工处理",
  running: "执行中",
  succeeded: "已完成",
  unsupported: "不支持",
};

const notificationSeverityLabels: Record<NotificationSeverity, string> = {
  critical: "高风险",
  info: "信息",
  warning: "警告",
};

const notificationStatusLabels: Record<NotificationStatus, string> = {
  muted: "已静默",
  open: "未恢复",
  recovered: "已恢复",
  resolved: "已恢复",
};

const activeOperationStatuses = new Set<OperationStatus>(["queued", "running", "requires_manual_step"]);

/** Compact utility entry for async tasks and in-app notifications. */
export function ConsoleUtilityBar({ activeView, organizationId, utilityDataEnabled = true, onOpen }: ConsoleUtilityBarProps) {
  const [operationCount, setOperationCount] = useState(0);
  const [notificationCount, setNotificationCount] = useState(0);

  useEffect(() => {
    if (!organizationId || !utilityDataEnabled) {
      setOperationCount(0);
      setNotificationCount(0);
      return;
    }

    const scopedOrganizationId = organizationId;
    let cancelled = false;

    async function loadUtilityCounts() {
      try {
        const [operationsResponse, notificationsResponse] = await Promise.all([
          fetch(`/api/operations?organizationId=${encodeURIComponent(scopedOrganizationId)}&limit=100`),
          fetch(`/api/notifications?organizationId=${encodeURIComponent(scopedOrganizationId)}`),
        ]);
        if (!operationsResponse.ok || !notificationsResponse.ok) return;

        const operationsPayload = (await operationsResponse.json()) as { operations?: OperationListItem[] };
        const notificationsPayload = (await notificationsResponse.json()) as { threads?: NotificationThread[] };
        if (cancelled) return;

        setOperationCount((operationsPayload.operations ?? []).filter((operation) => activeOperationStatuses.has(operation.status)).length);
        setNotificationCount((notificationsPayload.threads ?? []).filter((thread) => !thread.isRead).length);
      } catch {
        if (!cancelled) {
          setOperationCount(0);
          setNotificationCount(0);
        }
      }
    }

    void loadUtilityCounts();
    const timer = window.setInterval(() => void loadUtilityCounts(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [organizationId, utilityDataEnabled]);

  const utilityButtonClass = "relative";

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1" aria-label="控制台工具">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`任务 ${operationCount}`}
              aria-expanded={activeView === "operations"}
              className={utilityButtonClass}
              size="icon-sm"
              type="button"
              variant={activeView === "operations" ? "secondary" : "ghost"}
              onClick={() => onOpen("operations")}
            >
              <Activity aria-hidden="true" className="size-4" />
              <UtilityCount value={operationCount} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">任务</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`通知 ${notificationCount}`}
              aria-expanded={activeView === "notifications"}
              className={utilityButtonClass}
              size="icon-sm"
              type="button"
              variant={activeView === "notifications" ? "secondary" : "ghost"}
              onClick={() => onOpen("notifications")}
            >
              <Mail aria-hidden="true" className="size-4" />
              <UtilityCount value={notificationCount} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">通知</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function UtilityCount({ value }: { value: number }) {
  return (
    <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] font-bold leading-none text-primary-foreground">
      {value}
    </span>
  );
}

/** Right-side utility drawer for operation and notification status without expanding primary navigation. */
export function ConsoleUtilityDrawer({ organizationId, utilityDataEnabled = true, view, onClose }: ConsoleUtilityDrawerProps) {
  const title = view === "operations" ? "Operations" : "Notifications";

  return (
    <Sheet open={view !== null} onOpenChange={(open) => !open && onClose()}>
      {view ? (
        <SheetContent side="right" className="w-full overflow-hidden p-0 sm:!max-w-md">
          <SheetHeader className="border-b px-4 py-3 text-left">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>查看当前组织的异步任务和通知。</SheetDescription>
          </SheetHeader>
          <ScrollArea className="h-[calc(100svh-5rem)]">
            {view === "operations" ? (
              <OperationsDrawer organizationId={organizationId} utilityDataEnabled={utilityDataEnabled} />
            ) : (
              <NotificationsDrawer organizationId={organizationId} utilityDataEnabled={utilityDataEnabled} />
            )}
          </ScrollArea>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function OperationsDrawer({ organizationId, utilityDataEnabled }: { organizationId?: string; utilityDataEnabled: boolean }) {
  const [operations, setOperations] = useState<OperationListItem[]>([]);
  const [detailOperation, setDetailOperation] = useState<OperationListItem | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!organizationId || !utilityDataEnabled) return;
    const scopedOrganizationId = organizationId;
    let cancelled = false;
    async function loadOperations() {
      setIsLoading(true);
      setErrorMessage("");
      try {
        const response = await fetch(`/api/operations?organizationId=${encodeURIComponent(scopedOrganizationId)}&limit=100`);
        if (!response.ok) throw new Error(`任务读取失败: HTTP ${response.status}`);
        const payload = (await response.json()) as { operations?: OperationListItem[] };
        if (cancelled) return;
        setOperations(payload.operations ?? []);
      } catch (error) {
        if (!cancelled) setErrorMessage(error instanceof Error ? error.message : "任务读取失败");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void loadOperations();
    const timer = window.setInterval(() => void loadOperations(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [organizationId, utilityDataEnabled]);

  const summary = useMemo(() => ({
    active: operations.filter((operation) => activeOperationStatuses.has(operation.status)).length,
    failed: operations.filter((operation) => operation.status === "failed").length,
    total: operations.length,
  }), [operations]);

  if (!organizationId) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">请选择组织后查看任务。</p>;
  }
  if (!utilityDataEnabled) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">本地调试模式不读取远端任务。</p>;
  }

  return (
    <div className="space-y-4 p-4">
      <section className="grid grid-cols-3 gap-2" aria-label="任务概览">
        <UtilityMetric label="任务总数" value={summary.total} tone="blue" />
        <UtilityMetric label="进行中" value={summary.active} tone="green" />
        <UtilityMetric label="失败" value={summary.failed} tone="orange" />
      </section>
      {errorMessage ? <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{errorMessage}</p> : null}
      <section aria-label="任务列表">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="font-heading text-sm font-medium">任务列表</h3>
          <span className="text-xs text-muted-foreground">{isLoading ? "读取中" : `${operations.length} 个任务`}</span>
        </div>
        {operations.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">暂无任务。</p>
        ) : (
          <div className="space-y-2">
            {operations.map((operation) => (
              <Button
                aria-haspopup="dialog"
                className="h-auto w-full flex-col items-start gap-1 border-border/80 px-3 py-2 text-left whitespace-normal"
                key={operation.id}
                variant="outline"
                type="button"
                onClick={() => setDetailOperation(operation)}
              >
                <span className="flex w-full items-start justify-between gap-2">
                  <strong className="font-medium text-foreground">{operation.summary}</strong>
                  <Pill kind="status" tone={operation.status === "failed" ? "danger" : "neutral"}>
                    {operationStatusLabels[operation.status] ?? operation.status}
                  </Pill>
                </span>
                <span className="text-xs text-muted-foreground">{operation.type}</span>
                <small className="text-xs text-muted-foreground">{formatDateTime(operation.updatedAt)}</small>
              </Button>
            ))}
          </div>
        )}
      </section>
      <OperationDetailDialog
        operation={detailOperation}
        open={Boolean(detailOperation)}
        onOpenChange={(open) => {
          if (!open) setDetailOperation(null);
        }}
      />
    </div>
  );
}

function NotificationsDrawer({ organizationId, utilityDataEnabled }: { organizationId?: string; utilityDataEnabled: boolean }) {
  const [notifications, setNotifications] = useState<NotificationThread[]>([]);
  const [detailNotification, setDetailNotification] = useState<NotificationThread | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!organizationId || !utilityDataEnabled) return;
    const scopedOrganizationId = organizationId;
    let cancelled = false;
    async function loadNotifications() {
      setIsLoading(true);
      setErrorMessage("");
      try {
        const response = await fetch(`/api/notifications?organizationId=${encodeURIComponent(scopedOrganizationId)}`);
        if (!response.ok) throw new Error(`通知读取失败: HTTP ${response.status}`);
        const payload = (await response.json()) as { threads?: NotificationThread[] };
        if (cancelled) return;
        setNotifications(payload.threads ?? []);
      } catch (error) {
        if (!cancelled) setErrorMessage(error instanceof Error ? error.message : "通知读取失败");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void loadNotifications();
    const timer = window.setInterval(() => void loadNotifications(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [organizationId, utilityDataEnabled]);

  const summary = useMemo(() => ({
    critical: notifications.filter((notification) => notification.severity === "critical").length,
    unread: notifications.filter((notification) => !notification.isRead).length,
    total: notifications.length,
  }), [notifications]);

  async function selectNotification(notification: NotificationThread) {
    setDetailNotification(notification);
    if (notification.isRead) return;
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: "POST" });
      if (!response.ok) throw new Error(`通知读取状态更新失败: HTTP ${response.status}`);
      const payload = (await response.json()) as { thread?: NotificationThread };
      const nextThread = payload.thread ?? { ...notification, isRead: true, readAt: new Date().toISOString() };
      setNotifications((current) => current.map((item) => (item.id === notification.id ? { ...item, ...nextThread } : item)));
      setDetailNotification(nextThread);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "通知读取状态更新失败");
    }
  }

  if (!organizationId) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">请选择组织后查看通知。</p>;
  }
  if (!utilityDataEnabled) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">本地调试模式不读取远端通知。</p>;
  }

  return (
    <div className="space-y-4 p-4">
      <section className="grid grid-cols-3 gap-2" aria-label="通知概览">
        <UtilityMetric label="通知总数" value={summary.total} tone="blue" />
        <UtilityMetric label="未读" value={summary.unread} tone="orange" />
        <UtilityMetric label="高风险" value={summary.critical} tone="purple" />
      </section>
      {errorMessage ? <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{errorMessage}</p> : null}
      <section aria-label="通知列表">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="font-heading text-sm font-medium">通知列表</h3>
          <span className="text-xs text-muted-foreground">{isLoading ? "读取中" : `${notifications.length} 条通知`}</span>
        </div>
        {notifications.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">暂无通知。</p>
        ) : (
          <div className="space-y-2">
            {notifications.map((notification) => (
              <Button
                aria-haspopup="dialog"
                className="h-auto w-full flex-col items-start gap-1 border-border/80 px-3 py-2 text-left whitespace-normal"
                key={notification.id}
                variant="outline"
                type="button"
                onClick={() => void selectNotification(notification)}
              >
                <span className="flex w-full items-start justify-between gap-2">
                  <strong className="font-medium text-foreground">{notification.title}</strong>
                  <Pill kind="status" tone={notification.isRead ? "muted" : "info"}>
                    {notification.isRead ? "已读" : "未读"}
                  </Pill>
                </span>
                <span className="text-xs text-muted-foreground">
                  {notificationSeverityLabels[notification.severity] ?? notification.severity} ·{" "}
                  {notificationStatusLabels[notification.status] ?? notification.status}
                </span>
                <small className="text-xs text-muted-foreground">{formatDateTime(notification.lastOccurredAt)}</small>
              </Button>
            ))}
          </div>
        )}
      </section>
      <NotificationDetailDialog
        notification={detailNotification}
        open={Boolean(detailNotification)}
        onOpenChange={(open) => {
          if (!open) setDetailNotification(null);
        }}
      />
    </div>
  );
}

function OperationDetailDialog({
  operation,
  open,
  onOpenChange,
}: {
  operation: OperationListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!operation) {
    return null;
  }

  return (
    <DetailSurface
      meta={(
        <Pill kind="status" tone={operation.status === "failed" ? "danger" : "neutral"}>
          {operationStatusLabels[operation.status] ?? operation.status}
        </Pill>
      )}
      open={open}
      onOpenChange={onOpenChange}
      title="任务详情"
      className="sm:max-w-xl"
    >
      <section className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Operation</p>
        <h2 className="font-heading text-lg font-medium">{operation.summary}</h2>
      </section>
      <DetailSection title="任务上下文">
        <p>类型: {operation.type}</p>
        <p>资源: {formatOptionalPair(operation.resourceType, operation.resourceId)}</p>
        <p>目标: {formatOptionalPair(operation.targetType, operation.targetId)}</p>
      </DetailSection>
      <DetailSection title="最近状态">
        <p>创建时间: {formatDateTime(operation.createdAt)}</p>
        <p>更新时间: {formatDateTime(operation.updatedAt)}</p>
        <p>错误: {operation.errorSummary ?? "无"}</p>
      </DetailSection>
    </DetailSurface>
  );
}

function NotificationDetailDialog({
  notification,
  open,
  onOpenChange,
}: {
  notification: NotificationThread | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!notification) {
    return null;
  }

  return (
    <DetailSurface
      meta={(
        <Pill kind="status" tone={notification.status === "open" ? "info" : "neutral"}>
          {notificationStatusLabels[notification.status] ?? notification.status}
        </Pill>
      )}
      open={open}
      onOpenChange={onOpenChange}
      title="通知详情"
      className="sm:max-w-xl"
    >
      <section className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notification</p>
        <h2 className="font-heading text-lg font-medium">{notification.title}</h2>
      </section>
      <DetailSection title="通知范围">
        <p>级别: {notificationSeverityLabels[notification.severity] ?? notification.severity}</p>
        <p>资源: {formatOptionalPair(notification.resourceType, notification.resourceId)}</p>
        <p>读取状态: {notification.isRead ? "已读" : "未读"}</p>
      </DetailSection>
      <DetailSection title="最近状态">
        <p>首次出现: {formatDateTime(notification.firstOccurredAt)}</p>
        <p>最近出现: {formatDateTime(notification.lastOccurredAt)}</p>
        <p>状态: {notificationStatusLabels[notification.status] ?? notification.status}</p>
      </DetailSection>
      <DetailSection title="摘要">
        {notification.latestSummary}
      </DetailSection>
    </DetailSurface>
  );
}

function UtilityMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  const toneClass = {
    blue: "border-primary/20 bg-primary/5",
    green: "border-emerald-500/20 bg-emerald-500/5",
    orange: "border-amber-500/20 bg-amber-500/5",
    purple: "border-violet-500/20 bg-violet-500/5",
  }[tone] ?? "border-border";

  return (
    <Card size="sm" className={toneClass}>
      <CardContent className="space-y-1">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <strong className="block text-xl font-semibold text-foreground">{value}</strong>
      </CardContent>
    </Card>
  );
}

function formatOptionalPair(type?: string | null, id?: string | null): string {
  if (!type && !id) return "无";
  return [type, id].filter(Boolean).join(" · ");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    year: "numeric",
  }).format(date);
}
