import { useEffect, useMemo, useState } from "react";
import { format, endOfDay, startOfDay } from "date-fns";
import { CalendarIcon, Filter, Search, X } from "lucide-react";
import { type DateRange } from "react-day-picker";
import fleetFixture from "../../fixtures/runtime/runtime-fleet-device-state.sample.json";
import { useConsoleWorkbar, useHasConsoleWorkbar } from "@/components/layout/ConsoleWorkbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  filterMenuCheckboxItemClass,
  filterMenuContentClass,
  filterMenuItemClass,
  filterMenuLabelClass,
  filterMenuSeparatorClass,
  filterMenuSubTriggerClass,
} from "@/components/data/filter-menu-styles";
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
export function RuntimeWorkBoardPage({ organizationId }: { organizationId?: string }) {
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
  const [selectedChannelKinds, setSelectedChannelKinds] = useState<RuntimeTaskChannelKind[]>([]);
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [detailItem, setDetailItem] = useState<RuntimeTaskBoardItem | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const hasConsoleWorkbar = useHasConsoleWorkbar();

  const filters: RuntimeTaskBoardFilters = useMemo(
    () => ({
      channelKinds: selectedChannelKinds,
      organizationId,
      search,
      timeRange: createDateRangeFilter(dateRange),
    }),
    [dateRange, organizationId, search, selectedChannelKinds],
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
    setSelectedChannelKinds((current) => {
      const next = current.filter((channelKind) => channelOptions.some((option) => option.value === channelKind));
      if (next.length === current.length && next.every((channelKind, index) => channelKind === current[index])) {
        return current;
      }
      return next;
    });
  }, [channelOptions]);

  const visibleTasks = useMemo(() => flattenLaneTasks(laneStates), [laneStates]);
  const board = useMemo(() => createRuntimeTaskBoard(visibleTasks, filters, summary), [filters, summary, visibleTasks]);
  const displayedItems = board.visibleItems.length;
  const paginationMatchesFilters = loadedFiltersKey === filtersKey;
  const displayedTotal = paginationMatchesFilters ? visibleTotal(laneStates) : displayedItems;
  const attentionCount = summary.failed + summary.unknown;
  const activeFilterCount = selectedChannelKinds.length;

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

      <section className="flex min-w-0 flex-wrap items-center gap-2 rounded-[13px] border border-border bg-card p-2 shadow-[0_1px_2px_rgba(16,24,40,0.035)]" aria-label="会话任务筛选">
        <div className="relative min-w-[260px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="runs-search"
            aria-label="搜索"
            className="h-[34px] rounded-[10px] border-border bg-background pl-9 text-xs shadow-[0_1px_2px_rgba(16,24,40,0.025)]"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索任务、消息、发起人、Agent 或会话/群组"
          />
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              aria-label="日期范围"
              variant="outline"
              className="min-w-[154px] justify-start bg-background px-2.5 font-normal"
              type="button"
            >
              <CalendarIcon aria-hidden="true" className="size-4" />
              <span className="min-w-0 truncate">{formatDateRangeLabel(dateRange)}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] overflow-auto p-0" align="end">
            <Calendar
              mode="range"
              defaultMonth={dateRange?.from}
              selected={dateRange}
              onSelect={setDateRange}
              numberOfMonths={2}
            />
            {dateRange?.from || dateRange?.to ? (
              <div className="border-t border-border p-2">
                <Button
                  className="w-full justify-center"
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDateRange(undefined)}
                >
                  <X aria-hidden="true" className="size-3.5" />
                  清除日期
                </Button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>

        <DropdownMenu open={isFilterOpen} onOpenChange={setIsFilterOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={activeFilterCount ? `筛选，已启用 ${activeFilterCount} 个筛选` : "筛选"}
              variant={activeFilterCount ? "default" : "outline"}
              className={cn(
                "px-3",
                activeFilterCount && "border-[var(--active-filter)] bg-[var(--active-filter)] text-[var(--active-filter-foreground)] hover:bg-[var(--active-filter)]/90",
              )}
              type="button"
            >
              <Filter className="size-4" aria-hidden="true" />
              <span>{activeFilterCount ? `${activeFilterCount} 个筛选` : "筛选"}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label="筛选"
            className={cn("w-[206px]", filterMenuContentClass)}
          >
            <DropdownMenuLabel className={filterMenuLabelClass}>筛选</DropdownMenuLabel>
            <DropdownMenuSeparator className={filterMenuSeparatorClass} />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={filterMenuSubTriggerClass}>
                <span className="min-w-0 flex-1 truncate">渠道</span>
                <span className="mr-1 text-xs text-muted-foreground">
                  {activeFilterCount || ""}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                aria-label="渠道筛选"
                sideOffset={8}
                className={cn("w-[238px]", filterMenuContentClass)}
              >
                <DropdownMenuLabel className={filterMenuLabelClass}>渠道</DropdownMenuLabel>
                <DropdownMenuSeparator className={filterMenuSeparatorClass} />
                <DropdownMenuCheckboxItem
                  checked={selectedChannelKinds.length === 0}
                  className={filterMenuCheckboxItemClass(selectedChannelKinds.length === 0)}
                  onCheckedChange={() => setSelectedChannelKinds([])}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="min-w-0 flex-1 truncate">全部</span>
                </DropdownMenuCheckboxItem>
                {channelOptions.map((option) => (
                  <DropdownMenuCheckboxItem
                    checked={selectedChannelKinds.includes(option.value)}
                    className={filterMenuCheckboxItemClass(selectedChannelKinds.includes(option.value))}
                    key={option.value}
                    onCheckedChange={(checked) => {
                      setSelectedChannelKinds((current) => toggleSelectedChannel(current, option.value, Boolean(checked)));
                    }}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{option.count}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {activeFilterCount ? (
              <>
                <DropdownMenuSeparator className={filterMenuSeparatorClass} />
                <DropdownMenuItem
                  className={filterMenuItemClass}
                  onSelect={() => {
                    setSelectedChannelKinds([]);
                    setIsFilterOpen(false);
                  }}
                >
                  重置全部筛选
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="sr-only" aria-live="polite">
          当前渠道：{selectedChannelLabel(selectedChannelKinds, channelOptions)}
        </span>
      </section>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>已显示 {displayedItems} / {displayedTotal}</span>
          {lastLoadedAt ? <span className="hidden md:inline">更新 {formatRuntimeTimestamp(lastLoadedAt)}</span> : null}
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-2" aria-label="任务泳道">
          <div className="grid h-full w-full min-w-[1231px] max-w-[1756px] grid-cols-5 gap-[var(--runs-lane-gap)]">
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
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[12px] border border-border shadow-[0_1px_2px_rgba(16,24,40,0.03)]",
        laneSurfaceClass(lane.key),
      )}
      aria-label={`${lane.label}泳道`}
      data-lane-key={lane.key}
    >
      <div className="flex min-h-11 items-center justify-center gap-3 border-b border-border/80 px-3 py-2">
        <h2 className="text-[13px] font-medium tracking-normal text-foreground">{lane.label}</h2>
        <span className="sr-only">{lane.items.length} / {laneTotal}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid min-h-full min-w-0 content-start gap-3 p-3">
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
  return "bg-[var(--runs-lane-todo)]";
}

function selectedChannelLabel(
  selectedChannelKinds: RuntimeTaskChannelKind[],
  channelOptions: RuntimeTaskChannelOption[],
): string {
  if (selectedChannelKinds.length === 0) return "全部";
  return selectedChannelKinds
    .map((channelKind) => channelOptions.find((option) => option.value === channelKind)?.label ?? channelKind)
    .join("、");
}

function toggleSelectedChannel(
  current: RuntimeTaskChannelKind[],
  channelKind: RuntimeTaskChannelKind,
  checked: boolean,
): RuntimeTaskChannelKind[] {
  if (checked) return Array.from(new Set([...current, channelKind])).sort();
  return current.filter((value) => value !== channelKind);
}

function formatDateRangeLabel(dateRange: DateRange | undefined): string {
  if (!dateRange?.from) return "选择日期范围";
  if (!dateRange.to) return format(dateRange.from, "yyyy/MM/dd");
  return `${format(dateRange.from, "yyyy/MM/dd")} - ${format(dateRange.to, "yyyy/MM/dd")}`;
}

function createDateRangeFilter(dateRange: DateRange | undefined): RuntimeTaskTimeRangeFilter | undefined {
  if (!dateRange?.from && !dateRange?.to) return undefined;
  const start = dateRange?.from ? startOfDay(dateRange.from).toISOString() : "";
  const end = dateRange?.to
    ? endOfDay(dateRange.to).toISOString()
    : dateRange?.from
      ? endOfDay(dateRange.from).toISOString()
      : "";
  return {
    start: start || undefined,
    end: end || undefined,
  };
}

function createRuntimeTaskFiltersKey(filters?: RuntimeTaskBoardFilters): string {
  return JSON.stringify({
    channelKinds: [...(filters?.channelKinds ?? [])].sort(),
    organizationId: filters?.organizationId ?? "",
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
