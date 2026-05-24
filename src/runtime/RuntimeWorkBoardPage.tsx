import { useEffect, useMemo, useState } from "react";
import fleetFixture from "../../fixtures/runtime/runtime-fleet-device-state.sample.json";
import { formatRuntimeTimestamp } from "./runtime-fleet-query";
import { isFixtureFallbackAllowed } from "./runtime-data-source";
import {
  createRuntimeTaskBoard,
  createTasksQueryUrl,
  runtimeTasksQueryPageFromResponse,
  taskStatusLabels,
  type RuntimeTaskBoardFilters,
  type RuntimeTaskBoardItem,
  type RuntimeTaskChannelKind,
  type RuntimeTaskChannelOption,
  type RuntimeTaskTimeRangeFilter,
  type RuntimeTasksQueryPage,
} from "./runtime-work-query-api";
import { createEmptyTaskStatusCounts, TASK_STATUSES, type Task, type TaskStatus, type TaskStatusCounts } from "./runtime-model";
import { PixelIcon } from "../ui/PixelIcon";

const autoRefreshIntervalMs = 30_000;
const statusOptions: Array<TaskStatus | "all"> = ["all", ...TASK_STATUSES];
const statusLabels: Record<TaskStatus | "all", string> = {
  all: "全部",
  ...taskStatusLabels,
};

const fixtureTasks = runtimeTasksQueryPageFromResponse({
  items: (fleetFixture as { tasks?: unknown[] }).tasks ?? [],
  total: (fleetFixture as { tasks?: unknown[] }).tasks?.length ?? 0,
})?.tasks ?? [];
const fixtureSummary = createRuntimeTaskBoard(fixtureTasks).summary;
const fixtureLaneStates = createLaneStatesFromTasks(fixtureTasks, fixtureSummary);
const defaultFiltersKey = createRuntimeTaskFiltersKey();

interface RuntimeTaskLaneState {
  tasks: Task[];
  total: number;
  nextCursor?: string;
  loading: boolean;
  error?: string;
}

type RuntimeTaskLaneStateByStatus = Record<TaskStatus, RuntimeTaskLaneState>;

/** Read-only board for normalized Agent Tasks. */
export function RuntimeWorkBoardPage() {
  const allowFixtureFallback = isFixtureFallbackAllowed();
  const [laneStates, setLaneStates] = useState<RuntimeTaskLaneStateByStatus>(
    allowFixtureFallback ? fixtureLaneStates : createEmptyLaneStates(),
  );
  const [summary, setSummary] = useState<TaskStatusCounts>(
    allowFixtureFallback ? fixtureSummary : createEmptyTaskStatusCounts(),
  );
  const [channelOptions, setChannelOptions] = useState<RuntimeTaskChannelOption[]>(
    allowFixtureFallback ? [{ count: fixtureTasks.length, label: "DingTalk", value: "dingtalk" }] : [],
  );
  const [loadedFiltersKey, setLoadedFiltersKey] = useState(defaultFiltersKey);
  const [refreshState, setRefreshState] = useState<{
    status: "idle" | "running" | "success" | "error";
    message: string;
  }>({ status: "idle", message: "" });
  const [lastLoadedAt, setLastLoadedAt] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TaskStatus | "all">("all");
  const [channelKind, setChannelKind] = useState<RuntimeTaskChannelKind | "all">("all");
  const [timeStart, setTimeStart] = useState("");
  const [timeEnd, setTimeEnd] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filters: RuntimeTaskBoardFilters = useMemo(
    () => ({
      channelKind,
      search,
      status,
      timeRange: createTimeRangeFilter(timeStart, timeEnd),
    }),
    [channelKind, search, status, timeEnd, timeStart],
  );
  const filtersKey = useMemo(() => createRuntimeTaskFiltersKey(filters), [filters]);

  async function fetchLatestTasks(
    filterOptions?: RuntimeTaskBoardFilters,
    cursor?: string,
    options: { limit?: number } = {},
  ): Promise<RuntimeTasksQueryPage> {
    const queryResponse = await fetch(createTasksQueryUrl(window.location.origin, filterOptions, {
      cursor,
      limit: options.limit,
    }));
    if (!queryResponse.ok) throw new Error(`runtime task query failed: ${queryResponse.status}`);
    const queryPage = runtimeTasksQueryPageFromResponse(await queryResponse.json());
    if (!queryPage) throw new Error("runtime task query returned an invalid payload");
    return queryPage;
  }

  async function loadLatestTasks(options: { silent?: boolean } = {}) {
    try {
      await loadTaskDashboard();
      if (!options.silent) setRefreshState({ status: "success", message: "已读取最新会话任务" });
    } catch (error) {
      if (!options.silent) {
        setRefreshState({
          status: "error",
          message: error instanceof Error ? error.message : "读取会话任务失败",
        });
      }
    }
  }

  async function loadTaskDashboard(): Promise<void> {
    const overview = await fetchLatestTasks(filters, undefined, { limit: 1 });
    const statusesToLoad = statusesForFilters(overview.summary, status);
    const lanePages = await Promise.all(
      statusesToLoad.map(async (laneStatus) => ({
        page: await fetchLatestTasks({ ...filters, status: laneStatus }, undefined, { limit: 50 }),
        status: laneStatus,
      })),
    );
    setSummary(overview.summary);
    setChannelOptions(overview.channelOptions);
    setLaneStates(createLaneStatesFromPages(overview.summary, lanePages));
    setLoadedFiltersKey(filtersKey);
    setLastLoadedAt(new Date().toISOString());
  }

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;

    async function loadTasksForFilters() {
      try {
        const overview = await fetchLatestTasks(filters, undefined, { limit: 1 });
        const statusesToLoad = statusesForFilters(overview.summary, status);
        const lanePages = await Promise.all(
          statusesToLoad.map(async (laneStatus) => ({
            page: await fetchLatestTasks({ ...filters, status: laneStatus }, undefined, { limit: 50 }),
            status: laneStatus,
          })),
        );
        if (cancelled) return;
        setSummary(overview.summary);
        setChannelOptions(overview.channelOptions);
        setLaneStates(createLaneStatesFromPages(overview.summary, lanePages));
        setLoadedFiltersKey(filtersKey);
        setLastLoadedAt(new Date().toISOString());
      } catch {
        if (!allowFixtureFallback && !cancelled) {
          setRefreshState({ status: "error", message: "后端查询失败，无法读取会话任务" });
        }
      }
    }

    const debounceTimer = window.setTimeout(() => {
      void loadTasksForFilters();
      refreshTimer = window.setInterval(() => {
        void loadTasksForFilters();
      }, autoRefreshIntervalMs);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    };
  }, [allowFixtureFallback, filters, filtersKey]);

  useEffect(() => {
    if (channelKind !== "all" && !channelOptions.some((option) => option.value === channelKind)) {
      setChannelKind("all");
    }
  }, [channelKind, channelOptions]);

  const visibleTasks = useMemo(() => flattenLaneTasks(laneStates, status), [laneStates, status]);
  const board = useMemo(() => createRuntimeTaskBoard(visibleTasks, filters, summary), [filters, summary, visibleTasks]);
  const selectedItem = selectedId ? board.visibleItems.find((item) => item.id === selectedId) ?? null : board.visibleItems[0] ?? null;
  const displayedItems = board.visibleItems.length;
  const paginationMatchesFilters = loadedFiltersKey === filtersKey;
  const displayedTotal = paginationMatchesFilters ? visibleTotal(laneStates, summary, status) : displayedItems;

  async function loadMoreTasks(laneStatus: TaskStatus) {
    const lane = laneStates[laneStatus];
    if (!lane.nextCursor || lane.loading || !paginationMatchesFilters) return;
    setLaneStates((current) => ({
      ...current,
      [laneStatus]: { ...current[laneStatus], loading: true, error: undefined },
    }));
    try {
      const page = await fetchLatestTasks({ ...filters, status: laneStatus }, lane.nextCursor, { limit: 50 });
      setLaneStates((current) => ({
        ...current,
        [laneStatus]: {
          error: undefined,
          loading: false,
          nextCursor: page.nextCursor,
          tasks: mergeTasks(current[laneStatus].tasks, page.tasks.filter((task) => task.status === laneStatus)),
          total: page.total,
        },
      }));
      setRefreshState({ status: "success", message: "已加载更多会话任务" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载更多失败";
      setLaneStates((current) => ({
        ...current,
        [laneStatus]: { ...current[laneStatus], error: message, loading: false },
      }));
      setRefreshState({
        status: "error",
        message,
      });
    }
  }

  return (
    <section className="workspace">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Agent / Tasks</p>
          <h1>会话任务</h1>
          <p className="pageSubtitle">
            查看 Agent 承接的会话任务、发起人、Channel、会话/群组、消息摘要和当前状态。
          </p>
          <p className="pageRefreshMeta">
            {lastLoadedAt ? `上次刷新 ${formatRuntimeTimestamp(lastLoadedAt)}` : ""}
          </p>
        </div>
        <div className="refreshControl">
          <button
            className="primaryButton"
            type="button"
            disabled={refreshState.status === "running"}
            onClick={() => {
              setRefreshState({ status: "running", message: "正在读取会话任务" });
              void loadLatestTasks();
            }}
          >
            <PixelIcon name="reload" size={16} />
            {refreshState.status === "running" ? "刷新中" : "刷新任务"}
          </button>
          {refreshState.message ? (
            <p className={`refreshMessage refresh-${refreshState.status}`} role="status">
              {refreshState.message}
            </p>
          ) : null}
        </div>
      </header>

      <section className="toolbar workBoardToolbar" aria-label="会话任务筛选">
        <label className="toolbarField toolbarSearch">
          <span className="controlLabel">搜索</span>
          <span className="searchBox">
            <PixelIcon name="search" size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索任务、消息、发起人、Agent 或会话/群组"
            />
          </span>
        </label>

        <label className="toolbarField">
          <span className="controlLabel">渠道</span>
          <select
            value={channelKind}
            onChange={(event) => setChannelKind(event.target.value as RuntimeTaskChannelKind | "all")}
          >
            <option value="all">全部</option>
            {channelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}（{option.count}）
              </option>
            ))}
          </select>
        </label>

        <label className="toolbarField">
          <span className="controlLabel">状态</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus | "all")}>
            {statusOptions.map((option) => (
              <option key={option} value={option}>
                {statusLabels[option]}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbarField">
          <span className="controlLabel">开始时间</span>
          <input
            aria-label="开始时间"
            type="datetime-local"
            step={1}
            value={timeStart}
            onChange={(event) => setTimeStart(event.target.value)}
          />
        </label>

        <label className="toolbarField">
          <span className="controlLabel">结束时间</span>
          <input
            aria-label="结束时间"
            type="datetime-local"
            step={1}
            value={timeEnd}
            onChange={(event) => setTimeEnd(event.target.value)}
          />
        </label>
      </section>

      <section className="metricGrid" aria-label="任务概览">
        <Metric label="任务" value={board.summary.total} tone="blue" />
        <Metric label="待处理" value={board.summary.todo} tone="purple" />
        <Metric label="进行中" value={board.summary.in_progress} tone="green" />
        <Metric label="失败" value={board.summary.failed} tone="orange" />
      </section>

      <section className="workBoardGrid">
        <div className="workBoardMain">
          <div className="boardResultMeta">
            <span>已显示 {displayedItems} / {displayedTotal}</span>
          </div>
          <div className="workBoardLanes" aria-label="任务泳道">
            {board.lanes.map((lane) => (
              <section className="workLane" key={lane.status} aria-label={`${lane.label}泳道`}>
                <div className="workLaneHeader">
                  <h2>{lane.label}</h2>
                  <span>{lane.items.length} / {laneStates[lane.status].total}</span>
                </div>
                <div className="workLaneItems">
                  {lane.items.length ? (
                    lane.items.map((item) => (
                      <button
                        className={item.id === selectedItem?.id ? "workCard workCardActive" : "workCard"}
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedId(item.id)}
                      >
                        <span className="workCardTopline">
                          <Badge>{item.statusLabel}</Badge>
                          {item.channelKindLabel ? <Badge>{item.channelKindLabel}</Badge> : null}
                        </span>
                        <strong>{item.displayTitle}</strong>
                        <small>{item.requestExcerpt}</small>
                        <span className="workCardMeta">发起人 {item.creatorLabel}</span>
                        <span className="workCardMeta">承接 Agent {item.assigneeLabel}</span>
                        <span className="workCardMeta">
                          会话/群组 {item.channelLabel ?? "未上报"}
                          {item.updatedAt ?? item.createdAt ? ` · ${formatRuntimeTimestamp(item.updatedAt ?? item.createdAt)}` : ""}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="emptyLane">无匹配项</p>
                  )}
                  {laneStates[lane.status].nextCursor && paginationMatchesFilters ? (
                    <button
                      className="loadMoreButton"
                      type="button"
                      disabled={laneStates[lane.status].loading}
                      onClick={() => void loadMoreTasks(lane.status)}
                    >
                      {laneStates[lane.status].loading ? "加载中" : "加载更多"}
                    </button>
                  ) : null}
                  {laneStates[lane.status].error ? (
                    <p className="refreshMessage refresh-error" role="status">{laneStates[lane.status].error}</p>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </div>
        <TaskDetail item={selectedItem} />
      </section>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`metricCard metric${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TaskDetail({ item }: { item: RuntimeTaskBoardItem | null }) {
  if (!item) {
    return (
      <aside className="detailPanel workBoardDetailPanel" aria-label="任务详情">
        <h2>任务详情</h2>
        <p>选择一个任务查看详情。</p>
      </aside>
    );
  }

  return (
    <aside className="detailPanel workBoardDetailPanel" aria-label="任务详情">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">Task</p>
          <h2 className="detailTitle" title={item.userMessage ?? item.displayTitle}>{item.displayTitle}</h2>
        </div>
        <StatusPill>{item.statusLabel}</StatusPill>
      </div>
      <DetailBlock title="概览">{`${item.statusLabel} · ${item.agentId}`}</DetailBlock>
      <DetailList
        title="任务上下文"
        items={[
          `Channel: ${item.channelKindLabel ?? "默认渠道"}`,
          `发起人: ${item.creatorLabel}`,
          `承接 Agent: ${item.assigneeLabel}`,
          `会话/群组: ${item.channelLabel ?? "未上报"}`,
        ]}
      />
      <DetailList
        title="最近状态"
        items={[
          `最近更新: ${formatRuntimeTimestamp(item.updatedAt ?? item.createdAt)}`,
          `任务状态: ${item.statusLabel}`,
          ...(item.error ? [`最近错误: ${item.error}`] : []),
        ]}
      />
      <DetailBlock title="用户消息">{item.userMessage ?? "未上报用户消息"}</DetailBlock>
      {item.agentReply ? <DetailBlock title="Agent 回复">{item.agentReply}</DetailBlock> : null}
    </aside>
  );
}

function DetailBlock({ title, children }: { title: string; children: string }) {
  return (
    <section className="detailBlock">
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  );
}

function DetailList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="detailBlock">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mutedText">暂无</p>
      )}
    </section>
  );
}

function Badge({ children }: { children: string }) {
  return <span className="badge">{children}</span>;
}

function StatusPill({ children }: { children: string }) {
  return <span className="statusBadge">{children}</span>;
}

function createTimeRangeFilter(start: string, end: string): RuntimeTaskTimeRangeFilter | undefined {
  const normalizedStart = start.trim();
  const normalizedEnd = end.trim();
  if (!normalizedStart && !normalizedEnd) return undefined;
  return {
    start: normalizedStart || undefined,
    end: normalizedEnd || undefined,
  };
}

function createRuntimeTaskFiltersKey(filters?: RuntimeTaskBoardFilters): string {
  return JSON.stringify({
    channelKind: filters?.channelKind ?? "all",
    search: filters?.search?.trim() ?? "",
    status: filters?.status ?? "all",
    timeEnd: filters?.timeRange?.end ?? "",
    timeStart: filters?.timeRange?.start ?? "",
  });
}

function createEmptyLaneStates(summary: TaskStatusCounts = createEmptyTaskStatusCounts()): RuntimeTaskLaneStateByStatus {
  const lanes = {} as RuntimeTaskLaneStateByStatus;
  for (const laneStatus of TASK_STATUSES) {
    lanes[laneStatus] = {
      loading: false,
      tasks: [],
      total: summary[laneStatus],
    };
  }
  return lanes;
}

function createLaneStatesFromTasks(tasks: Task[], summary: TaskStatusCounts): RuntimeTaskLaneStateByStatus {
  const lanes = createEmptyLaneStates(summary);
  for (const laneStatus of TASK_STATUSES) {
    lanes[laneStatus] = {
      loading: false,
      tasks: tasks.filter((task) => task.status === laneStatus),
      total: summary[laneStatus],
    };
  }
  return lanes;
}

function createLaneStatesFromPages(
  summary: TaskStatusCounts,
  pages: Array<{ status: TaskStatus; page: RuntimeTasksQueryPage }>,
): RuntimeTaskLaneStateByStatus {
  const lanes = createEmptyLaneStates(summary);
  for (const { page, status } of pages) {
    lanes[status] = {
      loading: false,
      nextCursor: page.nextCursor,
      tasks: page.tasks.filter((task) => task.status === status),
      total: page.total,
    };
  }
  return lanes;
}

function statusesForFilters(summary: TaskStatusCounts, status: TaskStatus | "all"): TaskStatus[] {
  if (status !== "all") return [status];
  const statusesWithTasks = TASK_STATUSES.filter((laneStatus) => summary[laneStatus] > 0);
  return statusesWithTasks.length ? statusesWithTasks : [];
}

function flattenLaneTasks(laneStates: RuntimeTaskLaneStateByStatus, status: TaskStatus | "all"): Task[] {
  const statuses = status === "all" ? TASK_STATUSES : [status];
  return statuses.flatMap((laneStatus) => laneStates[laneStatus].tasks);
}

function visibleTotal(
  laneStates: RuntimeTaskLaneStateByStatus,
  summary: TaskStatusCounts,
  status: TaskStatus | "all",
): number {
  if (status === "all") return summary.total;
  return laneStates[status].total;
}

function mergeTasks(current: Task[], next: Task[]): Task[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return Array.from(byId.values());
}
