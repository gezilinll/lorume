import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  computeOpenClawHardMetrics,
  type AgentAnalysisResult,
  type AgentAnalysisTaskRow,
  type OpenClawHardMetrics,
} from "./agent-analysis-model";

const { Pool } = pg;

export interface AgentAnalysisTarget {
  agentId: string;
  agentName: string;
  deviceId: string;
  openclawAgentId: "main";
  organizationId: string;
  runtimeId: string;
  runtimeKind: "openclaw";
}

export interface AgentAnalysisReportRow {
  id: string;
  organizationId: string;
  operationId: string;
  deviceId: string;
  runtimeId: string;
  agentId: string;
  runtimeKind: string;
  periodStart: Date;
  periodEnd: Date;
  promptKind: string;
  promptVersion: string;
  hardMetrics: OpenClawHardMetrics;
  analysis: AgentAnalysisResult;
  modelMetadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AgentAnalysisReportInput {
  organizationId: string;
  operationId: string;
  deviceId: string;
  runtimeId: string;
  agentId: string;
  runtimeKind: string;
  periodStart: string;
  periodEnd: string;
  promptKind: string;
  promptVersion: string;
  hardMetrics: OpenClawHardMetrics;
  analysis: AgentAnalysisResult;
  modelMetadata: Record<string, unknown>;
}

export interface AgentAnalysisMetricsInput {
  organizationId: string;
  agentId: string;
  periodStart: string;
  periodEnd: string;
}

export interface AgentAnalysisStore {
  readOpenClawAgentTarget: (input: { organizationId: string; agentId: string }) => Promise<AgentAnalysisTarget | null>;
  listOpenClawMainTargets: (input: { organizationId?: string; limit?: number }) => Promise<AgentAnalysisTarget[]>;
  computeOpenClawAgentMetrics: (input: AgentAnalysisMetricsInput) => Promise<{
    hardMetrics: OpenClawHardMetrics;
  }>;
  upsertReport: (input: AgentAnalysisReportInput) => Promise<AgentAnalysisReportRow>;
  listReports: (input: { organizationId: string; agentId?: string; limit?: number }) => Promise<AgentAnalysisReportRow[]>;
  readReport: (input: { organizationId: string; reportId: string }) => Promise<AgentAnalysisReportRow | null>;
  hasReport: (input: {
    organizationId: string;
    agentId: string;
    periodStart: string;
    periodEnd: string;
    promptVersion: string;
  }) => Promise<boolean>;
  close: () => Promise<void>;
}

export interface PostgresAgentAnalysisStoreOptions {
  connectionString?: string;
}

export function createPostgresAgentAnalysisStore(
  options: PostgresAgentAnalysisStoreOptions = {},
): AgentAnalysisStore {
  const pool = new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL ?? "postgres://lorume:lorume@127.0.0.1:54329/lorume",
  });

  return {
    async readOpenClawAgentTarget(input) {
      const result = await pool.query<AgentAnalysisTargetRow>(`
        SELECT
          d.organization_id AS "organizationId",
          d.id AS "deviceId",
          r.id AS "runtimeId",
          r.kind AS "runtimeKind",
          a.id AS "agentId",
          a.name AS "agentName"
        FROM agents a
        INNER JOIN runtimes r ON r.id = a.runtime_id
        INNER JOIN devices d ON d.id = r.device_id
        WHERE d.organization_id = $1
          AND a.id = $2
        LIMIT 1
      `, [input.organizationId, input.agentId]);
      return normalizeOpenClawTarget(result.rows[0]);
    },
    async listOpenClawMainTargets(input) {
      const params: unknown[] = [normalizeLimit(input.limit)];
      const filters = ["r.kind = 'openclaw'"];
      if (input.organizationId) {
        params.push(input.organizationId);
        filters.push(`d.organization_id = $${params.length}`);
      }
      const result = await pool.query<AgentAnalysisTargetRow>(`
        SELECT
          d.organization_id AS "organizationId",
          d.id AS "deviceId",
          r.id AS "runtimeId",
          r.kind AS "runtimeKind",
          a.id AS "agentId",
          a.name AS "agentName"
        FROM agents a
        INNER JOIN runtimes r ON r.id = a.runtime_id
        INNER JOIN devices d ON d.id = r.device_id
        WHERE ${filters.join(" AND ")}
        ORDER BY d.organization_id, d.id, r.id, a.id
        LIMIT $1
      `, params);
      return result.rows.map(normalizeOpenClawTarget).filter((target): target is AgentAnalysisTarget => Boolean(target));
    },
    async computeOpenClawAgentMetrics(input) {
      const result = await pool.query<TaskMetricRow>(`
        SELECT
          t.id,
          t.task_type AS "taskType",
          t.status,
          t.user_message AS "userMessage",
          t.agent_reply AS "agentReply",
          t.created_source_at AS "createdSourceAt",
          t.updated_source_at AS "updatedSourceAt"
        FROM tasks t
        INNER JOIN agents a ON a.id = t.agent_id
        INNER JOIN runtimes r ON r.id = a.runtime_id
        INNER JOIN devices d ON d.id = r.device_id
        WHERE d.organization_id = $1
          AND t.agent_id = $2
          AND r.kind = 'openclaw'
          AND t.updated_source_at >= $3
          AND t.updated_source_at < $4
        ORDER BY t.updated_source_at DESC NULLS LAST, t.id
      `, [input.organizationId, input.agentId, input.periodStart, input.periodEnd]);
      return computeOpenClawHardMetrics({
        periodEnd: input.periodEnd,
        periodStart: input.periodStart,
        tasks: result.rows.map(taskMetricRowToTask),
      });
    },
    async upsertReport(input) {
      const result = await pool.query<AgentAnalysisReportDbRow>(`
        INSERT INTO agent_analysis_reports (
          id,
          organization_id,
          operation_id,
          device_id,
          runtime_id,
          agent_id,
          runtime_kind,
          period_start,
          period_end,
          prompt_kind,
          prompt_version,
          hard_metrics,
          analysis,
          model_metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb)
        ON CONFLICT (organization_id, agent_id, period_start, period_end, prompt_version) DO UPDATE SET
          operation_id = excluded.operation_id,
          device_id = excluded.device_id,
          runtime_id = excluded.runtime_id,
          runtime_kind = excluded.runtime_kind,
          prompt_kind = excluded.prompt_kind,
          hard_metrics = excluded.hard_metrics,
          analysis = excluded.analysis,
          model_metadata = excluded.model_metadata
        RETURNING ${reportColumns}
      `, [
        createId("agr"),
        input.organizationId,
        input.operationId,
        input.deviceId,
        input.runtimeId,
        input.agentId,
        input.runtimeKind,
        input.periodStart,
        input.periodEnd,
        input.promptKind,
        input.promptVersion,
        JSON.stringify(input.hardMetrics),
        JSON.stringify(input.analysis),
        JSON.stringify(input.modelMetadata ?? {}),
      ]);
      return mapReportRow(result.rows[0]);
    },
    async listReports(input) {
      const params: unknown[] = [input.organizationId, normalizeLimit(input.limit)];
      const filters = ["organization_id = $1"];
      if (input.agentId) {
        params.push(input.agentId);
        filters.push(`agent_id = $${params.length}`);
      }
      const result = await pool.query<AgentAnalysisReportDbRow>(`
        SELECT ${reportColumns}
        FROM agent_analysis_reports
        WHERE ${filters.join(" AND ")}
        ORDER BY period_end DESC, created_at DESC
        LIMIT $2
      `, params);
      return result.rows.map(mapReportRow);
    },
    async readReport(input) {
      const result = await pool.query<AgentAnalysisReportDbRow>(`
        SELECT ${reportColumns}
        FROM agent_analysis_reports
        WHERE organization_id = $1
          AND id = $2
        LIMIT 1
      `, [input.organizationId, input.reportId]);
      return result.rows[0] ? mapReportRow(result.rows[0]) : null;
    },
    async hasReport(input) {
      const result = await pool.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM agent_analysis_reports
          WHERE organization_id = $1
            AND agent_id = $2
            AND period_start = $3
            AND period_end = $4
            AND prompt_version = $5
        ) AS "exists"
      `, [input.organizationId, input.agentId, input.periodStart, input.periodEnd, input.promptVersion]);
      return result.rows[0]?.exists === true;
    },
    close() {
      return pool.end();
    },
  };
}

type AgentAnalysisTargetRow = {
  organizationId: string | null;
  deviceId: string;
  runtimeId: string;
  runtimeKind: string;
  agentId: string;
  agentName: string;
};

type TaskMetricRow = {
  id: string;
  taskType: string;
  status: string;
  userMessage: string | null;
  agentReply: string | null;
  createdSourceAt: Date | null;
  updatedSourceAt: Date | null;
};

type AgentAnalysisReportDbRow = {
  id: string;
  organizationId: string;
  operationId: string;
  deviceId: string;
  runtimeId: string;
  agentId: string;
  runtimeKind: string;
  periodStart: Date;
  periodEnd: Date;
  promptKind: string;
  promptVersion: string;
  hardMetrics: OpenClawHardMetrics;
  analysis: AgentAnalysisResult;
  modelMetadata: Record<string, unknown>;
  createdAt: Date;
};

const reportColumns = `
  id,
  organization_id AS "organizationId",
  operation_id AS "operationId",
  device_id AS "deviceId",
  runtime_id AS "runtimeId",
  agent_id AS "agentId",
  runtime_kind AS "runtimeKind",
  period_start AS "periodStart",
  period_end AS "periodEnd",
  prompt_kind AS "promptKind",
  prompt_version AS "promptVersion",
  hard_metrics AS "hardMetrics",
  analysis,
  model_metadata AS "modelMetadata",
  created_at AS "createdAt"
`;

function normalizeOpenClawTarget(row?: AgentAnalysisTargetRow): AgentAnalysisTarget | null {
  if (!row?.organizationId) return null;
  if (row.runtimeKind !== "openclaw") return null;
  if (openclawAgentIdFromAgent(row.agentId, row.agentName) !== "main") return null;
  return {
    agentId: row.agentId,
    agentName: row.agentName,
    deviceId: row.deviceId,
    openclawAgentId: "main",
    organizationId: row.organizationId,
    runtimeId: row.runtimeId,
    runtimeKind: "openclaw",
  };
}

function openclawAgentIdFromAgent(agentId: string, agentName: string): string {
  const idSuffix = agentId.split(":agent:").at(-1);
  return idSuffix || agentName;
}

function taskMetricRowToTask(row: TaskMetricRow): AgentAnalysisTaskRow {
  return {
    agentReply: row.agentReply,
    createdSourceAt: toIsoString(row.createdSourceAt),
    id: row.id,
    status: row.status,
    taskType: row.taskType,
    updatedSourceAt: toIsoString(row.updatedSourceAt),
    userMessage: row.userMessage,
  };
}

function mapReportRow(row: AgentAnalysisReportDbRow): AgentAnalysisReportRow {
  return {
    agentId: row.agentId,
    analysis: row.analysis,
    createdAt: row.createdAt,
    deviceId: row.deviceId,
    hardMetrics: row.hardMetrics,
    id: row.id,
    modelMetadata: row.modelMetadata,
    operationId: row.operationId,
    organizationId: row.organizationId,
    periodEnd: row.periodEnd,
    periodStart: row.periodStart,
    promptKind: row.promptKind,
    promptVersion: row.promptVersion,
    runtimeId: row.runtimeId,
    runtimeKind: row.runtimeKind,
  };
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(limit ?? 50)));
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
