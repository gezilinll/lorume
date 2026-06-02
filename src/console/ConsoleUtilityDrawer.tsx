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
  manualInstruction?: string | null;
  resourceId?: string | null;
  resourceType?: string | null;
  status: OperationStatus;
  summary: string;
  targetId?: string | null;
  targetType?: string | null;
  type: string;
  updatedAt: string;
}

interface OperationJobListItem {
  createdAt?: string;
  finishedAt?: string | null;
  id: string;
  lastErrorSummary?: string | null;
  payload?: Record<string, unknown>;
  startedAt?: string | null;
  status: OperationStatus;
  type: string;
  updatedAt?: string;
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
  const [detailJobs, setDetailJobs] = useState<OperationJobListItem[]>([]);
  const [detailErrorMessage, setDetailErrorMessage] = useState("");
  const [isDetailLoading, setIsDetailLoading] = useState(false);
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

  async function selectOperation(operation: OperationListItem) {
    setDetailOperation(operation);
    setDetailJobs([]);
    setDetailErrorMessage("");
    setIsDetailLoading(true);
    try {
      const response = await fetch(`/api/operations/${encodeURIComponent(operation.id)}?limit=100`);
      if (!response.ok) throw new Error(`任务详情读取失败: HTTP ${response.status}`);
      const payload = await response.json() as { jobs?: unknown[]; operation?: OperationListItem };
      setDetailOperation(payload.operation ?? operation);
      setDetailJobs(normalizeOperationJobs(payload.jobs));
    } catch (error) {
      setDetailErrorMessage(error instanceof Error ? error.message : "任务详情读取失败");
    } finally {
      setIsDetailLoading(false);
    }
  }

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
                onClick={() => void selectOperation(operation)}
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
        errorMessage={detailErrorMessage}
        isLoading={isDetailLoading}
        jobs={detailJobs}
        operation={detailOperation}
        open={Boolean(detailOperation)}
        onOpenChange={(open) => {
          if (!open) {
            setDetailOperation(null);
            setDetailJobs([]);
            setDetailErrorMessage("");
          }
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
  errorMessage,
  isLoading,
  jobs,
  operation,
  open,
  onOpenChange,
}: {
  errorMessage: string;
  isLoading: boolean;
  jobs: OperationJobListItem[];
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
        <p>人工处理: {operation.manualInstruction ?? "无"}</p>
      </DetailSection>
      <DetailSection title="Job 进度">
        {errorMessage ? <p>{errorMessage}</p> : null}
        {isLoading ? <p>读取中</p> : null}
        {!isLoading && !errorMessage && jobs.length === 0 ? <p>暂无 Job 详情</p> : null}
        {!isLoading && !errorMessage ? jobs.map((job) => (
          <div className="rounded-lg border border-border/80 px-3 py-2" key={job.id}>
            <p>Job: {job.type}</p>
            <p>状态: {operationStatusLabels[job.status] ?? job.status}</p>
            {jobProgressItems(job).map((item) => (
              <p key={item}>{item}</p>
            ))}
            <p>更新时间: {formatDateTime(job.updatedAt)}</p>
            <p>错误: {job.lastErrorSummary ?? "无"}</p>
          </div>
        )) : null}
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
    blue: "border-[var(--blue-border)] bg-[var(--blue-soft)]",
    green: "border-[var(--green-border)] bg-[var(--green-soft)]",
    orange: "border-[var(--orange-border)] bg-[var(--orange-soft)]",
    purple: "border-[var(--purple-border)] bg-[var(--purple-soft)]",
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

function normalizeOperationJobs(value: unknown[] | undefined): OperationJobListItem[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeOperationJob).filter((job): job is OperationJobListItem => Boolean(job));
}

function normalizeOperationJob(value: unknown): OperationJobListItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const id = readString(candidate.id);
  const type = readString(candidate.type);
  const status = normalizeOperationStatus(candidate.status);
  if (!id || !type || !status) return null;
  const job: OperationJobListItem = { id, status, type };
  const createdAt = readString(candidate.createdAt);
  const updatedAt = readString(candidate.updatedAt);
  const startedAt = readNullableString(candidate.startedAt);
  const finishedAt = readNullableString(candidate.finishedAt);
  const lastErrorSummary = readNullableString(candidate.lastErrorSummary);
  if (createdAt) job.createdAt = createdAt;
  if (updatedAt) job.updatedAt = updatedAt;
  if (startedAt !== undefined) job.startedAt = startedAt;
  if (finishedAt !== undefined) job.finishedAt = finishedAt;
  if (lastErrorSummary !== undefined) job.lastErrorSummary = lastErrorSummary;
  if (isRecord(candidate.payload)) job.payload = candidate.payload;
  return job;
}

function normalizeOperationStatus(value: unknown): OperationStatus | null {
  return value === "queued"
    || value === "running"
    || value === "succeeded"
    || value === "failed"
    || value === "unsupported"
    || value === "requires_manual_step"
    || value === "cancelled"
    ? value
    : null;
}

function jobProgressItems(job: OperationJobListItem): string[] {
  const payload = job.payload ?? {};
  return [
    progressItem(payload, "阶段", "stage"),
    progressItem(payload, "消息", "message"),
    progressItem(payload, "当前版本", "currentVersion"),
    progressItem(payload, "目标版本", "targetVersion"),
    progressItem(payload, "Collector 版本", "collectorVersion"),
  ].filter((item): item is string => Boolean(item));
}

function progressItem(payload: Record<string, unknown>, label: string, key: string): string | null {
  const value = readString(payload[key]);
  return value ? `${label}: ${value}` : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatOptionalPair(type?: string | null, id?: string | null): string {
  if (!type && !id) return "无";
  return [type, id].filter(Boolean).join(" · ");
}

function formatDateTime(value?: string | null): string {
  if (!value) return "未知";
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
