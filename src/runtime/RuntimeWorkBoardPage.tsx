import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import fleetFixture from "../../fixtures/runtime/runtime-fleet-device-state.sample.json";
import { EmptyState } from "@/components/data/EmptyState";
import { MetricCard } from "@/components/data/MetricCard";
import { StatusBadge } from "@/components/data/StatusBadge";
import { PageHeader } from "@/components/layout/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
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

const autoRefreshIntervalMs = 30_000;
const unlinkedExecutionLabel = "未关联执行";
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
    <section className="flex min-w-0 flex-col gap-6 overflow-x-hidden">
      <PageHeader
        eyebrow="Agent / Tasks"
        title="Runs"
        description={
          <div className="space-y-1">
            <p>会话任务</p>
            <p>查看 Agent 承接的会话任务、发起人、Channel、会话/群组、消息摘要和当前状态。</p>
            {lastLoadedAt ? <p>上次刷新 {formatRuntimeTimestamp(lastLoadedAt)}</p> : null}
          </div>
        }
        actions={
          <div className="flex flex-col items-end gap-2">
            <Button
              className="gap-2"
              type="button"
              disabled={refreshState.status === "running"}
              onClick={() => {
                setRefreshState({ status: "running", message: "正在读取会话任务" });
                void loadLatestTasks();
              }}
            >
              <RefreshCw className={cn("size-4", refreshState.status === "running" && "animate-spin")} />
              {refreshState.status === "running" ? "刷新中" : "刷新任务"}
            </Button>
            {refreshState.message ? (
              <p
                className={cn(
                  "max-w-64 text-right text-xs",
                  refreshState.status === "error" ? "text-destructive" : "text-muted-foreground",
                )}
                role="status"
              >
                {refreshState.message}
              </p>
            ) : null}
          </div>
        }
      />

      {refreshState.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>读取会话任务失败</AlertTitle>
          <AlertDescription>{refreshState.message}</AlertDescription>
        </Alert>
      ) : null}

      <section
        className="grid min-w-0 gap-3 overflow-hidden rounded-lg border border-border bg-card p-3 md:grid-cols-[minmax(240px,1fr)_repeat(4,minmax(120px,auto))] md:items-end"
        aria-label="会话任务筛选"
      >
        <div className="space-y-2">
          <Label htmlFor="runs-search">搜索</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="runs-search"
              className="pl-8"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索任务、消息、发起人、Agent 或会话/群组"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="runs-channel-filter">渠道</Label>
          <Select
            value={channelKind}
            onValueChange={(value) => setChannelKind(value as RuntimeTaskChannelKind | "all")}
          >
            <SelectTrigger id="runs-channel-filter" className="w-full md:w-40" aria-label="渠道">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {channelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}（{option.count}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2 md:col-span-3">
          <Label id="runs-status-filter-label">状态</Label>
          <Tabs value={status} onValueChange={(value) => setStatus(value as TaskStatus | "all")}>
            <TabsList
              aria-labelledby="runs-status-filter-label"
              className="grid h-auto w-full grid-cols-2 sm:grid-cols-4 xl:grid-cols-9"
            >
              {statusOptions.map((option) => (
                <TabsTrigger key={option} value={option} className="h-7 text-xs" onClick={() => setStatus(option)}>
                  {statusLabels[option]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="space-y-2">
          <Label htmlFor="runs-time-start">开始时间</Label>
          <Input
            id="runs-time-start"
            aria-label="开始时间"
            type="datetime-local"
            step={1}
            value={timeStart}
            onChange={(event) => setTimeStart(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="runs-time-end">结束时间</Label>
          <Input
            id="runs-time-end"
            aria-label="结束时间"
            type="datetime-local"
            step={1}
            value={timeEnd}
            onChange={(event) => setTimeEnd(event.target.value)}
          />
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="任务概览">
        <MetricCard label="任务" value={board.summary.total} />
        <MetricCard label="待处理" value={board.summary.todo} />
        <MetricCard label="进行中" value={board.summary.in_progress} />
        <MetricCard label="失败" value={board.summary.failed} />
      </section>

      <section className="grid min-w-0 gap-4 overflow-hidden xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          <div className="text-sm text-muted-foreground">
            已显示 {displayedItems} / {displayedTotal}
          </div>
          <div className="grid min-w-0 gap-3 lg:grid-cols-2 2xl:grid-cols-4" aria-label="任务泳道">
            {board.lanes.map((lane) => (
              <section className="min-w-0 rounded-lg border border-border bg-muted/20" key={lane.status} aria-label={`${lane.label}泳道`}>
                <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                  <h2 className="text-sm font-semibold">{lane.label}</h2>
                  <span className="text-xs text-muted-foreground">{lane.items.length} / {laneStates[lane.status].total}</span>
                </div>
                <ScrollArea className="h-[32rem]">
                  <div className="workLaneItems space-y-3 p-3">
                    {lane.items.length ? (
                      lane.items.map((item) => (
                        <TaskCard
                          active={item.id === selectedItem?.id}
                          item={item}
                          key={item.id}
                          onSelect={() => setSelectedId(item.id)}
                        />
                      ))
                    ) : (
                      <EmptyState title="无匹配项" description="当前筛选条件下没有会话任务。" />
                    )}
                    {laneStates[lane.status].nextCursor && paginationMatchesFilters ? (
                      <Button
                        className="w-full"
                        type="button"
                        variant="outline"
                        disabled={laneStates[lane.status].loading}
                        onClick={() => void loadMoreTasks(lane.status)}
                      >
                        {laneStates[lane.status].loading ? "加载中" : "加载更多"}
                      </Button>
                    ) : null}
                    {laneStates[lane.status].error ? (
                      <Alert variant="destructive">
                        <AlertDescription>{laneStates[lane.status].error}</AlertDescription>
                      </Alert>
                    ) : null}
                  </div>
                </ScrollArea>
              </section>
            ))}
          </div>
        </div>
        <TaskDetail item={selectedItem} />
      </section>
    </section>
  );
}

function TaskCard({
  active,
  item,
  onSelect,
}: {
  active: boolean;
  item: RuntimeTaskBoardItem;
  onSelect: () => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  }

  return (
    <Card
      aria-pressed={active}
      className={cn(
        "min-w-0 cursor-pointer gap-3 overflow-hidden text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "ring-2 ring-ring",
      )}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      size="sm"
      tabIndex={0}
    >
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={statusTone(item.status)}>{item.statusLabel}</StatusBadge>
          {item.channelKindLabel ? <Badge variant="outline">{item.channelKindLabel}</Badge> : null}
          <StatusBadge tone="neutral">{unlinkedExecutionLabel}</StatusBadge>
        </div>
        <CardTitle className="break-words text-sm" title={item.userMessage ?? item.displayTitle}>
          {item.displayTitle}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="break-words text-sm text-muted-foreground">{item.requestExcerpt}</p>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>发起人 {item.creatorLabel}</p>
          <p>承接 Agent {item.assigneeLabel}</p>
          <p className="break-words">
            会话/群组 {item.channelLabel ?? "未上报"}
            {item.updatedAt ?? item.createdAt ? ` · ${formatRuntimeTimestamp(item.updatedAt ?? item.createdAt)}` : ""}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function TaskDetail({ item }: { item: RuntimeTaskBoardItem | null }) {
  if (!item) {
    return (
      <aside aria-label="任务详情">
        <EmptyState title="任务详情" description="选择一个任务查看详情。" />
      </aside>
    );
  }

  return (
    <aside aria-label="任务详情">
      <Card className="sticky top-4 min-w-0">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={statusTone(item.status)}>{item.statusLabel}</StatusBadge>
            <StatusBadge tone="neutral">{unlinkedExecutionLabel}</StatusBadge>
            {item.channelKindLabel ? <Badge variant="outline">{item.channelKindLabel}</Badge> : null}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Task</p>
            <h2 className="break-words text-lg font-semibold" title={item.userMessage ?? item.displayTitle}>
              {item.displayTitle}
            </h2>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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
              `执行关联: ${unlinkedExecutionLabel}`,
              ...(item.error ? [`最近错误: ${item.error}`] : []),
            ]}
          />
          <DetailBlock title="用户消息">{item.userMessage ?? "未上报用户消息"}</DetailBlock>
          {item.agentReply ? <DetailBlock title="Agent 回复">{item.agentReply}</DetailBlock> : null}
        </CardContent>
      </Card>
    </aside>
  );
}

function DetailBlock({ title, children }: { title: string; children: string }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="break-words text-sm text-muted-foreground">{children}</p>
    </section>
  );
}

function DetailList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {items.map((item) => (
            <li className="break-words" key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">暂无</p>
      )}
    </section>
  );
}

function statusTone(status: TaskStatus): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "done") return "success";
  if (status === "failed" || status === "blocked") return "danger";
  if (status === "in_progress" || status === "review") return "info";
  if (status === "todo") return "warning";
  return "neutral";
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
