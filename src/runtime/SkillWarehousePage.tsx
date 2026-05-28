import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  CircleDot,
  Filter,
  Layers3,
  Search,
  Server,
  Sparkles,
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
import { InitialAvatar, type AccentTone, accentToneFromText } from "@/components/data/InitialAvatar";
import { Pill } from "@/components/data/Pill";
import { StatusBadge } from "@/components/data/StatusBadge";
import { useConsoleWorkbar, useHasConsoleWorkbar } from "@/components/layout/ConsoleWorkbar";
import { cn } from "@/lib/utils";
import { formatRuntimeTimestamp } from "./runtime-fleet-query";
import {
  fetchRuntimeSkillInventory,
  filterRuntimeSkillInventoryRows,
  runtimeSkillScopeLabels,
  type RuntimeSkillInventory,
  type RuntimeSkillInventoryFilters,
  type RuntimeSkillInventoryRow,
} from "./runtime-skill-inventory";

const emptyInventory: RuntimeSkillInventory = {
  agents: [],
  rows: [],
  runtimes: [],
  summary: {
    agentScopeCount: 0,
    availableCount: 0,
    builtInCount: 0,
    runtimeScopeCount: 0,
    total: 0,
    unavailableCount: 0,
  },
};

export function SkillWarehousePage({
  initialFilters,
  organizationId,
}: {
  initialFilters?: RuntimeSkillInventoryFilters;
  organizationId?: string;
}) {
  const [inventory, setInventory] = useState<RuntimeSkillInventory>(emptyInventory);
  const [filters, setFilters] = useState<RuntimeSkillInventoryFilters>(initialFilters ?? {});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedRowId, setSelectedRowId] = useState("");
  const hasConsoleWorkbar = useHasConsoleWorkbar();

  useEffect(() => {
    setFilters(initialFilters ?? {});
    setSelectedRowId("");
  }, [initialFilters?.agentId, initialFilters?.available, initialFilters?.builtIn, initialFilters?.runtimeId, initialFilters?.scope]);

  useEffect(() => {
    let cancelled = false;

    async function loadInventory() {
      setIsLoading(true);
      setLoadError("");
      try {
        const result = await fetchRuntimeSkillInventory({ organizationId });
        if (!cancelled) {
          setInventory(result.inventory);
          setLoadError(result.errors.length ? "部分 Runtime Skill 信息读取失败，列表已展示可读取的数据。" : "");
        }
      } catch {
        if (!cancelled) {
          setInventory(emptyInventory);
          setLoadError("后端查询失败，无法读取 Skill 仓库。");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadInventory();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const visibleRows = useMemo(
    () => filterRuntimeSkillInventoryRows(inventory.rows, filters),
    [filters, inventory.rows],
  );
  const selectedRow = visibleRows.find((row) => row.id === selectedRowId) ?? visibleRows[0] ?? null;
  const sameNameRows = selectedRow ? inventory.rows.filter((row) => row.name === selectedRow.name && row.id !== selectedRow.id) : [];
  const activeFilterCount = countActiveFilters(filters);

  useConsoleWorkbar({
    meta: (
      <>
        <span>{inventory.summary.total} Skills</span>
        <span>{inventory.summary.availableCount} 可用</span>
        <span>{inventory.summary.builtInCount} 系统自带</span>
      </>
    ),
    title: "Skill 仓库",
  }, [
    inventory.summary.availableCount,
    inventory.summary.builtInCount,
    inventory.summary.total,
  ]);

  return (
    <section className="min-w-0">
      {hasConsoleWorkbar ? null : <h1 className="mb-4 text-lg font-bold">Skill 仓库</h1>}
      {loadError ? (
        <Alert className="mb-4" variant={loadError.includes("部分") ? "default" : "destructive"}>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="mb-4" size="sm" aria-label="Skill 仓库筛选">
        <CardContent className="py-3">
          <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                className="h-9 rounded-[10px] border-input bg-[var(--surface-soft)] pl-9 text-[13px]"
                placeholder="搜索 Skill、描述、Runtime 或 Agent"
                value={filters.search ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              />
            </div>
            <SkillFilterMenu
              activeFilterCount={activeFilterCount}
              filters={filters}
              inventory={inventory}
              onChange={setFilters}
            />
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <SkillWarehouseSkeleton />
      ) : (
        <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.34fr)]">
          <SkillInventoryTable
            rows={visibleRows}
            selectedRowId={selectedRow?.id}
            onSelect={setSelectedRowId}
          />
          <SkillDetailCard row={selectedRow} sameNameRows={sameNameRows} />
        </section>
      )}
    </section>
  );
}

function SkillFilterMenu({
  activeFilterCount,
  filters,
  inventory,
  onChange,
}: {
  activeFilterCount: number;
  filters: RuntimeSkillInventoryFilters;
  inventory: RuntimeSkillInventory;
  onChange: (filters: RuntimeSkillInventoryFilters) => void;
}) {
  const updateFilter = (patch: RuntimeSkillInventoryFilters) => {
    onChange({ ...filters, ...patch });
  };
  const clearFilter = (key: keyof RuntimeSkillInventoryFilters) => {
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
        aria-label="Skill 筛选"
        align="end"
        className="w-[236px] rounded-[14px] border-border bg-card p-2 text-card-foreground shadow-[var(--menu-shadow)]"
        sideOffset={8}
      >
        <DropdownMenuLabel className="px-2 pb-2 pt-1 text-sm font-bold text-foreground">筛选</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-[10px] px-2 text-[13px]">
            <Server className="size-4" aria-hidden="true" />
            Runtime
            {filters.runtimeId ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Runtime" className="w-[260px] rounded-[14px] p-2 shadow-[var(--menu-shadow)]">
            <DropdownMenuCheckboxItem checked={!filters.runtimeId} onCheckedChange={() => clearFilter("runtimeId")}>
              全部 Runtime
            </DropdownMenuCheckboxItem>
            {inventory.runtimes.map((runtime) => (
              <DropdownMenuCheckboxItem
                checked={filters.runtimeId === runtime.id}
                key={runtime.id}
                onCheckedChange={() => updateFilter({ runtimeId: runtime.id })}
              >
                <span className="grid min-w-0">
                  <span className="truncate">{runtime.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{runtime.kindLabel}</span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-[10px] px-2 text-[13px]">
            <Bot className="size-4" aria-hidden="true" />
            Agent
            {filters.agentId ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Agent" className="w-[260px] rounded-[14px] p-2 shadow-[var(--menu-shadow)]">
            <DropdownMenuCheckboxItem checked={!filters.agentId} onCheckedChange={() => clearFilter("agentId")}>
              全部 Agent
            </DropdownMenuCheckboxItem>
            {inventory.agents.map((agent) => (
              <DropdownMenuCheckboxItem
                checked={filters.agentId === agent.id}
                key={agent.id}
                onCheckedChange={() => updateFilter({ agentId: agent.id, runtimeId: agent.runtimeId })}
              >
                <span className="grid min-w-0">
                  <span className="truncate">{agent.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{agent.runtimeId}</span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-[10px] px-2 text-[13px]">
            <Layers3 className="size-4" aria-hidden="true" />
            Scope
            {filters.scope ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Scope" className="w-[180px] rounded-[14px] p-2 shadow-[var(--menu-shadow)]">
            <DropdownMenuCheckboxItem checked={!filters.scope} onCheckedChange={() => clearFilter("scope")}>
              全部 Scope
            </DropdownMenuCheckboxItem>
            {(["runtime", "agent"] as const).map((scope) => (
              <DropdownMenuCheckboxItem
                checked={filters.scope === scope}
                key={scope}
                onCheckedChange={() => updateFilter({ scope })}
              >
                {runtimeSkillScopeLabels[scope]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-[10px] px-2 text-[13px]">
            <Sparkles className="size-4" aria-hidden="true" />
            来源
            {typeof filters.builtIn === "boolean" ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="来源" className="w-[180px] rounded-[14px] p-2 shadow-[var(--menu-shadow)]">
            <DropdownMenuCheckboxItem checked={typeof filters.builtIn !== "boolean"} onCheckedChange={() => clearFilter("builtIn")}>
              全部来源
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={filters.builtIn === true} onCheckedChange={() => updateFilter({ builtIn: true })}>
              系统自带
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={filters.builtIn === false} onCheckedChange={() => updateFilter({ builtIn: false })}>
              自定义
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-[10px] px-2 text-[13px]">
            <CircleDot className="size-4" aria-hidden="true" />
            状态
            {typeof filters.available === "boolean" ? <span className="ml-auto text-xs font-semibold text-muted-foreground">1</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="状态" className="w-[180px] rounded-[14px] p-2 shadow-[var(--menu-shadow)]">
            <DropdownMenuCheckboxItem checked={typeof filters.available !== "boolean"} onCheckedChange={() => clearFilter("available")}>
              全部状态
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={filters.available === true} onCheckedChange={() => updateFilter({ available: true })}>
              可用
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={filters.available === false} onCheckedChange={() => updateFilter({ available: false })}>
              不可用
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {activeFilterCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="h-9 rounded-[10px] px-2 text-[13px] font-medium" onSelect={resetAll}>
              重置全部筛选
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkillInventoryTable({
  rows,
  selectedRowId,
  onSelect,
}: {
  rows: RuntimeSkillInventoryRow[];
  selectedRowId?: string;
  onSelect: (rowId: string) => void;
}) {
  return (
    <Card size="sm" aria-label="Skill 目录">
      <CardHeader className="grid-cols-[1fr_auto] items-start border-b border-border pb-3">
        <div>
          <CardTitle>全部 Skill</CardTitle>
          <p className="mt-1 text-[11.5px] text-muted-foreground">按 Runtime、Agent、Scope、来源和状态筛选。</p>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
            当前筛选条件下没有 Skill
          </div>
        ) : (
          <Table aria-label="Skill 列表" className="table-fixed">
            <TableHeader className="bg-[var(--surface-soft)]">
              <TableRow>
                <TableHead className="w-[32%]">Skill</TableHead>
                <TableHead className="w-[16%]">归属 Runtime</TableHead>
                <TableHead className="w-[12%]">Scope</TableHead>
                <TableHead className="w-[11%]">来源</TableHead>
                <TableHead className="w-[9%]">状态</TableHead>
                <TableHead className="w-[10%]">Agent</TableHead>
                <TableHead className="w-[10%] text-right">最近采集</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  aria-selected={row.id === selectedRowId}
                  className="cursor-pointer border-border/70 aria-selected:bg-muted/80"
                  key={row.id}
                  tabIndex={0}
                  onClick={() => onSelect(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(row.id);
                    }
                  }}
                >
                  <TableCell className="min-w-0 whitespace-normal">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className={cn("h-8 w-1 rounded-full", skillStripeClass(row))} aria-hidden="true" />
                      <InitialAvatar text={row.name} variant="solid" />
                      <span className="min-w-0">
                        <strong className="block truncate text-[13px] font-semibold">{row.name}</strong>
                        <span className="line-clamp-2 text-[11.5px] text-muted-foreground">{row.description || "暂无描述"}</span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="block text-[13px] font-medium">{row.runtimeKindLabel}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">{row.runtimeName}</span>
                  </TableCell>
                  <TableCell>
                    <Pill tone={row.scope === "runtime" ? "brand" : "cyan"}>{runtimeSkillScopeLabels[row.scope]}</Pill>
                  </TableCell>
                  <TableCell>
                    <Pill tone={row.builtIn ? "purple" : "pink"}>{row.builtIn ? "系统自带" : "自定义"}</Pill>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={row.available ? "success" : "warning"}>{row.available ? "可用" : "不可用"}</StatusBadge>
                  </TableCell>
                  <TableCell>
                    <AgentStack row={row} />
                  </TableCell>
                  <TableCell className="whitespace-normal text-right text-[11.5px] leading-4 text-muted-foreground">
                    {formatRuntimeTimestamp(row.observedAt ?? undefined)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SkillDetailCard({
  row,
  sameNameRows,
}: {
  row: RuntimeSkillInventoryRow | null;
  sameNameRows: RuntimeSkillInventoryRow[];
}) {
  if (!row) {
    return (
      <aside aria-label="Skill 详情" className="self-start xl:sticky xl:top-4">
        <Card size="sm">
          <CardHeader>
            <h2 className="font-heading text-sm font-medium leading-snug">Skill 详情</h2>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">选择一个 Skill 查看基础信息和可用 Agent。</p>
          </CardContent>
        </Card>
      </aside>
    );
  }

  return (
    <aside aria-label="Skill 详情" className="self-start xl:sticky xl:top-4">
      <Card size="sm">
        <CardHeader className="border-b border-border pb-3">
          <div className="rounded-[14px] border border-border bg-[linear-gradient(135deg,var(--blue-soft),var(--brand-soft)_48%,var(--surface-soft))] p-3">
            <div className="flex min-w-0 items-center gap-3">
              <InitialAvatar size="lg" text={row.name} tone={skillTone(row.name)} variant="solid" />
              <div className="min-w-0">
                <h2 className="truncate text-base font-bold">{row.name}</h2>
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{row.description || "暂无描述"}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill tone={row.scope === "runtime" ? "brand" : "cyan"}>{runtimeSkillScopeLabels[row.scope]} Skill</Pill>
              <Pill tone={row.builtIn ? "purple" : "pink"}>{row.builtIn ? "系统自带" : "自定义"}</Pill>
              <StatusBadge tone={row.available ? "success" : "warning"}>{row.available ? "可用" : "不可用"}</StatusBadge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailGrid
            items={[
              ["Runtime", `${row.runtimeKindLabel} · ${row.runtimeName}`],
              ["Scope", runtimeSkillScopeLabels[row.scope]],
              ["来源", row.builtIn ? "系统自带" : "自定义"],
              ["状态", row.available ? "可用" : "不可用"],
              ["归属 Agent", row.ownerAgents.length ? row.ownerAgents.map((agent) => agent.name).join("、") : "Runtime 公共能力"],
              ["最近采集", formatRuntimeTimestamp(row.observedAt ?? undefined)],
            ]}
          />
          <AgentAvailabilityList row={row} />
          <SameNameSkillList rows={sameNameRows} />
        </CardContent>
      </Card>
    </aside>
  );
}

function DetailGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <section>
      <h3 className="text-sm font-medium">基础信息</h3>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div className="rounded-[10px] border border-border bg-[var(--surface-soft)] px-3 py-2" key={label}>
            <span className="block text-[11px] font-semibold text-muted-foreground">{label}</span>
            <span className="mt-1 block break-words text-[13px] font-semibold">{value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentAvailabilityList({ row }: { row: RuntimeSkillInventoryRow }) {
  const agents = row.availableAgents;
  return (
    <section className="border-t border-border pt-3">
      <h3 className="text-sm font-medium">可用 Agent</h3>
      {agents.length ? (
        <div className="mt-2 grid gap-2">
          {agents.map((agent) => (
            <div className="flex items-center gap-2 rounded-[10px] border border-border bg-[var(--surface-soft)] px-3 py-2" key={agent.id}>
              <InitialAvatar text={agent.name} variant="solid" />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-[13px]">{agent.name}</strong>
                <span className="block truncate text-[11.5px] text-muted-foreground">{agent.runtimeId}</span>
              </span>
              <Check className="size-4 text-[var(--green)]" aria-hidden="true" />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 rounded-[10px] border border-dashed px-3 py-4 text-sm text-muted-foreground">当前没有可用 Agent</p>
      )}
    </section>
  );
}

function SameNameSkillList({ rows }: { rows: RuntimeSkillInventoryRow[] }) {
  return (
    <section className="border-t border-border pt-3">
      <h3 className="text-sm font-medium">同名 Skill</h3>
      {rows.length ? (
        <div className="mt-2 space-y-2">
          {rows.map((row) => (
            <div className="rounded-[10px] border border-border bg-[var(--surface-soft)] px-3 py-2" key={row.id}>
              <strong className="block truncate text-[13px]">{row.runtimeKindLabel}</strong>
              <span className="block truncate text-[11.5px] text-muted-foreground">{row.runtimeName}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">当前 Runtime 视图中没有同名 Skill。</p>
      )}
    </section>
  );
}

function AgentStack({ row }: { row: RuntimeSkillInventoryRow }) {
  const agents = row.scope === "runtime" ? row.availableAgents : row.ownerAgents;
  const label = row.scope === "runtime" ? `${row.availableAgentIds.length} Agents` : `${row.ownerAgentIds.length} Agents`;
  if (agents.length === 0) {
    return <Pill tone="muted">{label}</Pill>;
  }
  return (
    <div className="flex items-center gap-2">
      <span className="flex -space-x-1.5">
        {agents.slice(0, 3).map((agent) => (
          <InitialAvatar className="ring-2 ring-card" key={agent.id} size="sm" text={agent.name} variant="solid" />
        ))}
      </span>
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

function SkillWarehouseSkeleton() {
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.34fr)]" aria-label="Skill 仓库读取中">
      <Skeleton className="h-[420px] w-full" />
      <Skeleton className="h-[420px] w-full" />
    </section>
  );
}

function countActiveFilters(filters: RuntimeSkillInventoryFilters): number {
  return [
    filters.runtimeId,
    filters.agentId,
    filters.scope,
    typeof filters.available === "boolean" ? String(filters.available) : "",
    typeof filters.builtIn === "boolean" ? String(filters.builtIn) : "",
  ].filter(Boolean).length;
}

function skillTone(name: string): AccentTone {
  return accentToneFromText(name);
}

function skillStripeClass(row: RuntimeSkillInventoryRow): string {
  if (!row.available) return "bg-[var(--orange)]";
  return row.scope === "runtime" ? "bg-[var(--brand)]" : "bg-[var(--cyan)]";
}
