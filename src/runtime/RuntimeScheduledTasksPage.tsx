import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Clock3,
  Filter,
  Search,
  Server,
  X,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InitialAvatar } from "@/components/data/InitialAvatar";
import { Pill, type PillTone } from "@/components/data/Pill";
import { StatusBadge } from "@/components/data/StatusBadge";
import {
  filterMenuCheckboxItemClass,
  filterMenuContentClass,
  filterMenuItemClass,
  filterMenuLabelClass,
  filterMenuSeparatorClass,
  filterMenuSubTriggerClass,
} from "@/components/data/filter-menu-styles";
import { useConsoleWorkbar, useHasConsoleWorkbar } from "@/components/layout/ConsoleWorkbar";
import { consoleDetailInspectorClass } from "@/components/layout/inspector-styles";
import { cn } from "@/lib/utils";
import { formatRelativeActivityTime, formatRuntimeTimestamp } from "./runtime-fleet-query";
import {
  countActiveScheduledTaskFilters,
  fetchRuntimeScheduledTaskExecutions,
  fetchRuntimeScheduledTasks,
  filterRuntimeScheduledTaskGroups,
  scheduledTaskNeedsAttention,
  type RuntimeScheduledTaskExecutionsResult,
  type RuntimeScheduledTaskFilters,
  type RuntimeScheduledTaskGroup,
  type RuntimeScheduledTasksResult,
} from "./runtime-scheduled-task-query";
import { TASK_STATUSES, type Task, type TaskStatus } from "./runtime-model";

const emptyScheduledTasks: RuntimeScheduledTasksResult = {
  items: [],
  summary: {
    disabledCount: 0,
    enabledCount: 0,
    total: 0,
  },
  total: 0,
};

const emptyExecutions: RuntimeScheduledTaskExecutionsResult = {
  items: [],
  summary: {
    byStatus: Object.assign(
      Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])),
      { total: 0 },
    ) as RuntimeScheduledTaskExecutionsResult["summary"]["byStatus"],
    total: 0,
  },
  total: 0,
};

const taskStatusLabels: Record<TaskStatus, string> = {
  blocked: "阻塞",
  cancelled: "已取消",
  done: "成功",
  failed: "失败",
  in_progress: "运行中",
  review: "待验收",
  todo: "待处理",
  unknown: "未知",
};

const taskStatusTones: Record<TaskStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  blocked: "warning",
  cancelled: "neutral",
  done: "success",
  failed: "danger",
  in_progress: "info",
  review: "warning",
  todo: "neutral",
  unknown: "warning",
};

export function RuntimeScheduledTasksPage({ organizationId }: { organizationId?: string }) {
  const [result, setResult] = useState<RuntimeScheduledTasksResult>(emptyScheduledTasks);
  const [filters, setFilters] = useState<RuntimeScheduledTaskFilters>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const hasConsoleWorkbar = useHasConsoleWorkbar();

  async function loadScheduledTasks() {
    setIsLoading(true);
    setLoadError("");
    try {
      const next = await fetchRuntimeScheduledTasks({ organizationId });
      setResult(next);
    } catch {
      setResult(emptyScheduledTasks);
      setLoadError("后端查询失败，无法读取定时任务。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setLoadError("");
      try {
        const next = await fetchRuntimeScheduledTasks({ organizationId });
        if (!cancelled) setResult(next);
      } catch {
        if (!cancelled) {
          setResult(emptyScheduledTasks);
          setLoadError("后端查询失败，无法读取定时任务。");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const visibleItems = useMemo(
    () => filterRuntimeScheduledTaskGroups(result.items, filters),
    [filters, result.items],
  );
  const selectedItem = visibleItems.find((item) => item.scheduleKey === selectedKey) ?? visibleItems[0] ?? null;
  const activeFilterCount = countActiveScheduledTaskFilters(filters);
  const needAttentionCount = result.items.filter(scheduledTaskNeedsAttention).length;

  useConsoleWorkbar({
    meta: (
      <>
        <span>{result.summary.total} 定时任务</span>
        <span>{result.summary.enabledCount} 启用</span>
        <span>{needAttentionCount} 需关注</span>
      </>
    ),
    refresh: {
      disabled: isLoading,
      isLoading,
      label: "刷新",
      onClick: () => {
        void loadScheduledTasks();
      },
    },
    title: "定时任务",
  }, [
    isLoading,
    needAttentionCount,
    result.summary.enabledCount,
    result.summary.total,
  ]);

  return (
    <section className="min-w-0">
      {hasConsoleWorkbar ? null : <h1 className="mb-4 text-lg font-bold">定时任务</h1>}
      {loadError ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="mb-4" size="sm" aria-label="定时任务筛选">
        <CardContent className="py-3">
          <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                className="h-9 rounded-[10px] border-input bg-[var(--surface-soft)] pl-9 text-[13px]"
                placeholder="搜索定时任务、Runtime、Agent 或 cron"
                value={filters.search ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              />
            </div>
            <ScheduledTaskFilterMenu
              activeFilterCount={activeFilterCount}
              filters={filters}
              items={result.items}
              onChange={setFilters}
            />
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <ScheduledTasksSkeleton />
      ) : (
        <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.36fr)]">
          <ScheduledTasksTable
            items={visibleItems}
            selectedKey={selectedItem?.scheduleKey}
            onSelect={(item) => setSelectedKey(item.scheduleKey)}
          />
          <ScheduledTaskDetail item={selectedItem} organizationId={organizationId} />
        </section>
      )}
    </section>
  );
}

function ScheduledTaskFilterMenu({
  activeFilterCount,
  filters,
  items,
  onChange,
}: {
  activeFilterCount: number;
  filters: RuntimeScheduledTaskFilters;
  items: RuntimeScheduledTaskGroup[];
  onChange: (filters: RuntimeScheduledTaskFilters) => void;
}) {
  const runtimes = useMemo(() => uniqueOptions(items.map((item) => [item.runtimeId, item.runtimeName])), [items]);
  const agents = useMemo(() => {
    const options: Array<[string, string, string]> = [];
    for (const item of items) {
      item.agentIds.forEach((agentId, index) => {
        options.push([agentId, item.agentNames[index] || agentId.split(":").at(-1) || agentId, item.runtimeName]);
      });
    }
    return uniqueAgentOptions(options);
  }, [items]);
  const updateFilter = (patch: RuntimeScheduledTaskFilters) => onChange({ ...filters, ...patch });
  const clearFilter = (key: keyof RuntimeScheduledTaskFilters) => {
    const next = { ...filters };
    delete next[key];
    onChange(next);
  };
  const resetAll = () => onChange({ search: filters.search });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={activeFilterCount > 0 ? `${activeFilterCount} 个筛选` : "筛选"}
          className={cn(
            "h-9 rounded-[10px]",
            activeFilterCount > 0 && "border-[var(--active-filter)] bg-[var(--active-filter)] text-[var(--active-filter-foreground)] hover:bg-[var(--active-filter)] hover:text-[var(--active-filter-foreground)]",
          )}
          type="button"
          variant={activeFilterCount > 0 ? "default" : "outline"}
        >
          <Filter className="size-4" aria-hidden="true" />
          {activeFilterCount > 0 ? `${activeFilterCount} 个筛选` : "筛选"}
          {activeFilterCount > 0 ? <X className="size-3.5" aria-hidden="true" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="定时任务筛选"
        align="end"
        className={cn("w-[236px] rounded-[14px]", filterMenuContentClass)}
        sideOffset={8}
      >
        <DropdownMenuLabel className={filterMenuLabelClass}>筛选</DropdownMenuLabel>
        <DropdownMenuSeparator className={filterMenuSeparatorClass} />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={filterMenuSubTriggerClass}>
            <Server className="size-4" aria-hidden="true" />
            Runtime
            {filters.runtimeId ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Runtime" className={cn("w-[260px] rounded-[14px]", filterMenuContentClass)}>
            <DropdownMenuCheckboxItem checked={!filters.runtimeId} className={filterMenuCheckboxItemClass(!filters.runtimeId)} onCheckedChange={() => clearFilter("runtimeId")}>
              全部 Runtime
            </DropdownMenuCheckboxItem>
            {runtimes.map(([runtimeId, runtimeName]) => (
              <DropdownMenuCheckboxItem
                checked={filters.runtimeId === runtimeId}
                className={filterMenuCheckboxItemClass(filters.runtimeId === runtimeId)}
                key={runtimeId}
                onCheckedChange={() => updateFilter({ runtimeId })}
              >
                {runtimeName}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={filterMenuSubTriggerClass}>
            <Bot className="size-4" aria-hidden="true" />
            Agent
            {filters.agentId ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Agent" className={cn("w-[260px] rounded-[14px]", filterMenuContentClass)}>
            <DropdownMenuCheckboxItem checked={!filters.agentId} className={filterMenuCheckboxItemClass(!filters.agentId)} onCheckedChange={() => clearFilter("agentId")}>
              全部 Agent
            </DropdownMenuCheckboxItem>
            {agents.map(([agentId, agentName, runtimeName]) => (
              <DropdownMenuCheckboxItem
                checked={filters.agentId === agentId}
                className={filterMenuCheckboxItemClass(filters.agentId === agentId)}
                key={agentId}
                onCheckedChange={() => updateFilter({ agentId })}
              >
                <span className="grid min-w-0">
                  <span className="truncate">{agentName}</span>
                  <span className="truncate text-xs text-muted-foreground">{runtimeName}</span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={filterMenuSubTriggerClass}>
            <CheckCircle2 className="size-4" aria-hidden="true" />
            启用状态
            {filters.enabled ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="启用状态" className={cn("w-[180px] rounded-[14px]", filterMenuContentClass)}>
            <DropdownMenuCheckboxItem checked={!filters.enabled} className={filterMenuCheckboxItemClass(!filters.enabled)} onCheckedChange={() => clearFilter("enabled")}>
              全部状态
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={filters.enabled === "enabled"} className={filterMenuCheckboxItemClass(filters.enabled === "enabled")} onCheckedChange={() => updateFilter({ enabled: "enabled" })}>
              启用
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={filters.enabled === "disabled"} className={filterMenuCheckboxItemClass(filters.enabled === "disabled")} onCheckedChange={() => updateFilter({ enabled: "disabled" })}>
              停用
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={filterMenuSubTriggerClass}>
            <CircleDot className="size-4" aria-hidden="true" />
            最近状态
            {filters.status ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="最近状态" className={cn("w-[180px] rounded-[14px]", filterMenuContentClass)}>
            <DropdownMenuCheckboxItem checked={!filters.status} className={filterMenuCheckboxItemClass(!filters.status)} onCheckedChange={() => clearFilter("status")}>
              全部状态
            </DropdownMenuCheckboxItem>
            {(["done", "failed", "in_progress", "unknown"] as const).map((status) => (
              <DropdownMenuCheckboxItem
                checked={filters.status === status}
                className={filterMenuCheckboxItemClass(filters.status === status)}
                key={status}
                onCheckedChange={() => updateFilter({ status })}
              >
                {taskStatusLabels[status]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {activeFilterCount > 0 ? (
          <>
            <DropdownMenuSeparator className={filterMenuSeparatorClass} />
            <DropdownMenuItem className={filterMenuItemClass} onSelect={resetAll}>
              重置全部筛选
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScheduledTasksTable({
  items,
  selectedKey,
  onSelect,
}: {
  items: RuntimeScheduledTaskGroup[];
  selectedKey?: string;
  onSelect: (item: RuntimeScheduledTaskGroup) => void;
}) {
  return (
    <Card size="sm" aria-label="定时任务列表">
      <CardHeader className="grid-cols-[1fr_auto] items-start border-b border-border pb-3">
        <div>
          <CardTitle>全部定时任务</CardTitle>
          <p className="mt-1 text-[11.5px] text-muted-foreground">按 Runtime、Agent、启用状态和最近执行状态筛选。</p>
        </div>
        <CalendarClock className="size-5 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
            当前筛选条件下没有定时任务
          </div>
        ) : (
          <Table aria-label="定时任务列表" className="table-fixed">
            <TableHeader className="bg-[var(--surface-soft)]">
              <TableRow>
                <TableHead className="w-[27%]">定时任务</TableHead>
                <TableHead className="w-[14%]">Runtime</TableHead>
                <TableHead className="w-[10%]">Agent</TableHead>
                <TableHead className="w-[14%]">计划</TableHead>
                <TableHead className="w-[13%]">下次运行</TableHead>
                <TableHead className="w-[8%]">最近状态</TableHead>
                <TableHead className="w-[8%]">最近时间</TableHead>
                <TableHead className="w-[6%]">执行次数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  aria-selected={item.scheduleKey === selectedKey}
                  className="cursor-pointer border-border/70 aria-selected:bg-muted/80"
                  key={item.scheduleKey}
                  tabIndex={0}
                  onClick={() => onSelect(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(item);
                    }
                  }}
                >
                  <TableCell className="min-w-0 whitespace-normal">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className={cn("h-8 w-1 rounded-full", scheduledTaskStripeClass(item))} aria-hidden="true" />
                      <InitialAvatar text={item.name} tone={scheduledTaskTone(item)} variant="solid" />
                      <span className="min-w-0">
                        <strong className="block truncate text-[13px] font-semibold">{item.name}</strong>
                        <span className="mt-1 flex flex-wrap gap-1">
                          <StatusBadge tone={item.enabled ? "success" : "neutral"}>{item.enabled ? "启用" : "停用"}</StatusBadge>
                          {scheduledTaskNeedsAttention(item) ? <StatusBadge tone="warning">需关注</StatusBadge> : null}
                        </span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="block truncate text-[13px] font-medium">{item.runtimeName}</span>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="block truncate text-[13px] text-muted-foreground">{agentSummary(item)}</span>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="block truncate font-mono text-[12px] text-foreground">{item.expression || "计划未知"}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">{item.timezone || "时区未知"}</span>
                  </TableCell>
                  <TableCell className="whitespace-normal text-[12px] text-muted-foreground">
                    {item.nextRunAt ? formatRuntimeTimestamp(item.nextRunAt) : "暂无下次运行"}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {item.latestStatus ? <StatusBadge tone={taskStatusTones[item.latestStatus]}>{taskStatusLabels[item.latestStatus]}</StatusBadge> : <Pill tone="muted">暂无执行</Pill>}
                  </TableCell>
                  <TableCell
                    className="whitespace-normal text-[12px] text-muted-foreground"
                    title={item.latestExecutionAt ? formatRuntimeTimestamp(item.latestExecutionAt) : undefined}
                  >
                    {formatRelativeActivityTime(item.latestExecutionAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{item.executionCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ScheduledTaskDetail({
  item,
  organizationId,
}: {
  item: RuntimeScheduledTaskGroup | null;
  organizationId?: string;
}) {
  const [executions, setExecutions] = useState<RuntimeScheduledTaskExecutionsResult>(emptyExecutions);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!item) {
      setExecutions(emptyExecutions);
      return;
    }
    const scheduleKey = item.scheduleKey;

    async function loadExecutions() {
      setIsLoading(true);
      setLoadError("");
      try {
        const next = await fetchRuntimeScheduledTaskExecutions({
          limit: 50,
          organizationId,
          scheduleKey,
        });
        if (!cancelled) setExecutions(next);
      } catch {
        if (!cancelled) {
          setExecutions(emptyExecutions);
          setLoadError("执行历史读取失败。");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadExecutions();
    return () => {
      cancelled = true;
    };
  }, [item?.scheduleKey, organizationId]);

  if (!item) {
    return (
      <aside aria-label="定时任务详情" className={consoleDetailInspectorClass}>
        <Card size="sm">
          <CardHeader>
            <h2 className="font-heading text-sm font-medium leading-snug">定时任务详情</h2>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">选择一个定时任务查看计划和执行历史。</p>
          </CardContent>
        </Card>
      </aside>
    );
  }

  return (
    <aside aria-label="定时任务详情" className={consoleDetailInspectorClass}>
      <Card size="sm">
        <CardHeader className="border-b border-border pb-3">
          <div className="rounded-[14px] border border-border bg-[linear-gradient(135deg,var(--orange-soft),var(--yellow-soft)_48%,var(--surface-soft))] p-3">
            <div className="flex min-w-0 items-start gap-3">
              <InitialAvatar className="mt-0.5" size="lg" text={item.name} tone={scheduledTaskTone(item)} variant="solid" />
              <div className="min-w-0 flex-1">
                <h2 className="line-clamp-2 text-base font-bold">{item.name}</h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">{item.runtimeName} · {agentSummary(item)}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <StatusBadge tone={item.enabled ? "success" : "neutral"}>{item.enabled ? "启用" : "停用"}</StatusBadge>
              {item.latestStatus ? <StatusBadge tone={taskStatusTones[item.latestStatus]}>{taskStatusLabels[item.latestStatus]}</StatusBadge> : <Pill tone="muted">暂无执行</Pill>}
              {scheduledTaskNeedsAttention(item) ? <StatusBadge tone="warning">需关注</StatusBadge> : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailGrid
            items={[
              ["Runtime", item.runtimeName],
              ["Agent", agentSummary(item)],
              ["cron", item.expression || "计划未知"],
              ["时区", item.timezone || "时区未知"],
              ["下次运行", item.nextRunAt ? formatRuntimeTimestamp(item.nextRunAt) : "暂无下次运行"],
              ["最近执行", item.latestExecutionAt ? formatRuntimeTimestamp(item.latestExecutionAt) : "暂无执行"],
            ]}
          />
          <ExecutionStatusSummary item={item} />
          <section className="space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">执行历史</h3>
              <span className="text-[11.5px] text-muted-foreground">最近 {executions.items.length} 次</span>
            </div>
            {loadError ? (
              <div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">{loadError}</div>
            ) : isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, index) => <Skeleton className="h-14 rounded-[12px]" key={index} />)}
              </div>
            ) : executions.items.length === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">暂无执行历史</div>
            ) : (
              <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
                {executions.items.map((task) => <ExecutionHistoryItem key={task.id} task={task} />)}
              </div>
            )}
          </section>
        </CardContent>
      </Card>
    </aside>
  );
}

function ExecutionStatusSummary({ item }: { item: RuntimeScheduledTaskGroup }) {
  const statuses: TaskStatus[] = ["done", "failed", "in_progress", "unknown", "cancelled"];
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">执行结果</h3>
      <div className="flex flex-wrap gap-1.5">
        {statuses.map((status) => (
          <Pill key={status} tone={statusToneToPillTone(status)}>
            {taskStatusLabels[status]} {item.summary.byStatus[status] ?? 0}
          </Pill>
        ))}
      </div>
    </section>
  );
}

function ExecutionHistoryItem({ task }: { task: Task }) {
  const time = task.updatedAt || task.createdAt;
  const summary = task.status === "failed" && task.error
    ? task.error
    : task.agentReply || task.userMessage || "暂无执行摘要";
  return (
    <article className="rounded-[12px] border border-border bg-[var(--surface-soft)] px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <StatusBadge tone={taskStatusTones[task.status]}>{taskStatusLabels[task.status]}</StatusBadge>
        <span className="shrink-0 text-[11.5px] text-muted-foreground">{time ? formatRuntimeTimestamp(time) : "时间未知"}</span>
      </div>
      <p className="mt-2 line-clamp-3 text-[12px] leading-5 text-muted-foreground">{summary}</p>
    </article>
  );
}

function DetailGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div className="min-w-0 rounded-[10px] border border-border bg-[var(--surface-soft)] px-3 py-2" key={label}>
          <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
          <div className="mt-1 truncate text-[13px] font-semibold text-foreground" title={value}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function ScheduledTasksSkeleton() {
  return (
    <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.36fr)]">
      <Card size="sm">
        <CardContent className="space-y-2 py-3">
          {Array.from({ length: 8 }).map((_, index) => <Skeleton className="h-14 rounded-[12px]" key={index} />)}
        </CardContent>
      </Card>
      <Card size="sm" className={consoleDetailInspectorClass}>
        <CardContent className="space-y-3 py-3">
          <Skeleton className="h-28 rounded-[14px]" />
          <Skeleton className="h-20 rounded-[12px]" />
          <Skeleton className="h-40 rounded-[12px]" />
        </CardContent>
      </Card>
    </section>
  );
}

function agentSummary(item: RuntimeScheduledTaskGroup): string {
  if (item.agentNames.length === 0) return "未绑定 Agent";
  if (item.agentNames.length <= 2) return item.agentNames.join("、");
  return `${item.agentNames.slice(0, 2).join("、")} 等 ${item.agentNames.length} 个 Agent`;
}

function scheduledTaskTone(item: RuntimeScheduledTaskGroup): "brand" | "blue" | "cyan" | "orange" | "green" | "pink" | "purple" | "yellow" {
  if (scheduledTaskNeedsAttention(item)) return "orange";
  if (!item.enabled) return "purple";
  return "green";
}

function scheduledTaskStripeClass(item: RuntimeScheduledTaskGroup): string {
  if (scheduledTaskNeedsAttention(item)) return "bg-[var(--orange)]";
  if (!item.enabled) return "bg-[var(--purple)]";
  return "bg-[var(--green)]";
}

function statusToneToPillTone(status: TaskStatus): PillTone {
  if (status === "done") return "green";
  if (status === "failed") return "orange";
  if (status === "in_progress") return "blue";
  if (status === "unknown") return "yellow";
  return "muted";
}

function uniqueOptions(options: Array<[string, string]>): Array<[string, string]> {
  const seen = new Map<string, string>();
  for (const [id, label] of options) {
    if (id && !seen.has(id)) seen.set(id, label || id);
  }
  return Array.from(seen.entries()).sort((left, right) => left[1].localeCompare(right[1]));
}

function uniqueAgentOptions(options: Array<[string, string, string]>): Array<[string, string, string]> {
  const seen = new Map<string, [string, string, string]>();
  for (const option of options) {
    if (option[0] && !seen.has(option[0])) seen.set(option[0], option);
  }
  return Array.from(seen.values()).sort((left, right) => left[1].localeCompare(right[1]));
}
