import { useEffect, useMemo, useState } from "react";
import { Filter, Search, X } from "lucide-react";
import fleetFixture from "../../fixtures/runtime/runtime-fleet-device-state.sample.json";
import { useConsoleWorkbar, useHasConsoleWorkbar } from "@/components/layout/ConsoleWorkbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { RuntimeTaskCard } from "./RuntimeTaskCard";
import { RuntimeTaskDetailDialog } from "./RuntimeTaskDetailDialog";
import { formatRuntimeTimestamp } from "./runtime-fleet-query";
import { isFixtureFallbackAllowed } from "./runtime-data-source";
import {
  createRuntimeTaskBoard,
  createTasksQueryUrl,
  runtimeTaskBoardLaneDefinitions,
  runtimeTasksQueryPageFromResponse,
  type RuntimeTaskBoardFilters,
  type RuntimeTaskBoardItem,
  type RuntimeTaskBoardLane,
  type RuntimeTaskChannelKind,
  type RuntimeTaskChannelOption,
  type RuntimeTaskTimeRangeFilter,
  type RuntimeTasksQueryPage,
} from "./runtime-work-query-api";
import { createEmptyTaskStatusCounts, TASK_STATUSES, type Task, type TaskStatus, type TaskStatusCounts } from "./runtime-model";

const autoRefreshIntervalMs = 30_000;

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
  const [channelKind, setChannelKind] = useState<RuntimeTaskChannelKind | "all">("all");
  const [timeStart, setTimeStart] = useState("");
  const [timeEnd, setTimeEnd] = useState("");
  const [detailItem, setDetailItem] = useState<RuntimeTaskBoardItem | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const hasConsoleWorkbar = useHasConsoleWorkbar();

  const filters: RuntimeTaskBoardFilters = useMemo(
    () => ({
      channelKind,
      search,
      timeRange: createTimeRangeFilter(timeStart, timeEnd),
    }),
    [channelKind, search, timeEnd, timeStart],
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
    if (!options.silent) setRefreshState({ status: "running", message: "正在读取会话任务" });
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
    const statusesToLoad = statusesForFilters(overview.summary);
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
        const statusesToLoad = statusesForFilters(overview.summary);
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

  const visibleTasks = useMemo(() => flattenLaneTasks(laneStates), [laneStates]);
  const board = useMemo(() => createRuntimeTaskBoard(visibleTasks, filters, summary), [filters, summary, visibleTasks]);
  const displayedItems = board.visibleItems.length;
  const paginationMatchesFilters = loadedFiltersKey === filtersKey;
  const displayedTotal = paginationMatchesFilters ? visibleTotal(laneStates) : displayedItems;
  const attentionCount = summary.failed + summary.unknown;

  useConsoleWorkbar({
    meta: (
      <>
        <span>{displayedTotal} 任务</span>
        <span>{summary.in_progress} 进行中</span>
        <span>{attentionCount} 需关注</span>
      </>
    ),
    refresh: {
      isLoading: refreshState.status === "running",
      label: "刷新",
      onClick: () => {
        void loadLatestTasks();
      },
    },
    title: "Runs",
  }, [attentionCount, displayedTotal, filtersKey, refreshState.status, summary.in_progress]);

  async function loadMoreTasks(lane: RuntimeTaskBoardLane) {
    const statusesToLoad = lane.statuses.filter((laneStatus) =>
      laneStates[laneStatus].nextCursor && !laneStates[laneStatus].loading
    );
    if (!statusesToLoad.length || !paginationMatchesFilters) return;
    setLaneStates((current) => ({
      ...current,
      ...Object.fromEntries(
        statusesToLoad.map((laneStatus) => [
          laneStatus,
          { ...current[laneStatus], loading: true, error: undefined },
        ]),
      ),
    }));
    try {
      const pages = await Promise.all(
        statusesToLoad.map(async (laneStatus) => ({
          page: await fetchLatestTasks({ ...filters, status: laneStatus }, laneStates[laneStatus].nextCursor, { limit: 50 }),
          status: laneStatus,
        })),
      );
      setLaneStates((current) => ({
        ...current,
        ...Object.fromEntries(
          pages.map(({ page, status: laneStatus }) => [
            laneStatus,
            {
              error: undefined,
              loading: false,
              nextCursor: page.nextCursor,
              tasks: mergeTasks(current[laneStatus].tasks, page.tasks.filter((task) => task.status === laneStatus)),
              total: page.total,
            },
          ]),
        ),
      }));
      setRefreshState({ status: "success", message: "已加载更多会话任务" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载更多失败";
      setLaneStates((current) => ({
        ...current,
        ...Object.fromEntries(
          statusesToLoad.map((laneStatus) => [
            laneStatus,
            { ...current[laneStatus], error: message, loading: false },
          ]),
        ),
      }));
      setRefreshState({
        status: "error",
        message,
      });
    }
  }

  return (
    <section className="flex h-full min-w-0 flex-col gap-4 overflow-hidden" data-layout="runs-workspace">
      {hasConsoleWorkbar ? null : <h1 className="sr-only">Runs</h1>}
      {refreshState.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>读取会话任务失败</AlertTitle>
          <AlertDescription>{refreshState.message}</AlertDescription>
        </Alert>
      ) : null}

      <section className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-border bg-card p-2" aria-label="会话任务筛选">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="runs-search"
            aria-label="搜索"
            className="h-10 rounded-full border-border bg-background pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索任务、消息、发起人、Agent 或会话/群组"
          />
        </div>
        <Popover open={isFilterOpen} onOpenChange={setIsFilterOpen}>
          <PopoverTrigger asChild>
            <Button aria-label="筛选" variant="outline" size="icon-sm" type="button">
              <Filter className="size-4" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-4 p-3">
            <div className="space-y-2">
              <Label htmlFor="runs-channel-filter">渠道</Label>
              <Select
                value={channelKind}
                onValueChange={(value) => setChannelKind(value as RuntimeTaskChannelKind | "all")}
              >
                <SelectTrigger id="runs-channel-filter" className="w-full" aria-label="渠道">
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
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>时间范围</Label>
                {timeStart || timeEnd ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setTimeStart("");
                      setTimeEnd("");
                    }}
                  >
                    <X aria-hidden="true" className="size-3" />
                    清除
                  </Button>
                ) : null}
              </div>
              <div className="grid gap-2">
                <Input
                  id="runs-time-start"
                  aria-label="开始时间"
                  type="datetime-local"
                  step={1}
                  value={timeStart}
                  onChange={(event) => setTimeStart(event.target.value)}
                />
                <Input
                  id="runs-time-end"
                  aria-label="结束时间"
                  type="datetime-local"
                  step={1}
                  value={timeEnd}
                  onChange={(event) => setTimeEnd(event.target.value)}
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </section>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden">
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>已显示 {displayedItems} / {displayedTotal}</span>
          {lastLoadedAt ? <span className="hidden md:inline">更新 {formatRuntimeTimestamp(lastLoadedAt)}</span> : null}
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-2" aria-label="任务泳道">
          <div className="grid h-full min-w-max grid-flow-col auto-cols-[17.5rem] gap-3">
            {board.lanes.map((lane) => (
              <RuntimeTaskLaneView
                key={lane.key}
                lane={lane}
                laneTotal={laneTotal(lane, laneStates)}
                loading={laneIsLoading(lane, laneStates)}
                error={laneError(lane, laneStates)}
                hasNextCursor={laneHasNextCursor(lane, laneStates) && paginationMatchesFilters}
                onLoadMore={() => void loadMoreTasks(lane)}
                onSelect={(item) => {
                  setDetailItem(item);
                }}
              />
            ))}
          </div>
        </div>
      </section>

      <RuntimeTaskDetailDialog
        item={detailItem}
        open={Boolean(detailItem)}
        onOpenChange={(open) => {
          if (!open) setDetailItem(null);
        }}
      />
    </section>
  );
}

function RuntimeTaskLaneView({
  error,
  hasNextCursor,
  lane,
  laneTotal,
  loading,
  onLoadMore,
  onSelect,
}: {
  error: string;
  hasNextCursor: boolean;
  lane: RuntimeTaskBoardLane;
  laneTotal: number;
  loading: boolean;
  onLoadMore: () => void;
  onSelect: (item: RuntimeTaskBoardItem) => void;
}) {
  return (
    <section
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius)] border border-border",
        laneSurfaceClass(lane.key),
      )}
      aria-label={`${lane.label}泳道`}
      data-lane-key={lane.key}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/80 px-3 py-2">
        <h2 className="text-sm font-semibold">{lane.label}</h2>
        <span className="text-xs text-muted-foreground">{lane.items.length} / {laneTotal}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid min-h-full min-w-0 content-start gap-2.5 p-3">
          {lane.items.length ? (
            lane.items.map((item) => (
              <RuntimeTaskCard
                item={item}
                key={item.id}
                onSelect={() => onSelect(item)}
              />
            ))
          ) : (
            <p className="self-center px-4 py-28 text-center text-sm text-muted-foreground">
              当前筛选条件下没有会话任务
            </p>
          )}
          {hasNextCursor ? (
            <Button
              className="w-full"
              type="button"
              variant="outline"
              disabled={loading}
              onClick={onLoadMore}
            >
              {loading ? "加载中" : "加载更多"}
            </Button>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </ScrollArea>
    </section>
  );
}

function laneSurfaceClass(laneKey: RuntimeTaskBoardLane["key"]): string {
  if (laneKey === "in_progress") return "bg-[var(--runs-lane-progress)]";
  if (laneKey === "review") return "bg-[var(--runs-lane-review)]";
  if (laneKey === "done") return "bg-[var(--runs-lane-done)]";
  if (laneKey === "attention") return "bg-[var(--runs-lane-attention)]";
  if (laneKey === "cancelled") return "bg-[var(--runs-lane-cancelled)]";
  return "bg-[var(--runs-lane-todo)]";
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

function statusesForFilters(summary: TaskStatusCounts): TaskStatus[] {
  const statusesWithTasks = boardTaskStatuses().filter((laneStatus) => summary[laneStatus] > 0);
  return statusesWithTasks.length ? statusesWithTasks : [];
}

function flattenLaneTasks(laneStates: RuntimeTaskLaneStateByStatus): Task[] {
  return boardTaskStatuses().flatMap((laneStatus) => laneStates[laneStatus].tasks);
}

function visibleTotal(laneStates: RuntimeTaskLaneStateByStatus): number {
  return boardTaskStatuses().reduce((total, laneStatus) => total + laneStates[laneStatus].total, 0);
}

function boardTaskStatuses(): TaskStatus[] {
  return runtimeTaskBoardLaneDefinitions.flatMap((lane) => lane.statuses);
}

function laneTotal(lane: RuntimeTaskBoardLane, laneStates: RuntimeTaskLaneStateByStatus): number {
  return lane.statuses.reduce((total, laneStatus) => total + laneStates[laneStatus].total, 0);
}

function laneHasNextCursor(lane: RuntimeTaskBoardLane, laneStates: RuntimeTaskLaneStateByStatus): boolean {
  return lane.statuses.some((laneStatus) => Boolean(laneStates[laneStatus].nextCursor));
}

function laneIsLoading(lane: RuntimeTaskBoardLane, laneStates: RuntimeTaskLaneStateByStatus): boolean {
  return lane.statuses.some((laneStatus) => laneStates[laneStatus].loading);
}

function laneError(lane: RuntimeTaskBoardLane, laneStates: RuntimeTaskLaneStateByStatus): string {
  return lane.statuses.map((laneStatus) => laneStates[laneStatus].error).find(Boolean) ?? "";
}

function mergeTasks(current: Task[], next: Task[]): Task[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return Array.from(byId.values());
}
