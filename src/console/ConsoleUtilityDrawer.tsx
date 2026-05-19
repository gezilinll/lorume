import { useEffect, useMemo, useState } from "react";
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
  onOpen: (view: ConsoleUtilityView) => void;
}

interface ConsoleUtilityDrawerProps {
  organizationId?: string;
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
export function ConsoleUtilityBar({ activeView, organizationId, onOpen }: ConsoleUtilityBarProps) {
  const [operationCount, setOperationCount] = useState(0);
  const [notificationCount, setNotificationCount] = useState(0);

  useEffect(() => {
    if (!organizationId) {
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
  }, [organizationId]);

  return (
    <div className="consoleUtilityBar" aria-label="控制台工具">
      <button
        aria-label={`任务 ${operationCount}`}
        aria-pressed={activeView === "operations"}
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
        aria-pressed={activeView === "notifications"}
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
export function ConsoleUtilityDrawer({ organizationId, view, onClose }: ConsoleUtilityDrawerProps) {
  if (!view) return null;
  const title = view === "operations" ? "任务" : "通知";

  return (
    <div className="utilityDrawerOverlay" role="presentation">
      <aside className="utilityDrawer" role="dialog" aria-modal="false" aria-label={title}>
        <header className="utilityDrawerHeader">
          <div>
            <p className="eyebrow">{view === "operations" ? "Operations" : "Notifications"}</p>
            <h2>{title}</h2>
          </div>
          <button className="iconButton" type="button" aria-label={`关闭${title}`} onClick={onClose}>
            <PixelIcon name="close" size={18} />
          </button>
        </header>
        {view === "operations" ? (
          <OperationsDrawer organizationId={organizationId} />
        ) : (
          <NotificationsDrawer organizationId={organizationId} />
        )}
      </aside>
    </div>
  );
}

function OperationsDrawer({ organizationId }: { organizationId?: string }) {
  const [operations, setOperations] = useState<OperationListItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
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
  }, [organizationId]);

  const selectedOperation = operations.find((operation) => operation.id === selectedId) ?? operations[0] ?? null;
  const summary = useMemo(() => ({
    active: operations.filter((operation) => activeOperationStatuses.has(operation.status)).length,
    failed: operations.filter((operation) => operation.status === "failed").length,
    total: operations.length,
  }), [operations]);

  if (!organizationId) {
    return <p className="utilityDrawerEmpty">请选择组织后查看任务。</p>;
  }

  return (
    <div className="utilityDrawerBody">
      <section className="utilitySummaryGrid" aria-label="任务概览">
        <UtilityMetric label="任务总数" value={summary.total} tone="blue" />
        <UtilityMetric label="进行中" value={summary.active} tone="green" />
        <UtilityMetric label="失败" value={summary.failed} tone="orange" />
      </section>
      {errorMessage ? <p className="skillErrorMessage">{errorMessage}</p> : null}
      <section className="utilitySplit">
        <div className="utilityListPanel" aria-label="任务列表">
          <div className="utilityPanelTitle">
            <strong>任务列表</strong>
            <span>{isLoading ? "读取中" : `${operations.length} 个任务`}</span>
          </div>
          {operations.length === 0 ? (
            <p className="emptyAsset">暂无任务。</p>
          ) : (
            <div className="utilityList">
              {operations.map((operation) => (
                <button
                  className={operation.id === selectedOperation?.id ? "utilityListItem utilityListItemActive" : "utilityListItem"}
                  key={operation.id}
                  type="button"
                  onClick={() => setSelectedId(operation.id)}
                >
                  <strong>{operation.summary}</strong>
                  <span>{operation.type} · {operationStatusLabels[operation.status] ?? operation.status}</span>
                  <small>{formatDateTime(operation.updatedAt)}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <OperationDrawerDetail operation={selectedOperation} />
      </section>
    </div>
  );
}

function NotificationsDrawer({ organizationId }: { organizationId?: string }) {
  const [notifications, setNotifications] = useState<NotificationThread[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
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
  }, [organizationId]);

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
    return <p className="utilityDrawerEmpty">请选择组织后查看通知。</p>;
  }

  return (
    <div className="utilityDrawerBody">
      <section className="utilitySummaryGrid" aria-label="通知概览">
        <UtilityMetric label="通知总数" value={summary.total} tone="blue" />
        <UtilityMetric label="未读" value={summary.unread} tone="orange" />
        <UtilityMetric label="高风险" value={summary.critical} tone="purple" />
      </section>
      {errorMessage ? <p className="skillErrorMessage">{errorMessage}</p> : null}
      <section className="utilitySplit">
        <div className="utilityListPanel" aria-label="通知列表">
          <div className="utilityPanelTitle">
            <strong>通知列表</strong>
            <span>{isLoading ? "读取中" : `${notifications.length} 条通知`}</span>
          </div>
          {notifications.length === 0 ? (
            <p className="emptyAsset">暂无通知。</p>
          ) : (
            <div className="utilityList">
              {notifications.map((notification) => (
                <button
                  className={notification.id === selectedNotification?.id ? "utilityListItem utilityListItemActive" : "utilityListItem"}
                  key={notification.id}
                  type="button"
                  onClick={() => void selectNotification(notification)}
                >
                  <span className="utilityItemHeader">
                    <strong>{notification.title}</strong>
                    <span className={notification.isRead ? "utilityReadBadge" : "utilityUnreadBadge"}>
                      {notification.isRead ? "已读" : "未读"}
                    </span>
                  </span>
                  <span>
                    {notificationSeverityLabels[notification.severity] ?? notification.severity} ·{" "}
                    {notificationStatusLabels[notification.status] ?? notification.status}
                  </span>
                  <small>{formatDateTime(notification.lastOccurredAt)}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <NotificationDrawerDetail notification={selectedNotification} />
      </section>
    </div>
  );
}

function OperationDrawerDetail({ operation }: { operation: OperationListItem | null }) {
  if (!operation) {
    return (
      <aside className="utilityDetailPanel" aria-label="任务详情">
        <h3>任务详情</h3>
        <p>选择一个任务查看目标、状态和失败原因。</p>
      </aside>
    );
  }

  return (
    <aside className="utilityDetailPanel" aria-label="任务详情">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">Operation</p>
          <h3>{operation.summary}</h3>
        </div>
        <span className={`statusBadge status-${operation.status}`}>
          {operationStatusLabels[operation.status] ?? operation.status}
        </span>
      </div>
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
    </aside>
  );
}

function NotificationDrawerDetail({ notification }: { notification: NotificationThread | null }) {
  if (!notification) {
    return (
      <aside className="utilityDetailPanel" aria-label="通知详情">
        <h3>通知详情</h3>
        <p>选择一条通知查看范围、状态和最近摘要。</p>
      </aside>
    );
  }

  return (
    <aside className="utilityDetailPanel" aria-label="通知详情">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">Notification</p>
          <h3>{notification.title}</h3>
        </div>
        <span className={`statusBadge status-${notification.status}`}>
          {notificationStatusLabels[notification.status] ?? notification.status}
        </span>
      </div>
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
      <section className="detailBlock">
        <h4>摘要</h4>
        <p>{notification.latestSummary}</p>
      </section>
    </aside>
  );
}

function UtilityMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`metricCard metric${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UtilityDetailList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="detailBlock">
      <h4>{title}</h4>
      <ul>
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
