import type { OperationStore } from "../operations/operation-store";
import { agentAnalysisPromptVersion } from "./agent-analysis-model";
import type { AgentAnalysisStore, AgentAnalysisTarget } from "./agent-analysis-store";
import { createAgentAnalysisRunForTarget, previousShanghaiDayPeriod } from "./agent-analysis-service";

export interface AgentAnalysisScheduler {
  runOnce: () => Promise<{ created: number; skipped: number }>;
  start: () => void;
  stop: () => void;
}

export interface AgentAnalysisSchedulerOptions {
  agentAnalysisStore: Pick<AgentAnalysisStore, "hasReport" | "listOpenClawMainTargets">;
  operationStore: Pick<OperationStore, "createOperation" | "enqueueJob" | "listOperations">;
  intervalMs?: number;
  now?: () => Date;
}

export function createAgentAnalysisScheduler(options: AgentAnalysisSchedulerOptions): AgentAnalysisScheduler {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const runOnce = async () => {
    if (running) return { created: 0, skipped: 0 };
    running = true;
    try {
      const period = previousShanghaiDayPeriod(now());
      const targets = await options.agentAnalysisStore.listOpenClawMainTargets({ limit: 500 });
      let created = 0;
      let skipped = 0;
      for (const target of targets) {
        if (await shouldSkipTarget(options, target, period)) {
          skipped += 1;
          continue;
        }
        await createAgentAnalysisRunForTarget({
          now,
          operationStore: options.operationStore,
        }, {
          organizationId: target.organizationId,
          periodEnd: period.periodEnd,
          periodStart: period.periodStart,
          target,
        });
        created += 1;
      }
      return { created, skipped };
    } finally {
      running = false;
    }
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void runOnce().catch(() => undefined);
      }, Math.max(1_000, intervalMs));
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

async function shouldSkipTarget(
  options: AgentAnalysisSchedulerOptions,
  target: AgentAnalysisTarget,
  period: { periodEnd: string; periodStart: string },
): Promise<boolean> {
  if (await options.agentAnalysisStore.hasReport({
    agentId: target.agentId,
    organizationId: target.organizationId,
    periodEnd: period.periodEnd,
    periodStart: period.periodStart,
    promptVersion: agentAnalysisPromptVersion,
  })) {
    return true;
  }

  for (const status of ["queued", "running"] as const) {
    const operations = await options.operationStore.listOperations({
      limit: 100,
      organizationId: target.organizationId,
      resourceId: target.agentId,
      resourceType: "agent",
      status,
    });
    if (operations.some((operation) =>
      operation.type === "agent_analysis" &&
      operation.metadata?.periodStart === period.periodStart &&
      operation.metadata?.periodEnd === period.periodEnd &&
      operation.metadata?.promptVersion === agentAnalysisPromptVersion
    )) {
      return true;
    }
  }
  return false;
}
