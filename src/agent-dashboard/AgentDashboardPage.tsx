import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CalendarDays,
  FileText,
  ListChecks,
  Play,
  RefreshCw,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Pill, type PillTone } from "@/components/data/Pill";
import { StatusBadge } from "@/components/data/StatusBadge";
import { useConsoleWorkbar, useHasConsoleWorkbar } from "@/components/layout/ConsoleWorkbar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  createAgentAnalysisReportsUrl,
  createAgentAnalysisRun,
  normalizeAgentAnalysisReportsResponse,
  readOperationDetail,
  type AgentDashboardAnalysis,
  type AgentDashboardHardMetrics,
  type AgentDashboardOperationDetail,
  type AgentDashboardOperationStatus,
  type AgentDashboardReport,
} from "./agent-dashboard-query";
import {
  runtimeFleetSnapshotFromQueryResponse,
  type RuntimeFleetSnapshot,
} from "@/runtime/runtime-fleet-query";
import type { Agent, Device, Runtime } from "@/runtime/runtime-model";

interface AgentDashboardPageProps {
  initialAgentId?: string;
  organizationId?: string;
}

interface AgentAnalysisTarget {
  agent: Agent;
  device: Device;
  runtime: Runtime;
  supported: boolean;
}

const operationStatusLabels: Record<AgentDashboardOperationStatus, string> = {
  cancelled: "已取消",
  failed: "失败",
  queued: "排队中",
  requires_manual_step: "需人工处理",
  running: "执行中",
  succeeded: "已完成",
  unsupported: "不支持",
};

/** Agent daily operations dashboard for backend-generated OpenClaw analysis reports. */
export function AgentDashboardPage({ initialAgentId, organizationId }: AgentDashboardPageProps) {
  const hasConsoleWorkbar = useHasConsoleWorkbar();
  const [snapshot, setSnapshot] = useState<RuntimeFleetSnapshot | null>(null);
  const [reports, setReports] = useState<AgentDashboardReport[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentId ?? "");
  const [selectedReportId, setSelectedReportId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [operationDetail, setOperationDetail] = useState<AgentDashboardOperationDetail | null>(null);
  const [activeOperationId, setActiveOperationId] = useState("");
  const [isCreatingRun, setIsCreatingRun] = useState(false);

  async function loadDashboard() {
    if (!organizationId?.trim()) {
      setSnapshot(null);
      setReports([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setLoadError("");
    try {
      const scopedAgentId = initialAgentId || selectedAgentId;
      const [fleetResponse, reportsResponse] = await Promise.all([
        fetch(createAgentDashboardUrl("/api/runtime-fleet", organizationId)),
        fetch(createAgentAnalysisReportsUrl(window.location.origin, {
          agentId: scopedAgentId || undefined,
          limit: 30,
          organizationId,
        })),
      ]);
      if (!fleetResponse.ok) throw new Error(`运行资产读取失败: HTTP ${fleetResponse.status}`);
      if (!reportsResponse.ok) throw new Error(`分析报告读取失败: HTTP ${reportsResponse.status}`);
      const nextSnapshot = runtimeFleetSnapshotFromQueryResponse(await fleetResponse.json());
      if (!nextSnapshot) throw new Error("运行资产返回无效");
      const nextReports = normalizeAgentAnalysisReportsResponse(await reportsResponse.json());
      const supportedTargets = listAgentAnalysisTargets(nextSnapshot).filter((target) => target.supported);
      const nextSelectedAgentId = scopedAgentId
        || nextReports[0]?.agentId
        || supportedTargets[0]?.agent.id
        || "";
      setSnapshot(nextSnapshot);
      setReports(nextReports);
      setSelectedAgentId(nextSelectedAgentId);
      setSelectedReportId((current) =>
        current && nextReports.some((report) => report.id === current)
          ? current
          : nextReports.find((report) => report.agentId === nextSelectedAgentId)?.id ?? nextReports[0]?.id ?? ""
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Agent 看板读取失败");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      await loadDashboard();
      if (cancelled) return;
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId, initialAgentId]);

  useEffect(() => {
    if (!activeOperationId) return;
    let cancelled = false;
    async function loadOperation() {
      const detail = await readOperationDetail(window.location.origin, activeOperationId).catch(() => null);
      if (!cancelled && detail) setOperationDetail(detail);
    }
    void loadOperation();
    const timer = window.setInterval(() => void loadOperation(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeOperationId]);

  const targets = useMemo(() => snapshot ? listAgentAnalysisTargets(snapshot) : [], [snapshot]);
  const selectedTarget = targets.find((target) => target.agent.id === selectedAgentId) ?? null;
  const selectedReport = reports.find((report) => report.id === selectedReportId)
    ?? reports.find((report) => report.agentId === selectedAgentId)
    ?? reports[0]
    ?? null;
  const isSupportedTarget = selectedTarget?.supported
    ?? Boolean(selectedReport && selectedReport.runtimeKind === "openclaw" && openclawAgentIdFromAgentId(selectedReport.agentId) === "main");
  const currentDeviceId = selectedTarget?.device.id ?? selectedReport?.deviceId ?? "";
  const currentRuntimeName = selectedTarget?.runtime.name ?? selectedReport?.runtimeKind ?? "OpenClaw";
  const currentAgentName = selectedTarget?.agent.name ?? openclawAgentIdFromAgentId(selectedReport?.agentId ?? selectedAgentId) ?? "main";
  const operationStatus = operationDetail?.operation.status;

  useConsoleWorkbar({
    meta: (
      <>
        {currentDeviceId ? <span>{currentDeviceId}</span> : null}
        {currentRuntimeName ? <span>{currentRuntimeName}</span> : null}
        {currentAgentName ? <span>{currentAgentName}</span> : null}
        {selectedReport ? <span>{formatPeriodLabel(selectedReport.periodStart, selectedReport.periodEnd)}</span> : null}
      </>
    ),
    refresh: {
      disabled: isLoading,
      isLoading,
      label: "刷新",
      onClick: () => void loadDashboard(),
    },
    title: "Agent 看板",
  }, [
    currentAgentName,
    currentDeviceId,
    currentRuntimeName,
    isLoading,
    selectedReport?.id,
  ]);

  async function handleCreateAnalysisRun() {
    if (!organizationId?.trim() || !selectedAgentId || !isSupportedTarget) return;
    setIsCreatingRun(true);
    try {
      const run = await createAgentAnalysisRun(window.location.origin, {
        agentId: selectedAgentId,
        organizationId,
        ...(selectedReport?.periodStart && selectedReport?.periodEnd
          ? { periodEnd: selectedReport.periodEnd, periodStart: selectedReport.periodStart }
          : {}),
      });
      setOperationDetail({ jobs: [run.job], operation: run.operation });
      setActiveOperationId(run.operation.id);
      toast.success("Agent 分析任务已创建，可在任务抽屉查看进度");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Agent 分析任务创建失败");
    } finally {
      setIsCreatingRun(false);
    }
  }

  if (!organizationId) {
    return <p className="text-sm text-muted-foreground">请选择组织后查看 Agent 看板。</p>;
  }

  return (
    <section className="min-w-0">
      {hasConsoleWorkbar ? null : <h1 className="mb-4 text-lg font-bold">Agent 看板</h1>}
      {loadError ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}
      {isLoading && !snapshot ? (
        <AgentDashboardSkeleton />
      ) : (
        <div className="space-y-4">
          <AgentTargetBar
            currentAgentName={currentAgentName}
            currentDeviceId={currentDeviceId}
            currentRuntimeName={currentRuntimeName}
            isCreatingRun={isCreatingRun}
            isSupportedTarget={isSupportedTarget}
            operationStatus={operationStatus}
            report={selectedReport}
            selectedAgentId={selectedAgentId}
            targets={targets}
            onCreateRun={() => void handleCreateAnalysisRun()}
            onSelectAgent={(agentId) => {
              setSelectedAgentId(agentId);
              setSelectedReportId(reports.find((report) => report.agentId === agentId)?.id ?? "");
            }}
          />
          {!isSupportedTarget ? (
            <UnsupportedState />
          ) : !selectedReport ? (
            <EmptyReportState />
          ) : (
            <>
              <HardMetricStrip hardMetrics={selectedReport.hardMetrics} />
              <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.36fr)]">
                <div className="min-w-0 space-y-4">
                  <HardMetricsCard hardMetrics={selectedReport.hardMetrics} />
                  <AgentAnalysisCard analysis={selectedReport.analysis} />
                  <TaskTypeTable analysis={selectedReport.analysis} hardMetrics={selectedReport.hardMetrics} />
                </div>
                <aside className="min-w-0 space-y-4 xl:sticky xl:top-20" aria-label="报告和任务状态">
                  <OperationCard detail={operationDetail} report={selectedReport} />
                  <ReportHistory
                    reports={reports}
                    selectedReportId={selectedReport.id}
                    onSelect={setSelectedReportId}
                  />
                  <BoundaryCard modelMetadata={selectedReport.modelMetadata} />
                </aside>
              </section>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function AgentTargetBar({
  currentAgentName,
  currentDeviceId,
  currentRuntimeName,
  isCreatingRun,
  isSupportedTarget,
  operationStatus,
  report,
  selectedAgentId,
  targets,
  onCreateRun,
  onSelectAgent,
}: {
  currentAgentName: string;
  currentDeviceId: string;
  currentRuntimeName: string;
  isCreatingRun: boolean;
  isSupportedTarget: boolean;
  operationStatus?: AgentDashboardOperationStatus;
  report: AgentDashboardReport | null;
  selectedAgentId: string;
  targets: AgentAnalysisTarget[];
  onCreateRun: () => void;
  onSelectAgent: (agentId: string) => void;
}) {
  return (
    <Card size="sm">
      <CardContent className="py-3">
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[var(--blue-soft)] font-mono text-sm font-bold text-[var(--blue-foreground)]">
              {currentAgentName.slice(0, 1).toUpperCase() || "A"}
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <strong className="truncate text-sm font-bold text-foreground">{currentRuntimeName} {currentAgentName}</strong>
                <StatusBadge tone={isSupportedTarget ? "success" : "warning"}>
                  {isSupportedTarget ? "支持分析" : "不支持分析"}
                </StatusBadge>
                {operationStatus ? (
                  <StatusBadge tone={operationStatus === "failed" ? "danger" : operationStatus === "succeeded" ? "success" : "warning"}>
                    {operationStatusLabels[operationStatus]}
                  </StatusBadge>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>Device: {currentDeviceId || "未选择"}</span>
                <span>Runtime: {currentRuntimeName || "未选择"}</span>
                <span>Agent: {currentAgentName || "未选择"}</span>
                {report ? <span>最近报告: {formatDateTime(report.createdAt)}</span> : null}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <select
              aria-label="选择 Agent"
              className="h-9 min-w-[220px] rounded-[10px] border border-input bg-[var(--surface-soft)] px-3 text-[13px] font-medium"
              value={selectedAgentId}
              onChange={(event) => onSelectAgent(event.target.value)}
            >
              {targets.length ? targets.map((target) => (
                <option key={target.agent.id} value={target.agent.id}>
                  {target.device.id} / {target.runtime.name} / {target.agent.name}
                </option>
              )) : (
                <option value={selectedAgentId}>{selectedAgentId || "无 Agent"}</option>
              )}
            </select>
            <Button
              disabled={!isSupportedTarget || isCreatingRun}
              size="sm"
              type="button"
              onClick={onCreateRun}
            >
              {isCreatingRun ? <RefreshCw className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
              运行分析
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HardMetricStrip({ hardMetrics }: { hardMetrics: AgentDashboardHardMetrics }) {
  return (
    <section className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="硬指标概览">
      <MetricTile label="任务总数" meta="period 内 Task 总数" value={String(hardMetrics.totalTasks)} />
      <MetricTile
        label="失败 / Unknown"
        meta="unknown 不参与平均耗时"
        tone="warning"
        value={`${hardMetrics.failedCount} / ${hardMetrics.unknownCount}`}
      />
      <MetricTile
        label="Avg / P90 耗时"
        meta="仅 done、failed 进入统计"
        value={`${formatDuration(hardMetrics.duration.avgMs)} / ${formatDuration(hardMetrics.duration.p90Ms)}`}
      />
      <MetricTile
        label="最近活跃"
        meta="updated_source_at 最大值"
        tone="success"
        value={hardMetrics.lastActiveAt ? formatTimeOnly(hardMetrics.lastActiveAt) : "未上报"}
      />
    </section>
  );
}

function MetricTile({
  label,
  meta,
  tone = "info",
  value,
}: {
  label: string;
  meta: string;
  tone?: "info" | "success" | "warning";
  value: string;
}) {
  return (
    <Card size="sm">
      <CardContent>
        <div className="flex items-center justify-between gap-2 text-xs font-semibold text-muted-foreground">
          <span>{label}</span>
          <Pill tone={tone === "warning" ? "orange" : tone === "success" ? "green" : "blue"}>系统计算</Pill>
        </div>
        <div className="mt-3 text-2xl font-black tracking-normal text-foreground">{value}</div>
        <p className="mt-2 text-xs text-muted-foreground">{meta}</p>
      </CardContent>
    </Card>
  );
}

function HardMetricsCard({ hardMetrics }: { hardMetrics: AgentDashboardHardMetrics }) {
  const total = Math.max(1, hardMetrics.totalTasks);
  const doneCount = hardMetrics.statusCounts.done ?? 0;
  const failedCount = hardMetrics.statusCounts.failed ?? 0;
  const unknownCount = hardMetrics.statusCounts.unknown ?? 0;
  const cancelledCount = hardMetrics.statusCounts.cancelled ?? 0;
  return (
    <Card aria-label="硬指标" size="sm">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2"><BarChart3 className="size-4" aria-hidden="true" />硬指标</span>
          <span className="text-xs font-normal text-muted-foreground">系统从已入库 OpenClaw Task 计算</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 lg:grid-cols-2">
          <section>
            <h3 className="mb-3 text-xs font-bold text-foreground">状态分布</h3>
            <div className="flex h-3 overflow-hidden rounded-full bg-muted">
              <span className="bg-[var(--status-success-foreground)]" style={{ width: `${doneCount / total * 100}%` }} />
              <span className="bg-[var(--status-danger-foreground)]" style={{ width: `${failedCount / total * 100}%` }} />
              <span className="bg-[var(--orange-foreground)]" style={{ width: `${unknownCount / total * 100}%` }} />
              <span className="bg-muted-foreground/50" style={{ width: `${cancelledCount / total * 100}%` }} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <LegendDot tone="green" label={`done ${doneCount}`} />
              <LegendDot tone="red" label={`failed ${failedCount}`} />
              <LegendDot tone="orange" label={`unknown ${unknownCount}`} />
              <LegendDot tone="muted" label={`cancelled ${cancelledCount}`} />
            </div>
          </section>
          <section>
            <h3 className="mb-3 text-xs font-bold text-foreground">执行耗时</h3>
            <div className="space-y-3">
              <DurationRow label="Avg" max={hardMetrics.duration.p90Ms} value={hardMetrics.duration.avgMs} />
              <DurationRow label="P50" max={hardMetrics.duration.p90Ms} value={hardMetrics.duration.p50Ms} />
              <DurationRow label="P90" max={hardMetrics.duration.p90Ms} value={hardMetrics.duration.p90Ms} />
            </div>
          </section>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentAnalysisCard({ analysis }: { analysis: AgentDashboardAnalysis }) {
  return (
    <Card aria-label="Agent 自评分析" size="sm">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" aria-hidden="true" />
          Agent 自评
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="border-l-2 border-primary pl-3 text-sm leading-7 text-foreground">{analysis.summary}</p>
        <div className="grid gap-4 lg:grid-cols-2">
          <section>
            <h3 className="mb-2 text-xs font-bold text-foreground">任务类型归纳</h3>
            <div className="space-y-2">
              {analysis.taskTypeBreakdown.length ? analysis.taskTypeBreakdown.map((item) => (
                <div className="rounded-[10px] border bg-background p-3" key={`${item.type}-${item.label}`}>
                  <div className="flex items-center justify-between gap-2">
                    <strong className="min-w-0 truncate text-sm">{item.label}</strong>
                    <Pill tone={confidenceTone(item.confidence)}>{item.countEstimate} {item.confidence}</Pill>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">证据: {item.evidenceTaskIds.join(", ") || "无"}</p>
                </div>
              )) : <p className="text-sm text-muted-foreground">Agent 未返回任务类型归纳。</p>}
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-bold text-foreground">数据质量说明</h3>
            <div className="space-y-2">
              {analysis.dataQualityNotes.length ? analysis.dataQualityNotes.map((note) => (
                <p className="rounded-[10px] border border-dashed bg-muted/30 p-3 text-sm leading-6 text-muted-foreground" key={note}>{note}</p>
              )) : <p className="text-sm text-muted-foreground">Agent 未返回数据质量说明。</p>}
            </div>
          </section>
        </div>
        <section>
          <h3 className="mb-2 text-xs font-bold text-foreground">典型案例</h3>
          <div className="overflow-x-auto">
            <Table aria-label="典型案例">
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>为什么典型</TableHead>
                  <TableHead>结果</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analysis.typicalCases.length ? analysis.typicalCases.map((item) => (
                  <TableRow key={item.taskId}>
                    <TableCell className="font-mono text-xs">{item.taskId}</TableCell>
                    <TableCell className="font-medium">{item.title}</TableCell>
                    <TableCell><Pill tone={caseStatusTone(item.status)}>{item.status}</Pill></TableCell>
                    <TableCell className="min-w-[220px] text-muted-foreground">{item.whyTypical}</TableCell>
                    <TableCell className="min-w-[200px] text-muted-foreground">{item.outcome}</TableCell>
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={5} className="text-muted-foreground">Agent 未返回典型案例。</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-xs font-bold text-foreground">风险</h3>
          <div className="space-y-2">
            {analysis.risks.length ? analysis.risks.map((risk) => (
              <div className="rounded-[10px] border p-3" key={risk.title}>
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm">{risk.title}</strong>
                  <Pill tone={confidenceTone(risk.severity)}>{risk.severity}</Pill>
                </div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{risk.description}</p>
              </div>
            )) : <p className="text-sm text-muted-foreground">Agent 未返回风险。</p>}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function TaskTypeTable({
  analysis,
  hardMetrics,
}: {
  analysis: AgentDashboardAnalysis;
  hardMetrics: AgentDashboardHardMetrics;
}) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2"><ListChecks className="size-4" aria-hidden="true" />任务类型分布</span>
          <span className="text-xs font-normal text-muted-foreground">hardMetrics.taskTypeCounts + Agent 自评归纳并列阅读</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table aria-label="任务类型分布">
            <TableHeader>
              <TableRow>
                <TableHead>系统 taskType</TableHead>
                <TableHead>数量</TableHead>
                <TableHead>Agent 归纳标签</TableHead>
                <TableHead>置信度</TableHead>
                <TableHead>证据任务</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(hardMetrics.taskTypeCounts).map(([taskType, count]) => {
                const analysisItem = analysis.taskTypeBreakdown.find((item) => item.type === taskType) ?? analysis.taskTypeBreakdown[0];
                return (
                  <TableRow key={taskType}>
                    <TableCell className="font-mono text-xs">{taskType}</TableCell>
                    <TableCell>{count}</TableCell>
                    <TableCell>{analysisItem?.label ?? "未归纳"}</TableCell>
                    <TableCell>{analysisItem ? <Pill tone={confidenceTone(analysisItem.confidence)}>{analysisItem.confidence}</Pill> : "无"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{analysisItem?.evidenceTaskIds.join(", ") || "无"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function OperationCard({
  detail,
  report,
}: {
  detail: AgentDashboardOperationDetail | null;
  report: AgentDashboardReport;
}) {
  const job = detail?.jobs[0] ?? null;
  const stage = typeof job?.payload.stage === "string" ? job.payload.stage : undefined;
  return (
    <Card aria-label="分析任务" size="sm">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2"><Activity className="size-4" aria-hidden="true" />分析任务</span>
          <StatusBadge tone={detail?.operation.status === "failed" ? "danger" : detail?.operation.status === "running" ? "warning" : "success"}>
            {operationStatusLabels[detail?.operation.status ?? "succeeded"]}
          </StatusBadge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <TimelineItem active={Boolean(detail)} label="accepted" text="collector 接收请求，请求校验通过" />
        <TimelineItem active={stage === "executing" || detail?.operation.status === "running"} label="executing" text={typeof job?.payload.message === "string" ? job.payload.message : "运行 openclaw agent --json，无 --deliver"} />
        <TimelineItem active={!detail || detail.operation.status === "succeeded"} label="result_received" text="JSON 校验通过，report 已入库" />
        <p className="border-t pt-3 text-xs text-muted-foreground">当前报告 Operation: <span className="font-mono">{detail?.operation.id ?? report.operationId}</span></p>
      </CardContent>
    </Card>
  );
}

function ReportHistory({
  onSelect,
  reports,
  selectedReportId,
}: {
  onSelect: (reportId: string) => void;
  reports: AgentDashboardReport[];
  selectedReportId: string;
}) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2"><FileText className="size-4" aria-hidden="true" />报告历史</span>
          <span className="text-xs font-normal text-muted-foreground">最近 {reports.length} 份</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {reports.length ? reports.map((report) => (
          <Button
            className={cn("h-auto w-full justify-start px-3 py-2 text-left whitespace-normal", selectedReportId === report.id && "border-primary/50 bg-[var(--blue-soft)]")}
            key={report.id}
            type="button"
            variant="outline"
            onClick={() => onSelect(report.id)}
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{formatPeriodLabel(report.periodStart, report.periodEnd)}</span>
              <span className="block text-xs text-muted-foreground">{report.hardMetrics.totalTasks} tasks / avg {formatDuration(report.hardMetrics.duration.avgMs)} / {report.operationId}</span>
            </span>
          </Button>
        )) : <p className="text-sm text-muted-foreground">暂无报告历史。</p>}
      </CardContent>
    </Card>
  );
}

function BoundaryCard({ modelMetadata }: { modelMetadata: AgentDashboardReport["modelMetadata"] }) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2"><AlertTriangle className="size-4" aria-hidden="true" />边界说明</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <BoundaryNote>硬指标只来自 Lorume 后端已经入库的 Task，不接受 Agent 自报。</BoundaryNote>
        <BoundaryNote>Agent 自评用于类型归纳、典型案例、风险和数据质量，不展示满意度估计。</BoundaryNote>
        <BoundaryNote>一期只支持 Runtime.kind=openclaw 且 OpenClaw agent=main。</BoundaryNote>
        {modelMetadata.model || modelMetadata.provider ? (
          <p className="pt-2 text-xs text-muted-foreground">Model: {[modelMetadata.provider, modelMetadata.model].filter(Boolean).join(" / ")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UnsupportedState() {
  return (
    <Alert>
      <AlertTriangle className="size-4" aria-hidden="true" />
      <AlertDescription>
        <strong>不支持分析</strong>：一期只支持 OpenClaw Runtime 的 main Agent。该目标不会下发分析请求。
      </AlertDescription>
    </Alert>
  );
}

function EmptyReportState() {
  return (
    <Card size="sm">
      <CardContent className="py-10 text-center">
        <CalendarDays className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="mt-3 text-base font-semibold">暂无分析报告</h2>
        <p className="mt-2 text-sm text-muted-foreground">可以手动运行一次分析，或等待后端定时任务生成上一自然日报告。</p>
      </CardContent>
    </Card>
  );
}

function AgentDashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-20 w-full rounded-[13px]" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-28 rounded-[13px]" />
        <Skeleton className="h-28 rounded-[13px]" />
        <Skeleton className="h-28 rounded-[13px]" />
        <Skeleton className="h-28 rounded-[13px]" />
      </div>
      <Skeleton className="h-80 w-full rounded-[13px]" />
    </div>
  );
}

function LegendDot({ label, tone }: { label: string; tone: "green" | "red" | "orange" | "muted" }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "green" && "bg-[var(--status-success-foreground)]",
          tone === "red" && "bg-[var(--status-danger-foreground)]",
          tone === "orange" && "bg-[var(--orange-foreground)]",
          tone === "muted" && "bg-muted-foreground/50",
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function DurationRow({ label, max, value }: { label: string; max?: number; value?: number }) {
  const width = value && max ? Math.max(6, Math.min(100, value / max * 100)) : 0;
  return (
    <div className="grid grid-cols-[42px_minmax(0,1fr)_76px] items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
      </span>
      <strong className="text-right font-mono">{formatDuration(value)}</strong>
    </div>
  );
}

function TimelineItem({ active, label, text }: { active: boolean; label: string; text: string }) {
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
      <span className={cn("mt-1 size-3 rounded-full border-2", active ? "border-[var(--status-success-border)] bg-[var(--status-success-foreground)]" : "border-border bg-muted")} />
      <span>
        <strong className="block text-sm">{label}</strong>
        <span className="block text-xs leading-5 text-muted-foreground">{text}</span>
      </span>
    </div>
  );
}

function BoundaryNote({ children }: { children: string }) {
  return <p className="rounded-[10px] border border-dashed bg-muted/20 p-3 text-sm leading-6 text-muted-foreground">{children}</p>;
}

function listAgentAnalysisTargets(snapshot: RuntimeFleetSnapshot): AgentAnalysisTarget[] {
  return snapshot.agents.map((agent) => {
    const runtime = snapshot.runtimes.find((item) => item.id === agent.runtimeId);
    const device = runtime ? snapshot.devices.find((item) => item.id === runtime.deviceId) : undefined;
    if (!runtime || !device) return null;
    return {
      agent,
      device,
      runtime,
      supported: runtime.kind === "openclaw" && openclawAgentIdFromAgentId(agent.id, agent.name) === "main",
    };
  }).filter((target): target is AgentAnalysisTarget => Boolean(target));
}

function createAgentDashboardUrl(pathname: string, organizationId?: string): URL {
  const requestUrl = new URL(pathname, window.location.origin);
  if (organizationId?.trim()) requestUrl.searchParams.set("organizationId", organizationId.trim());
  return requestUrl;
}

function openclawAgentIdFromAgentId(agentId: string, agentName = ""): string {
  return agentId.split(":agent:").at(-1) || agentName;
}

function confidenceTone(value: string): PillTone {
  if (value === "high") return "blue";
  if (value === "medium") return "purple";
  return "muted";
}

function caseStatusTone(value: string): PillTone {
  if (value === "done") return "green";
  if (value === "failed") return "orange";
  if (value === "cancelled") return "muted";
  return "yellow";
}

function formatDuration(value?: number): string {
  if (!Number.isFinite(value) || !value) return "未统计";
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatTimeOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "未上报";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function formatPeriodLabel(periodStart: string, periodEnd: string): string {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return periodEnd || periodStart || "未知周期";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(end.getTime() - 1));
}
