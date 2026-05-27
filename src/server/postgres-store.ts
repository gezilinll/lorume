import pg from "pg";
import {
  deriveDeviceCollectionHealth,
  type CollectionHealthIngestion,
  type DeviceCollectionHealth,
} from "../runtime/runtime-collection-health";
import {
  normalizeAgentSkillProbeSnapshot,
  type AgentSkillProbeSnapshot,
} from "../runtime/agent-skill-probe";
import {
  createDeviceStateSnapshot,
  createEmptyRuntimeFleetTaskSummary,
  createEmptyTaskStatusCounts,
  RUNTIME_TASK_BOARD_VISIBLE_STATUSES,
  TASK_CHANNEL_KIND_LABELS,
  TASK_STATUSES,
  type Agent,
  type CollectionDiagnosticItem,
  type Device,
  type DeviceStateSnapshot,
  type RuntimeFleetTaskSummary,
  type Runtime,
  type Task,
  type TaskChannelKind,
  type TaskStatus,
  type TaskStatusCounts,
} from "../runtime/runtime-model";
import type { RuntimeTaskBatch } from "../runtime/runtime-task-sync";

const { Pool } = pg;

type CollectorSnapshotType = "device_state" | "task_batch";

export interface PostgresOrganizationScope {
  organizationId?: string | null;
}

/** Construction options for the Postgres-backed Lorume repository. */
export interface PostgresStoreOptions {
  /** Postgres connection string; defaults to local compose Postgres. */
  connectionString?: string;
}

/** Counts returned from a successful collector ingestion. */
export interface PostgresIngestionResult {
  /** Device that produced the snapshot. */
  deviceId: string;
  /** Snapshot type persisted by the repository. */
  snapshotType: CollectorSnapshotType;
  /** Object counts written by this ingestion. */
  counts: Record<string, number>;
}

export interface PostgresTaskBatchResult {
  deviceId: string;
  batchId: string;
  acked: Array<{ id: string; hash: string }>;
  removed: Array<{ id: string }>;
  counts: Record<string, number>;
}

/** Small table-count summary used by backend harnesses. */
export interface PostgresEntityCounts {
  devices: number;
  runtimes: number;
  agents: number;
  tasks: number;
  agentSkillProbeSnapshots: number;
  collectorIngestions: number;
}

/** Query row for one collector ingestion. */
export interface PostgresCollectorIngestion {
  deviceId: string;
  snapshotType: CollectorSnapshotType;
  status: "succeeded" | "failed";
  collectedAt: string | Date | null;
  receivedAt: string | Date;
  counts: Record<string, number>;
  diagnostics: CollectionDiagnosticItem[];
  error?: string | null;
}

const taskOrderExpression = "coalesce(t.updated_source_at, t.created_source_at, t.updated_at, t.created_at)";

interface PostgresTaskQueryRow {
  raw: Task;
  orderTimestamp: Date | null;
}

interface PostgresRuntimeFleetTaskSummaryRow {
  agentId: string;
  runtimeId: string | null;
  deviceId: string | null;
  status: string;
  count: string;
  lastActiveAt: Date | null;
}

interface PostgresTaskStatusSummaryRow {
  status: string;
  count: string;
}

interface PostgresTaskChannelFacetRow {
  kind: string;
  count: string;
}

/** Backend query result for Runtime Fleet. */
export interface PostgresRuntimeFleetResult {
  collectedAt: string | null;
  devices: Device[];
  runtimes: Runtime[];
  agents: Agent[];
  taskSummary: RuntimeFleetTaskSummary;
  summary: {
    deviceCount: number;
    runtimeCount: number;
    agentCount: number;
    taskCount: number;
  };
}

/** Backend query filters for unified Task rows. */
export interface PostgresRuntimeTaskFilters {
  organizationId?: string | null;
  taskType?: string | null;
  statusScope?: string | null;
  status?: string | null;
  channelKind?: string | null;
  channelKinds?: string[] | null;
  startAt?: string | null;
  endAt?: string | null;
  search?: string | null;
  limit?: number;
  cursor?: string | null;
}

/** Backend query result for unified Task rows. */
export interface PostgresRuntimeTaskResult {
  items: Task[];
  total: number;
  nextCursor?: string;
  summary: {
    total: number;
    byStatus: TaskStatusCounts;
  };
  facets: {
    channels: Array<{ kind: TaskChannelKind; label: string; count: number }>;
  };
}

/** Postgres-backed repository for the current Device / Runtime / Agent / Task model. */
export interface PostgresStore {
  /** Upsert a unified Device / Runtime / Agent / Task snapshot. */
  upsertDeviceStateSnapshot: (snapshot: DeviceStateSnapshot, scope?: PostgresOrganizationScope) => Promise<PostgresIngestionResult>;
  /** Upsert one changed Task batch and return ACKs for cache advancement. */
  upsertRuntimeTaskBatch: (batch: RuntimeTaskBatch, scope?: PostgresOrganizationScope) => Promise<PostgresTaskBatchResult>;
  /** Record a failed collector ingestion when a report cannot be persisted as a valid snapshot. */
  recordFailedCollectorIngestion: (input: PostgresFailedCollectorIngestionInput) => Promise<void>;
  /** Verify the repository can serve backend traffic. */
  checkReady: () => Promise<void>;
  /** Read coarse entity counts for harnesses and smoke diagnostics. */
  readEntityCounts: () => Promise<PostgresEntityCounts>;
  /** Read current Runtime Fleet records from Postgres. */
  readRuntimeFleet: (scope?: PostgresOrganizationScope) => Promise<PostgresRuntimeFleetResult>;
  /** Query unified product Task rows from Postgres. */
  listRuntimeTasks: (filters?: PostgresRuntimeTaskFilters) => Promise<PostgresRuntimeTaskResult>;
  /** Upsert the latest read-only Agent Skill probe snapshot. */
  upsertAgentSkillProbeSnapshot: (snapshot: AgentSkillProbeSnapshot) => Promise<AgentSkillProbeSnapshot>;
  /** Read the latest read-only Agent Skill probe snapshot for one Agent. */
  readAgentSkillProbeSnapshot: (agentId: string, scope?: PostgresOrganizationScope) => Promise<AgentSkillProbeSnapshot | null>;
  /** List collector ingestion metadata for a device. */
  listCollectorIngestions: (deviceId: string, scope?: PostgresOrganizationScope) => Promise<PostgresCollectorIngestion[]>;
  /** Read product-level collection health for one device. */
  readDeviceCollectionHealth: (deviceId: string, scope?: PostgresOrganizationScope) => Promise<DeviceCollectionHealth>;
  /** Close owned Postgres connections. */
  close: () => Promise<void>;
}

/** Failed ingestion metadata captured outside a successful snapshot transaction. */
export interface PostgresFailedCollectorIngestionInput {
  /** Best-known device id from the invalid payload, or `unknown`. */
  deviceId: string;
  /** Snapshot endpoint that received the invalid report. */
  snapshotType: CollectorSnapshotType;
  /** Observed timestamp from the invalid payload when available. */
  collectedAt?: string;
  /** Organization that owned the collector token, when authenticated. */
  organizationId?: string | null;
  /** Structured diagnostics extracted before failure. */
  diagnostics?: CollectionDiagnosticItem[];
  /** Short error summary safe for diagnostics. */
  error: string;
}

/** Create a Postgres repository using Lorume's normalized snapshot semantics. */
export function createPostgresStore(options: PostgresStoreOptions = {}): PostgresStore {
  const pool = new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL ?? "postgres://lorume:lorume@127.0.0.1:54329/lorume",
  });

  async function listCollectorIngestions(deviceId: string, scope: PostgresOrganizationScope = {}): Promise<PostgresCollectorIngestion[]> {
    const organizationId = normalizeOrganizationId(scope.organizationId);
    const result = await pool.query<PostgresCollectorIngestion>(`
      SELECT
        device_id AS "deviceId",
        snapshot_type AS "snapshotType",
        status,
        collected_at AS "collectedAt",
        received_at AS "receivedAt",
        counts,
        diagnostics,
        error
      FROM collector_ingestions
      WHERE device_id = $1
        AND ($2::text IS NULL OR organization_id = $2)
      ORDER BY id DESC
    `, [deviceId, organizationId]);
    return result.rows;
  }

  return {
    upsertDeviceStateSnapshot(snapshot, scope = {}) {
      const organizationId = normalizeOrganizationId(scope.organizationId);
      return withTransaction(pool, async (client) => {
        await assertDeviceOrganizationWritable(client, snapshot.device.id, organizationId);
        await upsertDeviceStateDevice(client, snapshot, organizationId);
        for (const runtime of snapshot.runtimes) await upsertDeviceStateRuntime(client, runtime);
        for (const agent of snapshot.agents) {
          await upsertDeviceStateAgent(client, agent);
        }
        await markAgentsMissingFromPresentRuntimesInvisible(client, snapshot);

        const counts = {
          agents: snapshot.agents.length,
          devices: 1,
          runtimes: snapshot.runtimes.length,
          tasks: 0,
        };
        await insertCollectorIngestion(client, {
          counts,
          deviceId: snapshot.device.id,
          error: null,
          collectedAt: snapshot.collectedAt,
          organizationId,
          snapshotType: "device_state",
          status: "succeeded",
          diagnostics: snapshot.diagnostics?.items ?? [],
        });
        return { deviceId: snapshot.device.id, snapshotType: "device_state", counts };
      });
    },
    upsertRuntimeTaskBatch(batch, scope = {}) {
      const organizationId = normalizeOrganizationId(scope.organizationId);
      return withTransaction(pool, async (client) => {
        await assertDeviceBelongsToOrganization(client, batch.deviceId, organizationId);
        const acked: Array<{ id: string; hash: string }> = [];
        for (const entry of batch.tasks) {
          await upsertTask(client, batch.deviceId, entry.task, entry.hash);
          acked.push({ id: entry.task.id, hash: entry.hash });
        }
        const removed = await markTasksStale(client, batch.deviceId, batch.removedTaskIds, batch.collectedAt);
        const counts = {
          batches: 1,
          removedTasks: removed.length,
          tasks: acked.length,
        };
        await insertCollectorIngestion(client, {
          counts,
          deviceId: batch.deviceId,
          error: null,
          collectedAt: batch.collectedAt,
          organizationId,
          snapshotType: "task_batch",
          status: "succeeded",
          diagnostics: [],
        });
        return { acked, batchId: batch.batchId, counts, deviceId: batch.deviceId, removed };
      });
    },
    async recordFailedCollectorIngestion(input) {
      await insertCollectorIngestion(pool, {
        counts: {},
        deviceId: input.deviceId || "unknown",
        error: input.error,
        collectedAt: input.collectedAt ?? new Date().toISOString(),
        organizationId: normalizeOrganizationId(input.organizationId),
        snapshotType: input.snapshotType,
        status: "failed",
        diagnostics: input.diagnostics ?? [],
      });
    },
    async checkReady() {
      await pool.query("SELECT 1");
    },
    async readEntityCounts() {
      const client = await pool.connect();
      try {
        return {
          agents: await countTable(client, "agents"),
          collectorIngestions: await countTable(client, "collector_ingestions"),
          agentSkillProbeSnapshots: await countTable(client, "agent_skill_probe_snapshots"),
          devices: await countTable(client, "devices"),
          runtimes: await countTable(client, "runtimes"),
          tasks: await countTable(client, "tasks"),
        };
      } finally {
        client.release();
      }
    },
    async readRuntimeFleet(scope = {}) {
      const organizationId = normalizeOrganizationId(scope.organizationId);
      const [deviceResult, runtimeResult, agentResult, taskSummaryResult] = await Promise.all([
        pool.query<{ collector: Device["collector"]; raw: Device; collected_at: Date | null }>(
          "SELECT collector, raw, collected_at FROM devices WHERE ($1::text IS NULL OR organization_id = $1) ORDER BY hostname, id",
          [organizationId],
        ),
        pool.query<{ raw: Runtime }>(`
          SELECT r.raw
          FROM runtimes r
          LEFT JOIN devices d ON d.id = r.device_id
          WHERE ($1::text IS NULL OR d.organization_id = $1)
          ORDER BY r.name
        `, [organizationId]),
        pool.query<{ raw: Agent }>(`
          SELECT a.raw
          FROM agents a
          LEFT JOIN runtimes r ON r.id = a.runtime_id
          LEFT JOIN devices d ON d.id = r.device_id
          WHERE ($1::text IS NULL OR d.organization_id = $1)
          ORDER BY a.name
        `, [organizationId]),
        pool.query<PostgresRuntimeFleetTaskSummaryRow>(`
          SELECT
            t.agent_id AS "agentId",
            a.runtime_id AS "runtimeId",
            r.device_id AS "deviceId",
            t.status,
            count(*)::text AS count,
            max(${taskOrderExpression}) AS "lastActiveAt"
          FROM tasks t
          LEFT JOIN agents a ON a.id = t.agent_id
          LEFT JOIN runtimes r ON r.id = a.runtime_id
          LEFT JOIN devices d ON d.id = t.device_id
          WHERE t.stale_at IS NULL
            AND ($1::text IS NULL OR d.organization_id = $1)
          GROUP BY t.agent_id, a.runtime_id, r.device_id, t.status
        `, [organizationId]),
      ]);
      const collectedAt = deviceResult.rows
        .map((row) => row.collected_at?.toISOString() ?? null)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
      const sanitized = createDeviceStateSnapshot({
        collectedAt: collectedAt ?? new Date().toISOString(),
        device: deviceResult.rows[0]?.raw ?? { id: "backend", hostname: "backend", os: "unknown" },
        runtimes: runtimeResult.rows.map((row) => row.raw),
        agents: agentResult.rows.map((row) => row.raw),
        tasks: [],
      });
      const devices = deviceResult.rows.map((row) => createDeviceStateSnapshot({
        collectedAt: collectedAt ?? new Date().toISOString(),
        device: { ...row.raw, collector: row.collector },
        runtimes: [],
        agents: [],
        tasks: [],
      }).device);
      const runtimes = sanitized.runtimes;
      const agents = sanitized.agents;
      const { taskCount, taskSummary } = buildRuntimeFleetTaskSummary(taskSummaryResult.rows);

      return {
        collectedAt,
        devices,
        runtimes,
        agents,
        taskSummary,
        summary: {
          agentCount: agents.length,
          deviceCount: devices.length,
          runtimeCount: runtimes.length,
          taskCount,
        },
      };
    },
    async listRuntimeTasks(filters = {}) {
      const { clause, values } = createTaskWhereClause(filters);
      const summaryPromise = readTaskStatusSummary(pool, filters);
      const facetsPromise = readTaskFacets(pool, filters);
      const countResult = await pool.query<{ count: string }>(
        `SELECT count(*) AS count
        FROM tasks t
        LEFT JOIN agents a ON a.id = t.agent_id
        LEFT JOIN runtimes r ON r.id = a.runtime_id
        LEFT JOIN devices d ON d.id = t.device_id
        ${clause}`,
        values,
      );
      const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
      const result = await pool.query<PostgresTaskQueryRow>(`
        SELECT
          t.raw,
          ${taskOrderExpression} AS "orderTimestamp"
        FROM tasks t
        LEFT JOIN agents a ON a.id = t.agent_id
        LEFT JOIN runtimes r ON r.id = a.runtime_id
        LEFT JOIN devices d ON d.id = t.device_id
        ${clause}
        ORDER BY ${taskOrderExpression} DESC, t.id DESC
        LIMIT $${values.length + 1}
      `, [...values, limit + 1]);
      const visibleRows = result.rows.slice(0, limit);
      const nextCursor = result.rows.length > limit
        ? encodeTaskCursor(visibleRows[visibleRows.length - 1])
        : undefined;
      const tasks = createDeviceStateSnapshot({
        collectedAt: new Date().toISOString(),
        device: { id: "query", hostname: "query", os: "unknown" },
        runtimes: [],
        agents: [],
        tasks: visibleRows.map((row) => row.raw),
      }).tasks;
      return {
        facets: await facetsPromise,
        items: tasks,
        nextCursor,
        summary: await summaryPromise,
        total: Number(countResult.rows[0]?.count ?? 0),
      };
    },
    async upsertAgentSkillProbeSnapshot(snapshot) {
      const normalized = normalizeAgentSkillProbeSnapshot(snapshot);
      if (!normalized) throw new Error("invalid agent skill probe snapshot");
      await pool.query(`
        INSERT INTO agent_skill_probe_snapshots (
          id,
          device_id,
          runtime_id,
          agent_id,
          status,
          observed_at,
          probed_at,
          error_summary,
          raw,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET
          device_id = excluded.device_id,
          runtime_id = excluded.runtime_id,
          agent_id = excluded.agent_id,
          status = excluded.status,
          observed_at = excluded.observed_at,
          probed_at = excluded.probed_at,
          error_summary = excluded.error_summary,
          raw = excluded.raw,
          updated_at = now()
      `, [
        agentSkillProbeSnapshotId(normalized.targetAgentId),
        normalized.deviceId,
        normalized.runtimeId,
        normalized.targetAgentId,
        normalized.status,
        normalized.observedAt ?? null,
        normalized.probedAt ?? null,
        normalized.errorSummary ?? null,
        JSON.stringify(normalized),
      ]);
      return normalized;
    },
    async readAgentSkillProbeSnapshot(agentId, scope = {}) {
      const organizationId = normalizeOrganizationId(scope.organizationId);
      const result = await pool.query<{ raw: unknown }>(`
        SELECT s.raw
        FROM agent_skill_probe_snapshots s
        LEFT JOIN devices d ON d.id = s.device_id
        WHERE s.agent_id = $1
          AND ($2::text IS NULL OR d.organization_id = $2)
        LIMIT 1
      `, [agentId, organizationId]);
      return normalizeAgentSkillProbeSnapshot(result.rows[0]?.raw);
    },
    listCollectorIngestions,
    async readDeviceCollectionHealth(deviceId, scope = {}) {
      return deriveDeviceCollectionHealth(deviceId, toCollectionHealthIngestions(await listCollectorIngestions(deviceId, scope)));
    },
    close() {
      return pool.end();
    },
  };
}

function normalizeOrganizationId(value?: string | null): string | null {
  return value?.trim() || null;
}

async function assertDeviceOrganizationWritable(
  client: pg.PoolClient,
  deviceId: string,
  organizationId: string | null,
): Promise<void> {
  if (!organizationId) return;
  const result = await client.query<{ organization_id: string | null }>(
    "SELECT organization_id FROM devices WHERE id = $1 LIMIT 1",
    [deviceId],
  );
  const existingOrganizationId = result.rows[0]?.organization_id;
  if (existingOrganizationId && existingOrganizationId !== organizationId) {
    throw new Error("device belongs to another organization");
  }
}

async function assertDeviceBelongsToOrganization(
  client: pg.PoolClient,
  deviceId: string,
  organizationId: string | null,
): Promise<void> {
  if (!organizationId) return;
  const result = await client.query<{ organization_id: string | null }>(
    "SELECT organization_id FROM devices WHERE id = $1 LIMIT 1",
    [deviceId],
  );
  const existingOrganizationId = result.rows[0]?.organization_id;
  if (existingOrganizationId !== organizationId) {
    throw new Error("device does not belong to organization");
  }
}

async function upsertDeviceStateDevice(
  client: pg.PoolClient,
  snapshot: DeviceStateSnapshot,
  organizationId: string | null,
): Promise<void> {
  await client.query(`
    INSERT INTO devices (
      id, organization_id, hostname, os, architecture, collection_status, collector, last_seen_at, collected_at, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      organization_id = coalesce(devices.organization_id, excluded.organization_id),
      hostname = excluded.hostname,
      os = excluded.os,
      architecture = excluded.architecture,
      collection_status = excluded.collection_status,
      collector = excluded.collector,
      last_seen_at = excluded.last_seen_at,
      collected_at = excluded.collected_at,
      raw = excluded.raw,
      updated_at = now()
  `, [
    snapshot.device.id,
    organizationId,
    snapshot.device.hostname,
    snapshot.device.os,
    snapshot.device.architecture ?? null,
    snapshot.device.collectionStatus,
    toJson(snapshot.device.collector ?? {}),
    toDate(snapshot.device.lastSeenAt),
    toDate(snapshot.collectedAt),
    toJson(snapshot.device),
  ]);
}

async function upsertDeviceStateRuntime(client: pg.PoolClient, runtime: Runtime): Promise<void> {
  await client.query(`
    INSERT INTO runtimes (
      id, device_id, kind, name, collection_status, version, diagnostics, last_seen_at, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      device_id = excluded.device_id,
      kind = excluded.kind,
      name = excluded.name,
      collection_status = excluded.collection_status,
      version = excluded.version,
      diagnostics = excluded.diagnostics,
      last_seen_at = excluded.last_seen_at,
      raw = excluded.raw,
      updated_at = now()
  `, [
    runtime.id,
    runtime.deviceId,
    runtime.kind,
    runtime.name,
    runtime.collectionStatus,
    runtime.version ?? null,
    toJson(runtime.diagnostics ?? {}),
    toDate(runtime.lastSeenAt),
    toJson(runtime),
  ]);
}

async function upsertDeviceStateAgent(client: pg.PoolClient, agent: Agent): Promise<void> {
  await client.query(`
    INSERT INTO agents (
      id, runtime_id, name, collection_status, diagnostics, last_seen_at, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      runtime_id = excluded.runtime_id,
      name = excluded.name,
      collection_status = excluded.collection_status,
      diagnostics = excluded.diagnostics,
      last_seen_at = excluded.last_seen_at,
      raw = excluded.raw,
      updated_at = now()
  `, [
    agent.id,
    agent.runtimeId,
    agent.name,
    agent.collectionStatus,
    toJson(agent.diagnostics ?? {}),
    toDate(agent.lastSeenAt),
    toJson(agent),
  ]);
}

async function markAgentsMissingFromPresentRuntimesInvisible(
  client: pg.PoolClient,
  snapshot: DeviceStateSnapshot,
): Promise<void> {
  const runtimeIds = [...new Set(snapshot.runtimes.map((runtime) => runtime.id).filter(Boolean))];
  if (runtimeIds.length === 0) return;
  const agentIds = [...new Set(snapshot.agents.map((agent) => agent.id).filter(Boolean))];
  await client.query(`
    UPDATE agents
    SET collection_status = 'invisible',
        raw = jsonb_set(raw, '{collectionStatus}', '"invisible"'::jsonb, true),
        updated_at = now()
    WHERE runtime_id = ANY($1::text[])
      AND NOT (id = ANY($2::text[]))
      AND collection_status <> 'invisible'
  `, [runtimeIds, agentIds]);
}

async function upsertTask(client: pg.PoolClient, deviceId: string, task: Task, syncHash: string): Promise<void> {
  await client.query(`
    INSERT INTO tasks (
      id, device_id, agent_id, task_type, user_message, agent_reply, status, channel, conversation,
      creator, assignee, error, created_source_at, updated_source_at, sync_hash, stale_at, raw, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
      $10::jsonb, $11::jsonb, $12, $13, $14, $15, NULL, $16::jsonb, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      device_id = excluded.device_id,
      agent_id = excluded.agent_id,
      task_type = excluded.task_type,
      user_message = excluded.user_message,
      agent_reply = excluded.agent_reply,
      status = excluded.status,
      channel = excluded.channel,
      conversation = excluded.conversation,
      creator = excluded.creator,
      assignee = excluded.assignee,
      error = excluded.error,
      created_source_at = excluded.created_source_at,
      updated_source_at = excluded.updated_source_at,
      sync_hash = excluded.sync_hash,
      stale_at = NULL,
      raw = excluded.raw,
      updated_at = now()
  `, [
    task.id,
    deviceId,
    task.agentId,
    task.taskType,
    task.userMessage ?? null,
    task.agentReply ?? null,
    task.status,
    toJson(task.channel ?? {}),
    toJson(task.conversation ?? {}),
    toJsonOrNull(task.creator),
    toJsonOrNull(task.assignee),
    task.error ?? null,
    toDate(task.createdAt),
    toDate(task.updatedAt),
    syncHash,
    toJson(task),
  ]);
}

async function markTasksStale(
  client: pg.PoolClient,
  deviceId: string,
  taskIds: string[],
  staleAt: string,
): Promise<Array<{ id: string }>> {
  const ids = [...new Set(taskIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  await client.query(`
    UPDATE tasks
    SET stale_at = $3,
        updated_at = now()
    WHERE device_id = $1
      AND id = ANY($2::text[])
  `, [deviceId, ids, toDate(staleAt)]);
  return ids.map((id) => ({ id }));
}

function toCollectionHealthIngestions(rows: PostgresCollectorIngestion[]): CollectionHealthIngestion[] {
  return rows
    .filter((row) => row.snapshotType === "device_state")
    .map((row) => ({
      ...row,
      snapshotType: row.snapshotType as CollectionHealthIngestion["snapshotType"],
    }));
}

async function insertCollectorIngestion(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  input: {
    deviceId: string;
    snapshotType: CollectorSnapshotType;
    status: "succeeded" | "failed";
    collectedAt: string;
    organizationId?: string | null;
    counts: Record<string, number>;
    diagnostics: CollectionDiagnosticItem[];
    error: string | null;
  },
): Promise<void> {
  await client.query(`
    INSERT INTO collector_ingestions (device_id, organization_id, snapshot_type, status, collected_at, counts, diagnostics, error)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
  `, [
    input.deviceId,
    normalizeOrganizationId(input.organizationId),
    input.snapshotType,
    input.status,
    toDate(input.collectedAt),
    toJson(input.counts),
    toJson(input.diagnostics),
    input.error,
  ]);
}

async function countTable(client: pg.PoolClient, table: string): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

function buildRuntimeFleetTaskSummary(rows: PostgresRuntimeFleetTaskSummaryRow[]): {
  taskCount: number;
  taskSummary: RuntimeFleetTaskSummary;
} {
  const taskSummary = createEmptyRuntimeFleetTaskSummary();
  let taskCount = 0;

  for (const row of rows) {
    if (!isTaskStatus(row.status)) continue;
    const count = Number(row.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    taskCount += count;
    addTaskStatusCount(taskSummary.byAgentId, row.agentId, row.status, count);
    if (row.runtimeId) addTaskStatusCount(taskSummary.byRuntimeId, row.runtimeId, row.status, count);
    if (row.deviceId) addTaskStatusCount(taskSummary.byDeviceId, row.deviceId, row.status, count);
    recordLatestActivity(taskSummary.lastActiveAtByAgentId, row.agentId, row.lastActiveAt);
    if (row.runtimeId) recordLatestActivity(taskSummary.lastActiveAtByRuntimeId, row.runtimeId, row.lastActiveAt);
    if (row.deviceId) recordLatestActivity(taskSummary.lastActiveAtByDeviceId, row.deviceId, row.lastActiveAt);
  }

  return { taskCount, taskSummary };
}

function recordLatestActivity(
  target: Record<string, string> | undefined,
  id: string | null | undefined,
  value: Date | string | null | undefined,
): void {
  if (!target || !id || !value) return;
  const timestamp = value instanceof Date ? value : new Date(value);
  const epoch = timestamp.getTime();
  if (Number.isNaN(epoch)) return;
  const nextValue = timestamp.toISOString();
  const previousEpoch = Date.parse(target[id] ?? "");
  if (Number.isNaN(previousEpoch) || epoch > previousEpoch) {
    target[id] = nextValue;
  }
}

async function readTaskStatusSummary(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  filters: PostgresRuntimeTaskFilters,
): Promise<PostgresRuntimeTaskResult["summary"]> {
  const { clause, values } = createTaskWhereClause({
    ...filters,
    cursor: null,
    status: null,
  });
  const result = await client.query<PostgresTaskStatusSummaryRow>(`
    SELECT t.status, count(*)::text AS count
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN runtimes r ON r.id = a.runtime_id
    LEFT JOIN devices d ON d.id = t.device_id
    ${clause}
    GROUP BY t.status
  `, values);
  const byStatus = createEmptyTaskStatusCounts();
  for (const row of result.rows) {
    if (!isTaskStatus(row.status)) continue;
    const count = Number(row.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    byStatus[row.status] += count;
    byStatus.total += count;
  }
  return {
    byStatus,
    total: byStatus.total,
  };
}

async function readTaskFacets(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  filters: PostgresRuntimeTaskFilters,
): Promise<PostgresRuntimeTaskResult["facets"]> {
  const { clause, values } = createTaskWhereClause({
    ...filters,
    channelKind: null,
    channelKinds: null,
    cursor: null,
  });
  const result = await client.query<PostgresTaskChannelFacetRow>(`
    SELECT t.channel->>'kind' AS kind, count(*)::text AS count
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN runtimes r ON r.id = a.runtime_id
    LEFT JOIN devices d ON d.id = t.device_id
    ${addSqlCondition(clause, "t.channel->>'kind' IS NOT NULL")}
    GROUP BY t.channel->>'kind'
    ORDER BY kind
  `, values);
  return {
    channels: result.rows
      .filter((row): row is PostgresTaskChannelFacetRow & { kind: TaskChannelKind } => isTaskChannelKind(row.kind))
      .map((row) => ({
        count: Number(row.count),
        kind: row.kind,
        label: TASK_CHANNEL_KIND_LABELS[row.kind],
      })),
  };
}

function addTaskStatusCount(
  summary: RuntimeFleetTaskSummary["byAgentId"],
  id: string,
  status: TaskStatus,
  count: number,
): void {
  if (!id) return;
  const existing = summary[id] ?? createEmptyTaskStatusCounts();
  existing[status] += count;
  existing.total += count;
  summary[id] = existing;
}

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

function isTaskChannelKind(value: string): value is TaskChannelKind {
  return value === "dingtalk" || value === "webchat" || value === "slock";
}

function addSqlCondition(clause: string, condition: string): string {
  return clause ? `${clause} AND ${condition}` : `WHERE ${condition}`;
}

async function withTransaction<T>(
  pool: InstanceType<typeof Pool>,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createTaskWhereClause(filters: PostgresRuntimeTaskFilters): {
  clause: string;
  values: unknown[];
} {
  const conditions: string[] = ["t.stale_at IS NULL"];
  const values: unknown[] = [];

  addTextFilter(conditions, values, "d.organization_id", normalizeOrganizationId(filters.organizationId));
  addTextFilter(conditions, values, "t.status", filters.status);
  addTextFilter(conditions, values, "t.task_type", filters.taskType);
  const channelKinds = normalizeChannelKindFilters(filters);
  if (channelKinds.length) {
    values.push(channelKinds);
    conditions.push(`t.channel->>'kind' = ANY($${values.length}::text[])`);
  } else {
    addTextFilter(conditions, values, "t.channel->>'kind'", filters.channelKind);
  }
  if (filters.statusScope === "board-visible") {
    values.push([...RUNTIME_TASK_BOARD_VISIBLE_STATUSES]);
    conditions.push(`t.status = ANY($${values.length}::text[])`);
  }

  const cursor = decodeTaskCursor(filters.cursor);
  if (cursor) {
    values.push(toDate(cursor.orderTimestamp), cursor.id);
    conditions.push(`(
      ${taskOrderExpression} < $${values.length - 1}
      OR (${taskOrderExpression} = $${values.length - 1} AND t.id < $${values.length})
    )`);
  }

  if (filters.startAt) {
    values.push(toDate(filters.startAt));
    conditions.push(`${taskOrderExpression} >= $${values.length}`);
  }
  if (filters.endAt) {
    values.push(toDate(filters.endAt));
    conditions.push(`${taskOrderExpression} <= $${values.length}`);
  }
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    conditions.push(`(
      coalesce(t.user_message, '') ILIKE $${values.length}
      OR coalesce(t.agent_reply, '') ILIKE $${values.length}
      OR coalesce(t.channel->>'kind', '') ILIKE $${values.length}
      OR coalesce(t.conversation->>'title', '') ILIKE $${values.length}
      OR coalesce(t.creator->>'name', '') ILIKE $${values.length}
      OR coalesce(t.assignee->>'name', '') ILIKE $${values.length}
      OR coalesce(t.agent_id, '') ILIKE $${values.length}
      OR coalesce(a.name, '') ILIKE $${values.length}
      OR coalesce(r.name, '') ILIKE $${values.length}
    )`);
  }

  return {
    clause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

function normalizeChannelKindFilters(filters: PostgresRuntimeTaskFilters): string[] {
  return Array.from(new Set((filters.channelKinds ?? [])
    .concat(filters.channelKind ? [filters.channelKind] : [])
    .map((value) => value.trim())
    .filter(Boolean)));
}

function encodeTaskCursor(row: PostgresTaskQueryRow | undefined): string | undefined {
  if (!row?.orderTimestamp || !row.raw.id) return undefined;
  return Buffer.from(JSON.stringify({
    id: row.raw.id,
    orderTimestamp: row.orderTimestamp.toISOString(),
  })).toString("base64url");
}

function decodeTaskCursor(value: string | null | undefined): { id: string; orderTimestamp: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.id !== "string" || typeof parsed.orderTimestamp !== "string") return null;
    if (!toDate(parsed.orderTimestamp)) return null;
    return { id: parsed.id, orderTimestamp: parsed.orderTimestamp };
  } catch {
    return null;
  }
}

function addTextFilter(
  conditions: string[],
  values: unknown[],
  column: string,
  value: string | null | undefined,
): void {
  if (!value || value === "all") return;
  values.push(value);
  conditions.push(`${column} = $${values.length}`);
}

function agentSkillProbeSnapshotId(agentId: string): string {
  return `agent-skill-probe:${agentId}`;
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function toJsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
