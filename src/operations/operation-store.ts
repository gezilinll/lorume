import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";

const { Pool } = pg;

/** User-visible asynchronous operation status. */
export type OperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unsupported"
  | "requires_manual_step"
  | "cancelled";

/** Backend-executable job status. */
export type OperationJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unsupported"
  | "requires_manual_step"
  | "cancelled";

/** Operation type currently supported by Lorume. */
export type OperationType =
  | "notification_delivery"
  | "collector_upgrade";

/** Operation job type currently supported by Lorume. */
export type OperationJobType =
  | "notification_in_app"
  | "notification_email"
  | "collector_upgrade_device";

/** Persisted operation row. */
export interface OperationRow {
  id: string;
  organizationId: string;
  type: OperationType;
  status: OperationStatus;
  resourceType?: string | null;
  resourceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  requestedByUserId?: string | null;
  summary: string;
  errorSummary?: string | null;
  manualInstruction?: string | null;
  metadata: Record<string, unknown>;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Persisted operation job row. */
export interface OperationJobRow {
  id: string;
  operationId: string;
  organizationId: string;
  type: OperationJobType;
  status: OperationJobStatus;
  payload: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  runAfter: Date;
  lockedBy?: string | null;
  lockedUntil?: Date | null;
  lastErrorSummary?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Create operation input. */
export interface CreateOperationInput {
  organizationId: string;
  type: OperationType;
  requestedByUserId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Enqueue operation job input. */
export interface EnqueueOperationJobInput {
  operationId: string;
  organizationId: string;
  type: OperationJobType;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAfter?: Date;
}

/** List operation input for UI and API queries. */
export interface ListOperationsInput {
  organizationId: string;
  status?: OperationStatus;
  resourceType?: string;
  resourceId?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
}

/** Postgres-backed operation repository. */
export interface OperationStore {
  createOperation: (input: CreateOperationInput) => Promise<OperationRow>;
  enqueueJob: (input: EnqueueOperationJobInput) => Promise<OperationJobRow>;
  listOperations: (input: ListOperationsInput) => Promise<OperationRow[]>;
  listJobs: (input: { operationId: string; limit?: number }) => Promise<OperationJobRow[]>;
  claimNextJob: (input: { runnerId: string; now: Date; leaseMs: number }) => Promise<OperationJobRow | null>;
  updateJobPayload: (input: {
    jobId: string;
    now?: Date;
    payloadPatch: Record<string, unknown>;
  }) => Promise<OperationJobRow | null>;
  completeJob: (input: {
    jobId: string;
    manualInstruction?: string;
    now: Date;
    status: "succeeded" | "unsupported" | "requires_manual_step";
  }) => Promise<OperationJobRow | null>;
  completeExternalJob: (input: {
    jobId: string;
    now: Date;
    status: "succeeded" | "failed" | "unsupported" | "requires_manual_step";
    errorSummary?: string;
    manualInstruction?: string;
    payloadPatch?: Record<string, unknown>;
  }) => Promise<OperationJobRow | null>;
  failJob: (input: { jobId: string; now: Date; errorSummary: string; retryAfterMs?: number }) => Promise<OperationJobRow | null>;
  updateOperationStatus: (input: {
    operationId: string;
    status: OperationStatus;
    now?: Date;
    errorSummary?: string | null;
    manualInstruction?: string | null;
  }) => Promise<OperationRow | null>;
  readOperation: (input: { operationId: string }) => Promise<OperationRow | null>;
  close: () => Promise<void>;
}

/** Postgres operation store options. */
export interface PostgresOperationStoreOptions {
  connectionString?: string;
}

/** Create a Postgres-backed operation store. */
export function createPostgresOperationStore(options: PostgresOperationStoreOptions = {}): OperationStore {
  const pool = new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL ?? "postgres://lorume:lorume@127.0.0.1:54329/lorume",
  });

  return {
    async createOperation(input) {
      const result = await pool.query<OperationRow>(`
        INSERT INTO operations (
          id,
          organization_id,
          type,
          requested_by_user_id,
          resource_type,
          resource_id,
          target_type,
          target_id,
          summary,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING ${operationColumns}
      `, [
        createId("op"),
        input.organizationId,
        input.type,
        input.requestedByUserId ?? null,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.targetType ?? null,
        input.targetId ?? null,
        input.summary,
        JSON.stringify(input.metadata ?? {}),
      ]);
      return result.rows[0];
    },
    async enqueueJob(input) {
      const result = await pool.query<OperationJobRow>(`
        INSERT INTO operation_jobs (
          id,
          operation_id,
          organization_id,
          type,
          payload,
          max_attempts,
          run_after
        )
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
        RETURNING ${jobColumns}
      `, [
        createId("opjob"),
        input.operationId,
        input.organizationId,
        input.type,
        JSON.stringify(input.payload ?? {}),
        input.maxAttempts ?? 3,
        input.runAfter ?? null,
      ]);
      return result.rows[0];
    },
    async listOperations(input) {
      const params: unknown[] = [input.organizationId];
      const filters = ["organization_id = $1"];
      appendOptionalFilter(filters, params, "status", input.status);
      appendOptionalFilter(filters, params, "resource_type", input.resourceType);
      appendOptionalFilter(filters, params, "resource_id", input.resourceId);
      appendOptionalFilter(filters, params, "target_type", input.targetType);
      appendOptionalFilter(filters, params, "target_id", input.targetId);
      params.push(normalizeLimit(input.limit));
      const result = await pool.query<OperationRow>(`
        SELECT ${operationColumns}
        FROM operations
        WHERE ${filters.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $${params.length}
      `, params);
      return result.rows;
    },
    async listJobs(input) {
      const result = await pool.query<OperationJobRow>(`
        SELECT ${jobColumns}
        FROM operation_jobs
        WHERE operation_id = $1
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $2
      `, [input.operationId, normalizeLimit(input.limit)]);
      return result.rows;
    },
    async claimNextJob(input) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<OperationJobRow>(`
          WITH candidate AS (
            SELECT id
            FROM operation_jobs
            WHERE (
                status = 'queued'
                AND run_after <= $2
              )
              OR (
                status = 'running'
                AND locked_until IS NOT NULL
                AND locked_until <= $2
              )
            ORDER BY run_after ASC, created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE operation_jobs job
          SET
            status = 'running',
            attempt_count = attempt_count + 1,
            locked_by = $1,
            locked_until = $2 + ($3::text || ' milliseconds')::interval,
            started_at = COALESCE(started_at, $2),
            updated_at = $2
          FROM candidate
          WHERE job.id = candidate.id
          RETURNING ${prefixedJobColumns("job")}
        `, [input.runnerId, input.now, input.leaseMs]);
        const job = result.rows[0] ?? null;
        if (!job) return null;
        await markOperationRunning(client, job.operationId, input.now);
        return job;
      });
    },
    async updateJobPayload(input) {
      const now = input.now ?? new Date();
      const result = await pool.query<OperationJobRow>(`
        UPDATE operation_jobs
        SET
          payload = payload || $2::jsonb,
          updated_at = $3
        WHERE id = $1
        RETURNING ${jobColumns}
      `, [input.jobId, JSON.stringify(input.payloadPatch), now]);
      return result.rows[0] ?? null;
    },
    async completeJob(input) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<OperationJobRow>(`
          UPDATE operation_jobs
          SET
            status = $2,
            locked_by = NULL,
            locked_until = NULL,
            finished_at = $3,
            updated_at = $3
          WHERE id = $1
          RETURNING ${jobColumns}
        `, [input.jobId, input.status, input.now]);
        const job = result.rows[0] ?? null;
        if (job) {
          await refreshOperationStatus(client, job.operationId, input.now, undefined, input.manualInstruction);
        }
        return job;
      });
    },
    async completeExternalJob(input) {
      return withTransaction(pool, async (client) => {
        const errorSummary = input.errorSummary ? sanitizeSummary(input.errorSummary) : null;
        const result = await client.query<OperationJobRow>(`
          UPDATE operation_jobs
          SET
            status = $2,
            payload = payload || $3::jsonb,
            locked_by = NULL,
            locked_until = NULL,
            last_error_summary = CASE WHEN $2 = 'failed' THEN $4 ELSE last_error_summary END,
            finished_at = $5,
            updated_at = $5
          WHERE id = $1
          RETURNING ${jobColumns}
        `, [
          input.jobId,
          input.status,
          JSON.stringify(input.payloadPatch ?? {}),
          errorSummary,
          input.now,
        ]);
        const job = result.rows[0] ?? null;
        if (job) {
          await refreshOperationStatus(
            client,
            job.operationId,
            input.now,
            errorSummary ?? undefined,
            input.manualInstruction,
          );
        }
        return job;
      });
    },
    async failJob(input) {
      return withTransaction(pool, async (client) => {
        const jobResult = await client.query<OperationJobRow>(`
          SELECT ${jobColumns}
          FROM operation_jobs
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
        `, [input.jobId]);
        const job = jobResult.rows[0] ?? null;
        if (!job) return null;
        const shouldRetry = job.attemptCount < job.maxAttempts;
        const nextStatus: OperationJobStatus = shouldRetry ? "queued" : "failed";
        const runAfter = new Date(input.now.getTime() + (input.retryAfterMs ?? 0));
        const result = await client.query<OperationJobRow>(`
          UPDATE operation_jobs
          SET
            status = $2,
            locked_by = NULL,
            locked_until = NULL,
            run_after = $3,
            last_error_summary = $4,
            finished_at = CASE WHEN $2 = 'failed' THEN $5 ELSE finished_at END,
            updated_at = $5
          WHERE id = $1
          RETURNING ${jobColumns}
        `, [input.jobId, nextStatus, runAfter, sanitizeSummary(input.errorSummary), input.now]);
        await refreshOperationStatus(client, job.operationId, input.now, sanitizeSummary(input.errorSummary));
        return result.rows[0] ?? null;
      });
    },
    async readOperation(input) {
      const result = await pool.query<OperationRow>(`
        SELECT ${operationColumns}
        FROM operations
        WHERE id = $1
        LIMIT 1
      `, [input.operationId]);
      return result.rows[0] ?? null;
    },
    async updateOperationStatus(input) {
      const now = input.now ?? new Date();
      const result = await pool.query<OperationRow>(`
        UPDATE operations
        SET
          status = $2,
          error_summary = $3,
          manual_instruction = $4,
          started_at = CASE
            WHEN $2 = 'running' THEN coalesce(started_at, $5)
            ELSE started_at
          END,
          finished_at = CASE
            WHEN $2 IN ('succeeded', 'failed', 'unsupported', 'requires_manual_step', 'cancelled') THEN $5
            ELSE NULL
          END,
          updated_at = $5
        WHERE id = $1
        RETURNING ${operationColumns}
      `, [
        input.operationId,
        input.status,
        input.errorSummary ? sanitizeSummary(input.errorSummary) : null,
        input.manualInstruction ?? null,
        now,
      ]);
      return result.rows[0] ?? null;
    },
    close() {
      return pool.end();
    },
  };
}

const operationColumns = `
  id,
  organization_id AS "organizationId",
  type,
  status,
  resource_type AS "resourceType",
  resource_id AS "resourceId",
  target_type AS "targetType",
  target_id AS "targetId",
  requested_by_user_id AS "requestedByUserId",
  summary,
  error_summary AS "errorSummary",
  manual_instruction AS "manualInstruction",
  metadata,
  started_at AS "startedAt",
  finished_at AS "finishedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const jobColumns = `
  id,
  operation_id AS "operationId",
  organization_id AS "organizationId",
  type,
  status,
  payload,
  attempt_count AS "attemptCount",
  max_attempts AS "maxAttempts",
  run_after AS "runAfter",
  locked_by AS "lockedBy",
  locked_until AS "lockedUntil",
  last_error_summary AS "lastErrorSummary",
  started_at AS "startedAt",
  finished_at AS "finishedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function prefixedJobColumns(prefix: string): string {
  return `
    ${prefix}.id,
    ${prefix}.operation_id AS "operationId",
    ${prefix}.organization_id AS "organizationId",
    ${prefix}.type,
    ${prefix}.status,
    ${prefix}.payload,
    ${prefix}.attempt_count AS "attemptCount",
    ${prefix}.max_attempts AS "maxAttempts",
    ${prefix}.run_after AS "runAfter",
    ${prefix}.locked_by AS "lockedBy",
    ${prefix}.locked_until AS "lockedUntil",
    ${prefix}.last_error_summary AS "lastErrorSummary",
    ${prefix}.started_at AS "startedAt",
    ${prefix}.finished_at AS "finishedAt",
    ${prefix}.created_at AS "createdAt",
    ${prefix}.updated_at AS "updatedAt"
  `;
}

async function markOperationRunning(
  client: PoolClient,
  operationId: string,
  now: Date,
): Promise<void> {
  await client.query(`
    UPDATE operations
    SET status = 'running', started_at = COALESCE(started_at, $2), updated_at = $2
    WHERE id = $1
      AND status IN ('queued', 'running')
  `, [operationId, now]);
}

async function refreshOperationStatus(
  client: PoolClient,
  operationId: string,
  now: Date,
  errorSummary?: string,
  manualInstruction?: string,
): Promise<void> {
  const jobs = await client.query<{ status: OperationJobStatus }>(`
    SELECT status
    FROM operation_jobs
    WHERE operation_id = $1
  `, [operationId]);
  const statuses = jobs.rows.map((row) => row.status);
  if (statuses.some((status) => status === "failed")) {
    await finishOperation(client, operationId, "failed", now, errorSummary);
    return;
  }
  if (statuses.some((status) => status === "requires_manual_step")) {
    await finishOperation(client, operationId, "requires_manual_step", now, errorSummary, manualInstruction);
    return;
  }
  if (statuses.some((status) => status === "unsupported")) {
    await finishOperation(client, operationId, "unsupported", now, errorSummary);
    return;
  }
  if (statuses.length > 0 && statuses.every((status) => status === "succeeded")) {
    await finishOperation(client, operationId, "succeeded", now);
    return;
  }
  if (statuses.some((status) => status === "running")) {
    await markOperationRunning(client, operationId, now);
    return;
  }
  await client.query(`
    UPDATE operations
    SET status = 'queued', error_summary = COALESCE($3, error_summary), updated_at = $2
    WHERE id = $1
      AND status <> 'cancelled'
  `, [operationId, now, errorSummary ?? null]);
}

async function finishOperation(
  client: PoolClient,
  operationId: string,
  status: OperationStatus,
  now: Date,
  errorSummary?: string,
  manualInstruction?: string,
): Promise<void> {
  await client.query(`
    UPDATE operations
    SET
      status = $2,
      error_summary = $3,
      manual_instruction = $4,
      finished_at = $5,
      updated_at = $5
    WHERE id = $1
  `, [operationId, status, errorSummary ?? null, manualInstruction ?? null, now]);
}

async function withTransaction<T>(pool: pg.Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sanitizeSummary(value: string): string {
  return value.trim().slice(0, 500);
}

function appendOptionalFilter(filters: string[], params: unknown[], column: string, value?: string | null): void {
  if (!value) return;
  params.push(value);
  filters.push(`${column} = $${params.length}`);
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(limit ?? 50)));
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
