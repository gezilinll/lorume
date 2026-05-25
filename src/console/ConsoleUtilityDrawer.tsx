import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PixelIcon } from "../ui/PixelIcon";

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

  return (
    <div className="consoleUtilityBar" aria-label="控制台工具">
      <button
        aria-label={`任务 ${operationCount}`}
        aria-expanded={activeView === "operations"}
        className={activeView === "operations" ? "consoleUtilityButton consoleUtilityButtonActive" : "consoleUtilityButton"}
        type="button"
        onClick={() => onOpen("operations")}
      >
        <PixelIcon name="activity" size={14} />
        <span>任务</span>
        <strong className="consoleUtilityCount">{operationCount}</strong>
      </button>
      <button
        aria-label={`通知 ${notificationCount}`}
        aria-expanded={activeView === "notifications"}
        className={activeView === "notifications" ? "consoleUtilityButton consoleUtilityButtonActive" : "consoleUtilityButton"}
        type="button"
        onClick={() => onOpen("notifications")}
      >
        <PixelIcon name="mail" size={14} />
        <span>通知</span>
        <strong className="consoleUtilityCount">{notificationCount}</strong>
      </button>
    </div>
  );
}

/** Right-side utility drawer for operation and notification status without expanding primary navigation. */
export function ConsoleUtilityDrawer({ organizationId, utilityDataEnabled = true, view, onClose }: ConsoleUtilityDrawerProps) {
  const title = view === "operations" ? "Operations" : "Notifications";

  return (
    <Sheet open={view !== null} onOpenChange={(open) => !open && onClose()}>
      {view ? (
        <SheetContent side="right" className="w-full overflow-hidden p-0 sm:!max-w-2xl lg:!max-w-4xl">
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
  const [selectedId, setSelectedId] = useState("");
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
        const nextOperations = payload.operations ?? [];
        setOperations(nextOperations);
        setSelectedId((current) => current || nextOperations[0]?.id || "");
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

  const selectedOperation = operations.find((operation) => operation.id === selectedId) ?? operations[0] ?? null;
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
      <section className="grid gap-4 xl:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.15fr)]">
        <Card size="sm" aria-label="任务列表">
          <CardHeader className="grid-cols-[1fr_auto] items-center">
            <CardTitle>任务列表</CardTitle>
            <span className="text-xs text-muted-foreground">{isLoading ? "读取中" : `${operations.length} 个任务`}</span>
          </CardHeader>
          <CardContent>
          {operations.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">暂无任务。</p>
          ) : (
            <div className="space-y-2">
              {operations.map((operation) => (
                <Button
                  className="h-auto w-full flex-col items-start gap-1 border-border/80 px-3 py-2 text-left whitespace-normal data-[active=true]:border-primary data-[active=true]:bg-primary/5"
                  data-active={operation.id === selectedOperation?.id}
                  aria-current={operation.id === selectedOperation?.id ? "true" : undefined}
                  key={operation.id}
                  variant="outline"
                  type="button"
                  onClick={() => setSelectedId(operation.id)}
                >
                  <strong className="font-medium text-foreground">{operation.summary}</strong>
                  <span className="text-xs text-muted-foreground">{operation.type} · {operationStatusLabels[operation.status] ?? operation.status}</span>
                  <small className="text-xs text-muted-foreground">{formatDateTime(operation.updatedAt)}</small>
                </Button>
              ))}
            </div>
          )}
          </CardContent>
        </Card>
        <OperationDrawerDetail operation={selectedOperation} />
      </section>
    </div>
  );
}

function NotificationsDrawer({ organizationId, utilityDataEnabled }: { organizationId?: string; utilityDataEnabled: boolean }) {
  const [notifications, setNotifications] = useState<NotificationThread[]>([]);
  const [selectedId, setSelectedId] = useState("");
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
        const nextNotifications = payload.threads ?? [];
        setNotifications(nextNotifications);
        setSelectedId((current) => current || nextNotifications[0]?.id || "");
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

  const selectedNotification = notifications.find((notification) => notification.id === selectedId) ?? notifications[0] ?? null;
  const summary = useMemo(() => ({
    critical: notifications.filter((notification) => notification.severity === "critical").length,
    unread: notifications.filter((notification) => !notification.isRead).length,
    total: notifications.length,
  }), [notifications]);

  async function selectNotification(notification: NotificationThread) {
    setSelectedId(notification.id);
    if (notification.isRead) return;
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: "POST" });
      if (!response.ok) throw new Error(`通知读取状态更新失败: HTTP ${response.status}`);
      const payload = (await response.json()) as { thread?: NotificationThread };
      const nextThread = payload.thread ?? { ...notification, isRead: true, readAt: new Date().toISOString() };
      setNotifications((current) => current.map((item) => (item.id === notification.id ? { ...item, ...nextThread } : item)));
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
      <section className="grid gap-4 xl:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.15fr)]">
        <Card size="sm" aria-label="通知列表">
          <CardHeader className="grid-cols-[1fr_auto] items-center">
            <CardTitle>通知列表</CardTitle>
            <span className="text-xs text-muted-foreground">{isLoading ? "读取中" : `${notifications.length} 条通知`}</span>
          </CardHeader>
          <CardContent>
          {notifications.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">暂无通知。</p>
          ) : (
            <div className="space-y-2">
              {notifications.map((notification) => (
                <Button
                  className="h-auto w-full flex-col items-start gap-1 border-border/80 px-3 py-2 text-left whitespace-normal data-[active=true]:border-primary data-[active=true]:bg-primary/5"
                  data-active={notification.id === selectedNotification?.id}
                  aria-current={notification.id === selectedNotification?.id ? "true" : undefined}
                  key={notification.id}
                  variant="outline"
                  type="button"
                  onClick={() => void selectNotification(notification)}
                >
                  <span className="flex w-full items-start justify-between gap-2">
                    <strong className="font-medium text-foreground">{notification.title}</strong>
                    <Badge variant={notification.isRead ? "outline" : "secondary"}>
                      {notification.isRead ? "已读" : "未读"}
                    </Badge>
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
          </CardContent>
        </Card>
        <NotificationDrawerDetail notification={selectedNotification} />
      </section>
    </div>
  );
}

function OperationDrawerDetail({ operation }: { operation: OperationListItem | null }) {
  if (!operation) {
    return (
      <Card size="sm" aria-label="任务详情">
        <CardHeader>
          <h3 className="font-heading text-sm font-medium">任务详情</h3>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">选择一个任务查看目标、状态和失败原因。</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card size="sm" aria-label="任务详情">
      <CardHeader className="grid-cols-[1fr_auto]">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Operation</p>
          <h3 className="font-heading text-base font-medium">{operation.summary}</h3>
        </div>
        <Badge variant={operation.status === "failed" ? "destructive" : "secondary"}>
          {operationStatusLabels[operation.status] ?? operation.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <UtilityDetailList
          title="任务上下文"
          items={[
            `类型: ${operation.type}`,
            `资源: ${formatOptionalPair(operation.resourceType, operation.resourceId)}`,
            `目标: ${formatOptionalPair(operation.targetType, operation.targetId)}`,
          ]}
        />
        <UtilityDetailList
          title="最近状态"
          items={[
            `创建时间: ${formatDateTime(operation.createdAt)}`,
            `更新时间: ${formatDateTime(operation.updatedAt)}`,
            operation.errorSummary ? `错误: ${operation.errorSummary}` : "错误: 无",
          ]}
        />
      </CardContent>
    </Card>
  );
}

function NotificationDrawerDetail({ notification }: { notification: NotificationThread | null }) {
  if (!notification) {
    return (
      <Card size="sm" aria-label="通知详情">
        <CardHeader>
          <h3 className="font-heading text-sm font-medium">通知详情</h3>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">选择一条通知查看范围、状态和最近摘要。</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card size="sm" aria-label="通知详情">
      <CardHeader className="grid-cols-[1fr_auto]">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notification</p>
          <h3 className="font-heading text-base font-medium">{notification.title}</h3>
        </div>
        <Badge variant={notification.status === "open" ? "secondary" : "outline"}>
          {notificationStatusLabels[notification.status] ?? notification.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <UtilityDetailList
          title="通知范围"
          items={[
            `级别: ${notificationSeverityLabels[notification.severity] ?? notification.severity}`,
            `资源: ${formatOptionalPair(notification.resourceType, notification.resourceId)}`,
            `读取状态: ${notification.isRead ? "已读" : "未读"}`,
          ]}
        />
        <UtilityDetailList
          title="最近状态"
          items={[
            `首次出现: ${formatDateTime(notification.firstOccurredAt)}`,
            `最近出现: ${formatDateTime(notification.lastOccurredAt)}`,
            `状态: ${notificationStatusLabels[notification.status] ?? notification.status}`,
          ]}
        />
        <section className="space-y-1">
          <h4 className="text-sm font-medium">摘要</h4>
          <p className="text-sm text-muted-foreground">{notification.latestSummary}</p>
        </section>
      </CardContent>
    </Card>
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

function UtilityDetailList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{title}</h4>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
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
