import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  FileText,
  ListChecks,
  MessageSquareText,
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
                  <PerformanceCard analysis={selectedReport.analysis} />
                  <TaskTypesCard analysis={selectedReport.analysis} />
                  <FeedbackCard analysis={selectedReport.analysis} />
                  <CasesCard analysis={selectedReport.analysis} />
                  <RisksAndActionsCard analysis={selectedReport.analysis} />
                  <TaskStatusCard hardMetrics={selectedReport.hardMetrics} />
                </div>
                <aside className="min-w-0 space-y-4 xl:sticky xl:top-20" aria-label="报告和任务状态">
                  <OperationCard detail={operationDetail} report={selectedReport} />
                  <ReportHistory
                    reports={reports}
                    selectedReportId={selectedReport.id}
                    onSelect={setSelectedReportId}
                  />
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
    <section className="min-w-0 space-y-2" aria-labelledby="agent-dashboard-overview-title">
      <h2 id="agent-dashboard-overview-title" className="text-sm font-bold text-foreground">运行概览</h2>
      <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="任务总数" meta="本周期内已采集任务" value={String(hardMetrics.totalTasks)} />
        <MetricTile
          label="失败 / 未知"
          meta="需要关注的异常任务"
          tone="warning"
          value={`${hardMetrics.failedCount} / ${hardMetrics.unknownCount}`}
        />
        <MetricTile
          label="平均 / P90 耗时"
          meta="已完成和失败任务的执行耗时"
          value={`${formatDuration(hardMetrics.duration.avgMs)} / ${formatDuration(hardMetrics.duration.p90Ms)}`}
        />
        <MetricTile
          label="最近活跃"
          meta="本周期最后一次任务更新"
          tone="success"
          value={hardMetrics.lastActiveAt ? formatTimeOnly(hardMetrics.lastActiveAt) : "未上报"}
        />
      </div>
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
          <Pill tone={tone === "warning" ? "orange" : tone === "success" ? "green" : "blue"}>{tone === "warning" ? "关注" : tone === "success" ? "正常" : "概览"}</Pill>
        </div>
        <div className="mt-3 text-2xl font-black tracking-normal text-foreground">{value}</div>
        <p className="mt-2 text-xs text-muted-foreground">{meta}</p>
      </CardContent>
    </Card>
  );
}

function TaskStatusCard({ hardMetrics }: { hardMetrics: AgentDashboardHardMetrics }) {
  const total = Math.max(1, hardMetrics.totalTasks);
  const doneCount = hardMetrics.statusCounts.done ?? 0;
  const failedCount = hardMetrics.statusCounts.failed ?? 0;
  const unknownCount = hardMetrics.statusCounts.unknown ?? 0;
  const cancelledCount = hardMetrics.statusCounts.cancelled ?? 0;
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle aria-label="任务状态" aria-level={2} className="flex items-center justify-between gap-3" role="heading">
          <span className="inline-flex items-center gap-2"><BarChart3 className="size-4" aria-hidden="true" />任务状态</span>
          <span className="text-xs font-normal text-muted-foreground">完成、失败和未知任务分布</span>
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

function PerformanceCard({ analysis }: { analysis: AgentDashboardAnalysis }) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle aria-level={2} className="flex items-center gap-2" role="heading">
          <Activity className="size-4" aria-hidden="true" />
          运行表现
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-2">
          <InsightBlock label="工作量" text={analysis.periodPerformance.workload} />
          <InsightBlock label="完成情况" text={analysis.periodPerformance.completion} />
          <InsightBlock label="耗时表现" text={analysis.periodPerformance.latency} />
          <InsightBlock label="异常模式" text={analysis.periodPerformance.failurePattern} />
        </div>
      </CardContent>
    </Card>
  );
}

function TaskTypesCard({ analysis }: { analysis: AgentDashboardAnalysis }) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle aria-label="任务类型" aria-level={2} className="flex items-center justify-between gap-3" role="heading">
          <span className="inline-flex items-center gap-2"><ListChecks className="size-4" aria-hidden="true" />任务类型</span>
          <span className="text-xs font-normal text-muted-foreground">按本周期会话归纳</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table aria-label="任务类型">
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>数量估计</TableHead>
                <TableHead>用户反馈</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysis.taskTypes.length ? analysis.taskTypes.map((taskType) => (
                <TableRow key={taskType.label}>
                  <TableCell className="font-medium">{taskType.label}</TableCell>
                  <TableCell>{taskType.countEstimate}</TableCell>
                  <TableCell><Pill tone={satisfactionTone(taskType.satisfaction.level)}>{satisfactionLabel(taskType.satisfaction.level)}</Pill></TableCell>
                  <TableCell className="min-w-[240px] text-muted-foreground">{taskType.description}</TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={4} className="text-muted-foreground">暂无任务类型归纳。</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function FeedbackCard({ analysis }: { analysis: AgentDashboardAnalysis }) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle aria-level={2} className="flex items-center gap-2" role="heading"><MessageSquareText className="size-4" aria-hidden="true" />用户反馈</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        {analysis.taskTypes.length ? analysis.taskTypes.map((taskType) => (
          <div className="rounded-[10px] border bg-background p-3" key={taskType.label}>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <strong className="truncate text-sm">{taskType.label}</strong>
              <Pill tone={satisfactionTone(taskType.satisfaction.level)}>{satisfactionLabel(taskType.satisfaction.level)}</Pill>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{taskType.satisfaction.reason || "暂无可读反馈判断。"}</p>
            {taskType.satisfaction.evidenceIds.length ? (
              <p className="mt-2 truncate font-mono text-xs text-muted-foreground">证据: {taskType.satisfaction.evidenceIds.join(", ")}</p>
            ) : null}
          </div>
        )) : <p className="text-sm text-muted-foreground">暂无用户反馈归纳。</p>}
      </CardContent>
    </Card>
  );
}

function CasesCard({ analysis }: { analysis: AgentDashboardAnalysis }) {
  const cases = analysis.taskTypes.flatMap((taskType) =>
    taskType.cases.map((item) => ({ ...item, taskTypeLabel: taskType.label }))
  );
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle aria-level={2} className="flex items-center gap-2" role="heading"><FileText className="size-4" aria-hidden="true" />典型案例</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table aria-label="典型案例">
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>案例</TableHead>
                <TableHead>反馈</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>原因</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.length ? cases.map((item) => (
                <TableRow key={`${item.taskTypeLabel}-${item.id}`}>
                  <TableCell>{item.taskTypeLabel}</TableCell>
                  <TableCell>
                    <span className="block font-medium">{item.title}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{item.id}</span>
                  </TableCell>
                  <TableCell><Pill tone={satisfactionTone(item.signal)}>{satisfactionLabel(item.signal)}</Pill></TableCell>
                  <TableCell className="min-w-[180px] text-muted-foreground">{item.outcome}</TableCell>
                  <TableCell className="min-w-[220px] text-muted-foreground">{item.reason}</TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={5} className="text-muted-foreground">暂无典型案例。</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function RisksAndActionsCard({ analysis }: { analysis: AgentDashboardAnalysis }) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle aria-level={2} className="flex items-center gap-2" role="heading"><AlertTriangle className="size-4" aria-hidden="true" />风险与建议</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 text-xs font-bold text-foreground">风险</h3>
          <div className="space-y-2">
            {analysis.risks.length ? analysis.risks.map((risk) => (
              <EvidenceBlock description={risk.description} evidenceIds={risk.evidenceIds} key={risk.title} title={risk.title} />
            )) : <p className="text-sm text-muted-foreground">暂无明显风险。</p>}
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-xs font-bold text-foreground">建议</h3>
          <div className="space-y-2">
            {analysis.actions.length ? analysis.actions.map((action) => (
              <EvidenceBlock description={action.reason} evidenceIds={action.evidenceIds} key={action.title} title={action.title} />
            )) : <p className="text-sm text-muted-foreground">暂无建议动作。</p>}
          </div>
        </section>
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
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle aria-label="分析任务" aria-level={2} className="flex items-center justify-between gap-3" role="heading">
          <span className="inline-flex items-center gap-2"><Activity className="size-4" aria-hidden="true" />分析任务</span>
          <StatusBadge tone={detail?.operation.status === "failed" ? "danger" : detail?.operation.status === "running" ? "warning" : "success"}>
            {operationStatusLabels[detail?.operation.status ?? "succeeded"]}
          </StatusBadge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <TimelineItem active={Boolean(detail)} label="已接收" text="设备已接收分析请求" />
        <TimelineItem active={stage === "executing" || detail?.operation.status === "running"} label="分析中" text={typeof job?.payload.message === "string" ? job.payload.message : "正在生成本周期分析报告"} />
        <TimelineItem active={!detail || detail.operation.status === "succeeded"} label="已生成" text="报告已完成并入库" />
        <p className="border-t pt-3 text-xs text-muted-foreground">报告生成时间：{formatDateTime(report.createdAt)}</p>
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
        <CardTitle aria-label="报告历史" aria-level={2} className="flex items-center justify-between gap-3" role="heading">
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
              <span className="block text-xs text-muted-foreground">{report.hardMetrics.totalTasks} 个任务 / 平均 {formatDuration(report.hardMetrics.duration.avgMs)}</span>
            </span>
          </Button>
        )) : <p className="text-sm text-muted-foreground">暂无报告历史。</p>}
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
        <p className="mt-2 text-sm text-muted-foreground">可以手动运行一次分析，生成本 Agent 的周期报告。</p>
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

function InsightBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-[10px] border bg-background p-3">
      <h3 className="text-xs font-bold text-foreground">{label}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{text || "暂无判断。"}</p>
    </div>
  );
}

function EvidenceBlock({
  description,
  evidenceIds,
  title,
}: {
  description: string;
  evidenceIds: string[];
  title: string;
}) {
  return (
    <div className="rounded-[10px] border p-3">
      <strong className="text-sm">{title}</strong>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      {evidenceIds.length ? (
        <p className="mt-2 truncate font-mono text-xs text-muted-foreground">证据: {evidenceIds.join(", ")}</p>
      ) : null}
    </div>
  );
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

function satisfactionLabel(value: string): string {
  if (value === "positive") return "偏正向";
  if (value === "mixed") return "分化明显";
  if (value === "negative") return "偏负向";
  return "证据不足";
}

function satisfactionTone(value: string): PillTone {
  if (value === "positive") return "green";
  if (value === "mixed") return "orange";
  if (value === "negative") return "danger";
  return "muted";
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
