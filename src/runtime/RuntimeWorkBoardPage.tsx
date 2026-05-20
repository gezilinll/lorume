import { useEffect, useMemo, useRef, useState } from "react";
import {
  mapMulticaWorkState,
  mapOpenClawWorkState,
  mapSlockWorkState,
} from "./runtime-work-state-adapters";
import {
  multicaWorkStateFixture,
  openClawWorkStateFixture,
  slockWorkStateFixture,
} from "./runtime-work-state-fixtures";
import {
  createRuntimeWorkBoard,
  listRuntimeWorkChannelOptions,
  type RuntimeWorkBoardItem,
  type RuntimeWorkBoardFilters,
  type RuntimeWorkChannelKind,
  type RuntimeWorkTimeRangeFilter,
} from "./runtime-work-state-query";
import type { RuntimeSource } from "./runtime-normalize";
import type { RuntimeWorkStageId, RuntimeWorkStateSnapshot } from "./runtime-work-state";
import { formatRuntimeTimestamp } from "./runtime-inventory-query";
import { isFixtureFallbackAllowed } from "./runtime-data-source";
import {
  createWorkItemsQueryUrl,
  runtimeWorkItemsQueryPageFromResponse,
} from "./runtime-work-query-api";
import { PixelIcon } from "../ui/PixelIcon";

const autoRefreshIntervalMs = 30_000;

const sourceOptions: Array<RuntimeSource | "all"> = ["all", "openclaw", "multica", "slock"];
const stageOptions: Array<RuntimeWorkStageId | "all"> = ["all", "pending", "processing", "review", "closed", "attention"];
const quickRangeOptions = [
  "lastHour",
  "lastDay",
  "today",
  "yesterday",
  "last7Days",
  "thisWeek",
  "lastWeek",
  "last30Days",
  "thisMonth",
] as const;
type QuickRangeOption = (typeof quickRangeOptions)[number];
type TimeRangePanelMode = "quick" | "custom";

const sourceLabels: Record<RuntimeSource | "all", string> = {
  all: "全部",
  openclaw: "OpenClaw",
  multica: "Multica",
  slock: "Slock",
  codex: "Codex",
  claude_code: "Claude Code",
  unknown: "未知",
  manual: "手动",
};

const stageLabels: Record<RuntimeWorkStageId | "all", string> = {
  all: "全部",
  pending: "待处理",
  processing: "处理中",
  review: "待验收",
  closed: "已关闭",
  attention: "需关注",
};

const quickRangeLabels: Record<QuickRangeOption, string> = {
  lastHour: "1小时",
  lastDay: "1天",
  today: "今天",
  yesterday: "昨天",
  last7Days: "七天内",
  thisWeek: "本星期",
  lastWeek: "上星期",
  last30Days: "30天",
  thisMonth: "本月",
};

const fixtureWorkStateSnapshot = createFixtureWorkStateSnapshot();
const defaultFiltersKey = createRuntimeWorkFiltersKey();

interface RuntimeWorkSnapshotLoadResult {
  snapshot: RuntimeWorkStateSnapshot;
  total: number;
  nextCursor?: string;
}

/** Read-only board for normalized Agent work state across runtimes and platforms. */
export function RuntimeWorkBoardPage() {
  const allowFixtureFallback = isFixtureFallbackAllowed();
  const [snapshot, setSnapshot] = useState<RuntimeWorkStateSnapshot>(
    allowFixtureFallback ? fixtureWorkStateSnapshot : createEmptyWorkStateSnapshot(),
  );
  const [totalMatchingItems, setTotalMatchingItems] = useState(
    allowFixtureFallback ? fixtureWorkStateSnapshot.workItems.length : 0,
  );
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadedFiltersKey, setLoadedFiltersKey] = useState(defaultFiltersKey);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshState, setRefreshState] = useState<{
    status: "idle" | "running" | "success" | "error";
    message: string;
  }>({ status: "idle", message: "" });
  const [lastLoadedAt, setLastLoadedAt] = useState("");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<RuntimeSource | "all">("all");
  const [stage, setStage] = useState<RuntimeWorkStageId | "all">("all");
  const [channelKind, setChannelKind] = useState<RuntimeWorkChannelKind | "all">("all");
  const [timeStart, setTimeStart] = useState("");
  const [timeEnd, setTimeEnd] = useState("");
  const [timeRangeOpen, setTimeRangeOpen] = useState(false);
  const [timeRangeMode, setTimeRangeMode] = useState<TimeRangePanelMode>("quick");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const timeRangeRef = useRef<HTMLDivElement | null>(null);

  async function fetchLatestSnapshot(
    filterOptions?: RuntimeWorkBoardFilters,
    cursor?: string,
  ): Promise<RuntimeWorkSnapshotLoadResult> {
    const queryResponse = await fetch(createWorkItemsQueryUrl(window.location.origin, filterOptions, { cursor }));
    if (!queryResponse.ok) {
      throw new Error(`runtime work item query failed: ${queryResponse.status}`);
    }
    const queryPage = runtimeWorkItemsQueryPageFromResponse(await queryResponse.json());
    if (!queryPage) throw new Error("runtime work item query returned an invalid payload");
    return queryPage;
  }

  function applySnapshot(
    latestSnapshot: RuntimeWorkStateSnapshot,
    options: { append?: boolean; filtersKey?: string; nextCursor?: string; total?: number } = {},
  ) {
    setSnapshot((current) => options.append ? mergeWorkStateSnapshots(current, latestSnapshot) : latestSnapshot);
    setNextCursor(options.nextCursor);
    setLoadedFiltersKey(options.filtersKey ?? defaultFiltersKey);
    setTotalMatchingItems(options.total ?? latestSnapshot.workItems.length);
    setLastLoadedAt(new Date().toISOString());
  }

  const filters: RuntimeWorkBoardFilters = useMemo(
    () => ({
      channelKind,
      search,
      source,
      stage,
      timeRange: createTimeRangeFilter(timeStart, timeEnd),
    }),
    [channelKind, search, source, stage, timeEnd, timeStart],
  );
  const filtersKey = useMemo(() => createRuntimeWorkFiltersKey(filters), [filters]);

  async function loadLatestSnapshot(options: { silent?: boolean } = {}) {
    try {
      const latestSnapshot = await fetchLatestSnapshot(filters);
      applySnapshot(latestSnapshot.snapshot, {
        filtersKey,
        nextCursor: latestSnapshot.nextCursor,
        total: latestSnapshot.total,
      });
      if (!options.silent) setRefreshState({ status: "success", message: "已读取最新工作态" });
    } catch (error) {
      if (!options.silent) {
        setRefreshState({
          status: "error",
          message: error instanceof Error ? error.message : "读取工作态失败",
        });
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;

    async function loadSnapshotForFilters() {
      try {
        const latestSnapshot = await fetchLatestSnapshot(filters);
        if (!cancelled) {
          applySnapshot(latestSnapshot.snapshot, {
            filtersKey,
            nextCursor: latestSnapshot.nextCursor,
            total: latestSnapshot.total,
          });
        }
      } catch {
        if (!allowFixtureFallback && !cancelled) {
          setRefreshState({ status: "error", message: "后端查询失败，无法读取正式工作态" });
        }
      }
    }

    const debounceTimer = window.setTimeout(() => {
      void loadSnapshotForFilters();
      refreshTimer = window.setInterval(() => {
        void loadSnapshotForFilters();
      }, autoRefreshIntervalMs);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    };
  }, [allowFixtureFallback, filters, filtersKey]);

  const channelOptions = useMemo(() => listRuntimeWorkChannelOptions(snapshot), [snapshot]);
  useEffect(() => {
    if (channelKind !== "all" && !channelOptions.some((option) => option.value === channelKind)) {
      setChannelKind("all");
    }
  }, [channelKind, channelOptions]);

  const board = useMemo(() => createRuntimeWorkBoard(snapshot, filters), [filters, snapshot]);
  const selectedItem = selectedId ? board.visibleItems.find((item) => item.id === selectedId) ?? null : board.visibleItems[0] ?? null;
  const timeRangeFullSummary = formatTimeRangeSummary(timeStart, timeEnd);
  const timeRangeSummary = formatCompactTimeRangeSummary(timeStart, timeEnd);
  const timeRangeDuration = formatTimeRangeDuration(timeStart, timeEnd);
  const displayedItems = board.visibleItems.length;
  const paginationMatchesFilters = loadedFiltersKey === filtersKey;
  const displayedTotal = paginationMatchesFilters ? totalMatchingItems : displayedItems;
  const canLoadMore = Boolean(nextCursor && paginationMatchesFilters);

  useEffect(() => {
    if (!timeRangeOpen) return undefined;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (timeRangeRef.current?.contains(target)) return;
      setTimeRangeOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [timeRangeOpen]);

  function applyQuickRange(option: QuickRangeOption) {
    const range = createQuickTimeRange(option, new Date());
    setTimeStart(formatDateTimeLocal(range.start));
    setTimeEnd(formatDateTimeLocal(range.end));
    setTimeRangeOpen(false);
  }

  function clearTimeRange() {
    setTimeStart("");
    setTimeEnd("");
    setTimeRangeMode("quick");
    setTimeRangeOpen(false);
  }

  function toggleTimeRangeOpen() {
    if (timeRangeOpen) {
      setTimeRangeOpen(false);
      return;
    }
    setTimeRangeMode("quick");
    setTimeRangeOpen(true);
  }

  async function loadMoreWorkItems() {
    if (!nextCursor || loadingMore || !paginationMatchesFilters) return;
    setLoadingMore(true);
    try {
      const page = await fetchLatestSnapshot(filters, nextCursor);
      applySnapshot(page.snapshot, {
        append: true,
        filtersKey,
        nextCursor: page.nextCursor,
        total: page.total,
      });
      setRefreshState({ status: "success", message: "已加载更多工作项" });
    } catch (error) {
      setRefreshState({
        status: "error",
        message: error instanceof Error ? error.message : "加载更多失败",
      });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="workspace">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Agent / Work Board</p>
          <h1>工作看板</h1>
          <p className="pageSubtitle">
            统一查看 Agent 承接的工作项、发起人、Channel、会话/群组、消息摘要和当前阶段。
          </p>
          <p className="pageRefreshMeta">
            快照时间 {formatRuntimeTimestamp(snapshot.observedAt)}
            {lastLoadedAt ? ` · 上次刷新 ${formatRuntimeTimestamp(lastLoadedAt)}` : ""}
          </p>
        </div>
        <div className="refreshControl">
          <button
            className="primaryButton"
            type="button"
            disabled={refreshState.status === "running"}
            onClick={() => {
              setRefreshState({ status: "running", message: "正在读取最新工作态" });
              void loadLatestSnapshot();
            }}
          >
            <PixelIcon name="reload" size={16} />
            {refreshState.status === "running" ? "刷新中" : "刷新看板"}
          </button>
          {refreshState.message ? (
            <p className={`refreshMessage refresh-${refreshState.status}`} role="status">
              {refreshState.message}
            </p>
          ) : null}
        </div>
      </header>

      <section className="toolbar workBoardToolbar" aria-label="工作看板筛选">
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
          <span className="controlLabel">来源 Runtime</span>
          <select value={source} onChange={(event) => setSource(event.target.value as RuntimeSource | "all")}>
            {sourceOptions.map((option) => (
              <option key={option} value={option}>
                {sourceLabels[option]}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbarField">
          <span className="controlLabel">渠道</span>
          <select
            value={channelKind}
            onChange={(event) => setChannelKind(event.target.value as RuntimeWorkChannelKind | "all")}
          >
            <option value="all">全部</option>
            {channelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbarField">
          <span className="controlLabel">阶段</span>
          <select value={stage} onChange={(event) => setStage(event.target.value as RuntimeWorkStageId | "all")}>
            {stageOptions.map((option) => (
              <option key={option} value={option}>
                {stageLabels[option]}
              </option>
            ))}
          </select>
        </label>

        <div className="toolbarField timeRangeField" ref={timeRangeRef}>
          <span className="controlLabel">时间范围</span>
          <button
            aria-controls="runs-time-range-panel"
            aria-expanded={timeRangeOpen}
            aria-label={`选择时间范围：${timeRangeFullSummary}`}
            className="timeRangeTrigger"
            title={timeRangeFullSummary}
            type="button"
            onClick={toggleTimeRangeOpen}
          >
            <span className="timeRangeDuration">{timeRangeDuration}</span>
            <span className="timeRangeSummary">{timeRangeSummary}</span>
            {timeRangeOpen ? <PixelIcon name="chevron-up" size={18} /> : <PixelIcon name="chevron-down" size={18} />}
          </button>
          {timeRangeOpen ? (
            <div className="timeRangePopover" id="runs-time-range-panel" role="dialog" aria-label="时间范围选择">
              {timeRangeMode === "quick" ? (
                <>
                  <div className="timeRangePopoverHeader">
                    <strong>时间选择</strong>
                    <button className="timeRangeTextButton" type="button" onClick={() => setTimeRangeMode("custom")}>
                      <PixelIcon name="calendar" size={16} />
                      日历中选择
                    </button>
                  </div>
                  <p className="timeRangeHint">请选择需要的时间</p>
                  <div className="quickRangeGrid" aria-label="快捷时间范围">
                    {quickRangeOptions.map((option) => (
                      <button
                        className="quickRangeButton"
                        key={option}
                        type="button"
                        onClick={() => applyQuickRange(option)}
                      >
                        {quickRangeLabels[option]}
                      </button>
                    ))}
                    <button className="quickRangeButton" type="button" onClick={() => setTimeRangeMode("custom")}>
                      自定义
                    </button>
                  </div>
                  <div className="timeRangeActions">
                    <button className="secondaryButton" type="button" onClick={clearTimeRange}>
                      清除时间
                    </button>
                    <button className="primaryMiniButton" type="button" onClick={() => setTimeRangeOpen(false)}>
                      确认
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button className="timeRangeBackButton" type="button" onClick={() => setTimeRangeMode("quick")}>
                    <PixelIcon name="chevron-left" size={16} />
                    日历中选择
                  </button>
                  <div className="timeRangeManualInputs">
                    <label className="timeInputLabel">
                      <span>开始时间</span>
                      <input
                        aria-label="开始时间"
                        type="datetime-local"
                        step={1}
                        value={timeStart}
                        onChange={(event) => setTimeStart(event.target.value)}
                      />
                    </label>
                    <label className="timeInputLabel">
                      <span>结束时间</span>
                      <input
                        aria-label="结束时间"
                        type="datetime-local"
                        step={1}
                        value={timeEnd}
                        onChange={(event) => setTimeEnd(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="timeRangeActions">
                    <button className="secondaryButton" type="button" onClick={clearTimeRange}>
                      清除时间
                    </button>
                    <button className="primaryMiniButton" type="button" onClick={() => setTimeRangeOpen(false)}>
                      立即查询
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </section>

      <section className="metricGrid" aria-label="工作态概览">
        <Metric label="看板项" value={board.summary.totalItems} tone="blue" />
        <Metric label="待处理" value={board.summary.byStage.pending} tone="purple" />
        <Metric label="处理中" value={board.summary.byStage.processing} tone="green" />
        <Metric label="需关注" value={board.summary.byStage.attention} tone="orange" />
      </section>

      <section className="workBoardGrid">
        <div className="workBoardMain">
          <div className="boardResultMeta">
            <span>已显示 {displayedItems} / {displayedTotal}</span>
            {canLoadMore ? (
              <button className="loadMoreButton" type="button" disabled={loadingMore} onClick={() => void loadMoreWorkItems()}>
                {loadingMore ? "加载中" : "加载更多"}
              </button>
            ) : null}
          </div>
          <div className="workBoardLanes" aria-label="工作态泳道">
            {board.lanes.map((lane) => (
              <section className="workLane" key={lane.stage} aria-label={`${lane.label}泳道`}>
                <div className="workLaneHeader">
                  <h2>{lane.label}</h2>
                  <span>{lane.items.length}</span>
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
                          <Badge>{item.runtimeLabel}</Badge>
                          {item.channelKindLabel ? <Badge>{item.channelKindLabel}</Badge> : null}
                        </span>
                        <strong>{item.title}</strong>
                        <small>{item.requestExcerpt}</small>
                        <>
                          <span className="workCardMeta">
                            发起人 {item.creatorLabel}
                          </span>
                          <span className="workCardMeta">
                            承接 Agent {item.assigneeLabel}
                          </span>
                          <span className="workCardMeta">
                            会话/群组 {item.channelLabel ?? "不支持采集"}
                            {item.lastSeenAt ? ` · ${formatRuntimeTimestamp(item.lastSeenAt)}` : ""}
                          </span>
                        </>
                      </button>
                    ))
                  ) : (
                    <p className="emptyLane">无匹配项</p>
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
        <WorkItemDetail item={selectedItem} />
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

function WorkItemDetail({
  item,
}: {
  item: RuntimeWorkBoardItem | null;
}) {
  if (!item) {
    return (
      <aside className="detailPanel workBoardDetailPanel" aria-label="工作项详情">
        <h2>工作项详情</h2>
        <p>选择一个工作项查看详情。</p>
      </aside>
    );
  }

  return (
    <aside className="detailPanel workBoardDetailPanel" aria-label="工作项详情">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">工作项</p>
          <h2 className="detailTitle" title={item.title}>{item.title}</h2>
        </div>
        <StatusPill>{stageLabels[item.stage]}</StatusPill>
      </div>
      <DetailBlock title="概览">
        {`${stageLabels[item.stage]} · ${workItemStatusLabel(item.workItemStatus)}`}
      </DetailBlock>
      <DetailList
        title="任务上下文"
        items={[
          `来源 Runtime: ${item.runtimeLabel}`,
          `Channel: ${item.channelKindLabel ?? "默认渠道"}`,
          `发起人: ${item.creatorLabel}`,
          `承接 Agent: ${item.assigneeLabel}`,
          `会话/群组: ${item.channelLabel ?? "不支持采集"}`,
        ]}
      />
      <DetailList
        title="最近状态"
        items={[
          `最近同步: ${formatRuntimeTimestamp(item.lastSeenAt)}`,
          `工作项状态: ${workItemStatusLabel(item.workItemStatus)}`,
          ...(item.executionStatus ? [`执行状态: ${executionStatusLabel(item.executionStatus)}`] : []),
        ]}
      />
      <DetailBlock title="消息摘要">{item.requestExcerpt}</DetailBlock>
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

function createTimeRangeFilter(start: string, end: string): RuntimeWorkTimeRangeFilter | undefined {
  const normalizedStart = start.trim();
  const normalizedEnd = end.trim();
  if (!normalizedStart && !normalizedEnd) return undefined;
  return {
    start: normalizedStart || undefined,
    end: normalizedEnd || undefined,
  };
}

function createRuntimeWorkFiltersKey(filters?: RuntimeWorkBoardFilters): string {
  return JSON.stringify({
    channelKind: filters?.channelKind ?? "all",
    search: filters?.search?.trim() ?? "",
    source: filters?.source ?? "all",
    stage: filters?.stage ?? "all",
    timeEnd: filters?.timeRange?.end ?? "",
    timeStart: filters?.timeRange?.start ?? "",
  });
}

function createQuickTimeRange(option: QuickRangeOption, now: Date): { start: Date; end: Date } {
  if (option === "lastHour") {
    return { start: new Date(now.getTime() - 60 * 60 * 1000), end: now };
  }
  if (option === "lastDay") {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
  }
  if (option === "today") {
    return { start: startOfDay(now), end: now };
  }
  if (option === "yesterday") {
    const yesterday = addDays(now, -1);
    return { start: startOfDay(yesterday), end: endOfDay(yesterday) };
  }
  if (option === "last7Days") {
    return { start: startOfDay(addDays(now, -6)), end: now };
  }
  if (option === "thisWeek") {
    return { start: startOfWeek(now), end: now };
  }
  if (option === "last30Days") {
    return { start: startOfDay(addDays(now, -29)), end: now };
  }
  if (option === "thisMonth") {
    return { start: startOfMonth(now), end: now };
  }
  const thisWeekStart = startOfWeek(now);
  const lastWeekStart = addDays(thisWeekStart, -7);
  return { start: lastWeekStart, end: endOfDay(addDays(thisWeekStart, -1)) };
}

function formatTimeRangeSummary(start: string, end: string): string {
  const displayStart = formatDateTimeDisplay(start);
  const displayEnd = formatDateTimeDisplay(end);
  if (displayStart && displayEnd) return `${displayStart} ~ ${displayEnd}`;
  if (displayStart) return `${displayStart} 之后`;
  if (displayEnd) return `${displayEnd} 之前`;
  return "全部时间";
}

function formatCompactTimeRangeSummary(start: string, end: string): string {
  const displayStart = formatCompactDateTimeDisplay(start);
  const displayEnd = formatCompactDateTimeDisplay(end);
  if (displayStart && displayEnd) return `${displayStart} - ${displayEnd}`;
  if (displayStart) return `${displayStart} 之后`;
  if (displayEnd) return `${displayEnd} 之前`;
  return "全部时间";
}

function formatTimeRangeDuration(start: string, end: string): string {
  const startDate = parseDateTimeLocal(start);
  const endDate = parseDateTimeLocal(end);
  if (!startDate && !endDate) return "全部";
  if (!startDate || !endDate) return "自定义";
  const diffMs = endDate.getTime() - startDate.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "自定义";
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatDateTimeDisplay(value: string): string | undefined {
  const date = parseDateTimeLocal(value);
  if (!date) return undefined;
  return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}:${padTimePart(date.getSeconds())}`;
}

function formatCompactDateTimeDisplay(value: string): string | undefined {
  const date = parseDateTimeLocal(value);
  if (!date) return undefined;
  return `${padTimePart(date.getMonth() + 1)}/${padTimePart(date.getDate())} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function parseDateTimeLocal(value: string): Date | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function formatDateTimeLocal(date: Date): string {
  return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}T${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}:${padTimePart(date.getSeconds())}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfWeek(date: Date): Date {
  const mondayOffset = (date.getDay() + 6) % 7;
  return startOfDay(addDays(date, -mondayOffset));
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

function createFixtureWorkStateSnapshot(): RuntimeWorkStateSnapshot {
  const openclaw = mapOpenClawWorkState(openClawWorkStateFixture);
  const multica = mapMulticaWorkState(multicaWorkStateFixture);
  const slock = mapSlockWorkState(slockWorkStateFixture);
  return {
    observedAt: "2026-05-09T08:00:00.000Z",
    deviceId: "fixture-device",
    workItems: [...openclaw.workItems, ...multica.workItems, ...slock.workItems],
    conversations: [...openclaw.conversations, ...multica.conversations, ...slock.conversations],
    executions: [...openclaw.executions, ...multica.executions, ...slock.executions],
    capabilities: [...openclaw.capabilities, ...multica.capabilities, ...slock.capabilities],
    warnings: [...(openclaw.warnings ?? []), ...(multica.warnings ?? []), ...(slock.warnings ?? [])],
  };
}

function createEmptyWorkStateSnapshot(): RuntimeWorkStateSnapshot {
  return {
    observedAt: new Date(0).toISOString(),
    deviceId: "backend",
    workItems: [],
    conversations: [],
    executions: [],
    capabilities: [],
  };
}

function mergeWorkStateSnapshots(
  current: RuntimeWorkStateSnapshot,
  next: RuntimeWorkStateSnapshot,
): RuntimeWorkStateSnapshot {
  return {
    observedAt: next.observedAt > current.observedAt ? next.observedAt : current.observedAt,
    deviceId: next.deviceId || current.deviceId,
    workItems: mergeById(current.workItems, next.workItems),
    conversations: mergeById(current.conversations, next.conversations),
    executions: mergeById(current.executions, next.executions),
    capabilities: mergeBySource(current.capabilities, next.capabilities),
    warnings: [...(current.warnings ?? []), ...(next.warnings ?? [])],
  };
}

function mergeById<T extends { id: string }>(current: T[], next: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return Array.from(byId.values());
}

function mergeBySource<T extends { source: string }>(current: T[], next: T[]): T[] {
  const bySource = new Map(current.map((item) => [item.source, item]));
  for (const item of next) bySource.set(item.source, item);
  return Array.from(bySource.values());
}

function workItemStatusLabel(status: RuntimeWorkBoardItem["workItemStatus"]): string {
  if (status === "todo") return "待处理";
  if (status === "in_progress") return "处理中";
  if (status === "in_review") return "待验收";
  if (status === "done") return "已完成";
  if (status === "blocked") return "阻塞";
  if (status === "cancelled") return "已取消";
  return "未知";
}

function executionStatusLabel(status: RuntimeWorkBoardItem["executionStatus"]): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "succeeded") return "已成功";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "unknown") return "未知";
  return "未知";
}
