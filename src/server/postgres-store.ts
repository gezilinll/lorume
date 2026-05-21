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
import { createDeviceStateSnapshot, type Agent, type Device, type DeviceStateSnapshot, type Runtime, type Task } from "../runtime/runtime-model";

const { Pool } = pg;

type CollectorSnapshotType = "device_state";

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
  observedAt: string | Date | null;
  receivedAt: string | Date;
  counts: Record<string, number>;
  warnings: string[];
  error?: string | null;
}

const taskOrderExpression = "coalesce(t.last_seen_at, t.updated_source_at, t.created_source_at, t.updated_at, t.created_at)";

interface PostgresTaskQueryRow {
  raw: Task;
  orderTimestamp: Date | null;
}

/** Backend query result for Runtime Fleet. */
export interface PostgresRuntimeFleetResult {
  observedAt: string | null;
  devices: Device[];
  runtimes: Runtime[];
  agents: Agent[];
  tasks: Task[];
  summary: {
    deviceCount: number;
    runtimeCount: number;
    agentCount: number;
    taskCount: number;
  };
}

/** Backend query filters for unified Task rows. */
export interface PostgresRuntimeTaskFilters {
  taskType?: string | null;
  status?: string | null;
  channelKind?: string | null;
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
}

/** Postgres-backed repository for the current Device / Runtime / Agent / Task model. */
export interface PostgresStore {
  /** Upsert a unified Device / Runtime / Agent / Task snapshot. */
  upsertDeviceStateSnapshot: (snapshot: DeviceStateSnapshot) => Promise<PostgresIngestionResult>;
  /** Record a failed collector ingestion when a report cannot be persisted as a valid snapshot. */
  recordFailedCollectorIngestion: (input: PostgresFailedCollectorIngestionInput) => Promise<void>;
  /** Verify the repository can serve backend traffic. */
  checkReady: () => Promise<void>;
  /** Read coarse entity counts for harnesses and smoke diagnostics. */
  readEntityCounts: () => Promise<PostgresEntityCounts>;
  /** Read current Runtime Fleet records from Postgres. */
  readRuntimeFleet: () => Promise<PostgresRuntimeFleetResult>;
  /** Query unified product Task rows from Postgres. */
  listRuntimeTasks: (filters?: PostgresRuntimeTaskFilters) => Promise<PostgresRuntimeTaskResult>;
  /** Upsert the latest read-only Agent Skill probe snapshot. */
  upsertAgentSkillProbeSnapshot: (snapshot: AgentSkillProbeSnapshot) => Promise<AgentSkillProbeSnapshot>;
  /** Read the latest read-only Agent Skill probe snapshot for one Agent. */
  readAgentSkillProbeSnapshot: (agentId: string) => Promise<AgentSkillProbeSnapshot | null>;
  /** List collector ingestion metadata for a device. */
  listCollectorIngestions: (deviceId: string) => Promise<PostgresCollectorIngestion[]>;
  /** Read product-level collection health for one device. */
  readDeviceCollectionHealth: (deviceId: string) => Promise<DeviceCollectionHealth>;
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
  observedAt?: string;
  /** Warning strings extracted before failure. */
  warnings?: string[];
  /** Short error summary safe for diagnostics. */
  error: string;
}

/** Create a Postgres repository using Lorume's normalized snapshot semantics. */
export function createPostgresStore(options: PostgresStoreOptions = {}): PostgresStore {
  const pool = new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL ?? "postgres://lorume:lorume@127.0.0.1:54329/lorume",
  });

  async function listCollectorIngestions(deviceId: string): Promise<PostgresCollectorIngestion[]> {
    const result = await pool.query<PostgresCollectorIngestion>(`
      SELECT
        device_id AS "deviceId",
        snapshot_type AS "snapshotType",
        status,
        observed_at AS "observedAt",
        received_at AS "receivedAt",
        counts,
        warnings,
        error
      FROM collector_ingestions
      WHERE device_id = $1
      ORDER BY id DESC
    `, [deviceId]);
    return result.rows;
  }

  return {
    upsertDeviceStateSnapshot(snapshot) {
      return withTransaction(pool, async (client) => {
        await upsertDeviceStateDevice(client, snapshot);
        for (const runtime of snapshot.runtimes) await upsertDeviceStateRuntime(client, runtime);
        for (const agent of snapshot.agents) {
          await upsertDeviceStateAgent(client, agent);
        }
        await deleteExistingTasksForDevice(client, snapshot.device.id);
        for (const task of snapshot.tasks) await upsertTask(client, snapshot.device.id, task);
        await deleteStaleRuntimeObjects(client, snapshot);

        const counts = {
          agents: snapshot.agents.length,
          devices: 1,
          runtimes: snapshot.runtimes.length,
          tasks: snapshot.tasks.length,
        };
        await insertCollectorIngestion(client, {
          counts,
          deviceId: snapshot.device.id,
          error: null,
          observedAt: snapshot.observedAt,
          snapshotType: "device_state",
          status: "succeeded",
          warnings: snapshot.diagnostics?.warnings ?? [],
        });
        return { deviceId: snapshot.device.id, snapshotType: "device_state", counts };
      });
    },
    async recordFailedCollectorIngestion(input) {
      await insertCollectorIngestion(pool, {
        counts: {},
        deviceId: input.deviceId || "unknown",
        error: input.error,
        observedAt: input.observedAt ?? new Date().toISOString(),
        snapshotType: input.snapshotType,
        status: "failed",
        warnings: input.warnings ?? [],
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
    async readRuntimeFleet() {
      const [deviceResult, runtimeResult, agentResult, taskResult] = await Promise.all([
        pool.query<{ collector: Device["collector"]; raw: Device; observed_at: Date | null }>(
          "SELECT collector, raw, observed_at FROM devices ORDER BY hostname, id",
        ),
        pool.query<{ raw: Runtime }>("SELECT raw FROM runtimes ORDER BY name"),
        pool.query<{ raw: Agent }>("SELECT raw FROM agents ORDER BY name"),
        pool.query<{ raw: Task }>("SELECT raw FROM tasks ORDER BY coalesce(last_seen_at, updated_source_at, created_source_at, updated_at, created_at) DESC, id DESC"),
      ]);
      const observedAt = deviceResult.rows
        .map((row) => row.observed_at?.toISOString() ?? null)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
      const sanitized = createDeviceStateSnapshot({
        observedAt: observedAt ?? new Date().toISOString(),
        device: deviceResult.rows[0]?.raw ?? { id: "backend", hostname: "backend", os: "unknown" },
        runtimes: runtimeResult.rows.map((row) => row.raw),
        agents: agentResult.rows.map((row) => row.raw),
        tasks: taskResult.rows.map((row) => row.raw),
      });
      const devices = deviceResult.rows.map((row) => createDeviceStateSnapshot({
        observedAt: observedAt ?? new Date().toISOString(),
        device: { ...row.raw, collector: row.collector },
        runtimes: [],
        agents: [],
        tasks: [],
      }).device);
      const runtimes = sanitized.runtimes;
      const agents = sanitized.agents;
      const tasks = sanitized.tasks;

      return {
        observedAt,
        devices,
        runtimes,
        agents,
        tasks,
        summary: {
          agentCount: agents.length,
          deviceCount: devices.length,
          runtimeCount: runtimes.length,
          taskCount: tasks.length,
        },
      };
    },
    async listRuntimeTasks(filters = {}) {
      const { clause, values } = createTaskWhereClause(filters);
      const countResult = await pool.query<{ count: string }>(
        `SELECT count(*) AS count
        FROM tasks t
        LEFT JOIN agents a ON a.id = t.agent_id
        LEFT JOIN runtimes r ON r.id = a.runtime_id
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
        ${clause}
        ORDER BY ${taskOrderExpression} DESC, t.id DESC
        LIMIT $${values.length + 1}
      `, [...values, limit + 1]);
      const visibleRows = result.rows.slice(0, limit);
      const nextCursor = result.rows.length > limit
        ? encodeTaskCursor(visibleRows[visibleRows.length - 1])
        : undefined;
      const tasks = createDeviceStateSnapshot({
        observedAt: new Date().toISOString(),
        device: { id: "query", hostname: "query", os: "unknown" },
        runtimes: [],
        agents: [],
        tasks: visibleRows.map((row) => row.raw),
      }).tasks;
      return {
        items: tasks,
        nextCursor,
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
    async readAgentSkillProbeSnapshot(agentId) {
      const result = await pool.query<{ raw: unknown }>(`
        SELECT raw
        FROM agent_skill_probe_snapshots
        WHERE agent_id = $1
        LIMIT 1
      `, [agentId]);
      return normalizeAgentSkillProbeSnapshot(result.rows[0]?.raw);
    },
    listCollectorIngestions,
    async readDeviceCollectionHealth(deviceId) {
      return deriveDeviceCollectionHealth(deviceId, toCollectionHealthIngestions(await listCollectorIngestions(deviceId)));
    },
    close() {
      return pool.end();
    },
  };
}

async function upsertDeviceStateDevice(client: pg.PoolClient, snapshot: DeviceStateSnapshot): Promise<void> {
  await client.query(`
    INSERT INTO devices (
      id, hostname, os, architecture, collection_status, collector, last_seen_at, observed_at, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      hostname = excluded.hostname,
      os = excluded.os,
      architecture = excluded.architecture,
      collection_status = excluded.collection_status,
      collector = excluded.collector,
      last_seen_at = excluded.last_seen_at,
      observed_at = excluded.observed_at,
      raw = excluded.raw,
      updated_at = now()
  `, [
    snapshot.device.id,
    snapshot.device.hostname,
    snapshot.device.os,
    snapshot.device.architecture ?? null,
    snapshot.device.collectionStatus,
    toJson(snapshot.device.collector ?? {}),
    toDate(snapshot.device.lastSeenAt),
    toDate(snapshot.observedAt),
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

async function deleteStaleRuntimeObjects(
  client: pg.PoolClient,
  snapshot: { device: { id: string }; runtimes: Array<{ id: string }>; agents: Array<{ id: string }> },
): Promise<void> {
  const runtimeIds = snapshot.runtimes.map((runtime) => runtime.id);
  const agentIds = snapshot.agents.map((agent) => agent.id);
  await client.query(`
    DELETE FROM agents
    WHERE runtime_id IN (SELECT id FROM runtimes WHERE device_id = $1)
      AND NOT (id = ANY($2::text[]))
  `, [snapshot.device.id, agentIds]);
  await client.query(`
    DELETE FROM runtimes
    WHERE device_id = $1
      AND NOT (id = ANY($2::text[]))
  `, [snapshot.device.id, runtimeIds]);
}

async function deleteExistingTasksForDevice(client: pg.PoolClient, deviceId: string): Promise<void> {
  await client.query("DELETE FROM tasks WHERE device_id = $1", [deviceId]);
}
async function upsertTask(client: pg.PoolClient, deviceId: string, task: Task): Promise<void> {
  await client.query(`
    INSERT INTO tasks (
      id, device_id, agent_id, task_type, title, description, status, source_external_id, channel, conversation,
      creator, assignee, error, created_source_at, updated_source_at, last_seen_at, raw, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
      $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17::jsonb, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      device_id = excluded.device_id,
      agent_id = excluded.agent_id,
      task_type = excluded.task_type,
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      source_external_id = excluded.source_external_id,
      channel = excluded.channel,
      conversation = excluded.conversation,
      creator = excluded.creator,
      assignee = excluded.assignee,
      error = excluded.error,
      created_source_at = excluded.created_source_at,
      updated_source_at = excluded.updated_source_at,
      last_seen_at = excluded.last_seen_at,
      raw = excluded.raw,
      updated_at = now()
  `, [
    task.id,
    deviceId,
    task.agentId,
    task.taskType,
    task.title,
    task.description ?? null,
    task.status,
    task.source?.externalId ?? null,
    toJson(task.channel ?? {}),
    toJson(task.conversation ?? {}),
    toJsonOrNull(task.creator),
    toJsonOrNull(task.assignee),
    task.error ?? null,
    toDate(task.createdAt),
    toDate(task.updatedAt),
    toDate(task.lastSeenAt),
    toJson(task),
  ]);
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
    observedAt: string;
    counts: Record<string, number>;
    warnings: string[];
    error: string | null;
  },
): Promise<void> {
  await client.query(`
    INSERT INTO collector_ingestions (device_id, snapshot_type, status, observed_at, counts, warnings, error)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
  `, [
    input.deviceId,
    input.snapshotType,
    input.status,
    toDate(input.observedAt),
    toJson(input.counts),
    toJson(input.warnings),
    input.error,
  ]);
}

async function countTable(client: pg.PoolClient, table: string): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
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
  const conditions: string[] = [];
  const values: unknown[] = [];

  addTextFilter(conditions, values, "t.status", filters.status);
  addTextFilter(conditions, values, "t.task_type", filters.taskType);
  addTextFilter(conditions, values, "t.channel->>'kind'", filters.channelKind);

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
      t.title ILIKE $${values.length}
      OR coalesce(t.description, '') ILIKE $${values.length}
      OR coalesce(t.source_external_id, '') ILIKE $${values.length}
      OR coalesce(t.channel->>'kind', '') ILIKE $${values.length}
      OR coalesce(t.channel->>'name', '') ILIKE $${values.length}
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
