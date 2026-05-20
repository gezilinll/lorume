import pg from "pg";
import {
  deriveRuntimeWorkStage,
  type RuntimeExecution,
  type RuntimeWorkItem,
  type RuntimeWorkStateSnapshot,
} from "../runtime/runtime-work-state";
import type {
  LorumeRuntime,
  ManagedRuntimeAgent,
  RuntimeDevice,
  RuntimeInventorySnapshot,
} from "../runtime/runtime-normalize";
import {
  deriveDeviceCollectionHealth,
  type DeviceCollectionHealth,
} from "../runtime/runtime-collection-health";
import {
  normalizeAgentSkillProbeSnapshot,
  type AgentSkillProbeSnapshot,
} from "../runtime/agent-skill-probe";

const { Pool } = pg;

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
  snapshotType: "inventory" | "work_state";
  /** Object counts written by this ingestion. */
  counts: Record<string, number>;
}

/** Small table-count summary used by backend harnesses. */
export interface PostgresEntityCounts {
  devices: number;
  runtimes: number;
  agents: number;
  channelBindings: number;
  workItems: number;
  workConversations: number;
  workExecutions: number;
  agentSkillProbeSnapshots: number;
  collectorIngestions: number;
}

/** Query row for one collector ingestion. */
export interface PostgresCollectorIngestion {
  deviceId: string;
  snapshotType: "inventory" | "work_state";
  status: "succeeded" | "failed";
  observedAt: string | Date | null;
  receivedAt: string | Date;
  counts: Record<string, number>;
  warnings: string[];
  error?: string | null;
}

/** Minimal work item row used by repository tests and future query API composition. */
export interface PostgresWorkItemRow {
  id: string;
  externalId: string;
  source: string;
  status: string;
  stage: string;
  title: string;
  description: string | null;
  runtimeId: string | null;
  agentId: string | null;
  conversationId: string | null;
  channelKind: string | null;
  channelLabel: string | null;
  creator: unknown;
  assignee: unknown;
  lastSeenAt: string | null;
}

interface PostgresWorkItemQueryRow extends PostgresWorkItemRow {
  orderTimestamp: Date | null;
}

const workItemOrderExpression = "coalesce(w.last_seen_at, w.updated_source_at, w.created_source_at, w.updated_at, w.created_at)";

/** Backend query result for Runtime Fleet. */
export interface PostgresRuntimeFleetResult {
  observedAt: string | null;
  devices: RuntimeDevice[];
  runtimes: LorumeRuntime[];
  agents: ManagedRuntimeAgent[];
  summary: {
    deviceCount: number;
    runtimeCount: number;
    agentCount: number;
  };
}

/** Backend query filters for work items. */
export interface PostgresRuntimeWorkItemFilters {
  source?: string | null;
  stage?: string | null;
  channelKind?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  search?: string | null;
  limit?: number;
  cursor?: string | null;
}

/** Backend query result for work items. */
export interface PostgresRuntimeWorkItemResult {
  items: PostgresWorkItemRow[];
  total: number;
  nextCursor?: string;
}

/** Postgres-backed repository for normalized runtime inventory and work-state snapshots. */
export interface PostgresStore {
  /** Upsert a normalized inventory snapshot and record collector ingestion metadata. */
  upsertInventorySnapshot: (snapshot: RuntimeInventorySnapshot) => Promise<PostgresIngestionResult>;
  /** Upsert a normalized work-state snapshot and record collector ingestion metadata. */
  upsertWorkStateSnapshot: (snapshot: RuntimeWorkStateSnapshot) => Promise<PostgresIngestionResult>;
  /** Record a failed collector ingestion when a report cannot be persisted as a valid snapshot. */
  recordFailedCollectorIngestion: (input: PostgresFailedCollectorIngestionInput) => Promise<void>;
  /** Verify the repository can serve backend traffic. */
  checkReady: () => Promise<void>;
  /** Read coarse entity counts for harnesses and smoke diagnostics. */
  readEntityCounts: () => Promise<PostgresEntityCounts>;
  /** Count work items by normalized source. */
  countWorkItemsBySource: () => Promise<Record<string, number>>;
  /** Read current Runtime Fleet records from Postgres. */
  readRuntimeFleet: () => Promise<PostgresRuntimeFleetResult>;
  /** Query normalized work items from Postgres. */
  listRuntimeWorkItems: (filters?: PostgresRuntimeWorkItemFilters) => Promise<PostgresRuntimeWorkItemResult>;
  /** Read one stored work item row. */
  readWorkItem: (id: string) => Promise<PostgresWorkItemRow | null>;
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
  snapshotType: "inventory" | "work_state";
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
    upsertInventorySnapshot(snapshot) {
      return withTransaction(pool, async (client) => {
        await upsertDevice(client, snapshot);
        for (const runtime of snapshot.runtimes) await upsertRuntime(client, runtime);
        for (const agent of snapshot.agents) await upsertAgent(client, agent);
        await deleteChannelBindingsForAgents(client, snapshot.agents.map((agent) => agent.id));
        for (const agent of snapshot.agents) {
          for (const [index, binding] of agent.channelBindings.entries()) {
            await upsertChannelBinding(client, agent.id, binding, index);
          }
        }
        await deleteStaleInventoryObjects(client, snapshot);

        const counts = {
          agents: snapshot.agents.length,
          channelBindings: snapshot.agents.reduce((total, agent) => total + agent.channelBindings.length, 0),
          devices: 1,
          runtimes: snapshot.runtimes.length,
        };
        await insertCollectorIngestion(client, {
          counts,
          deviceId: snapshot.device.id,
          error: null,
          observedAt: snapshot.observedAt,
          snapshotType: "inventory",
          status: "succeeded",
          warnings: snapshot.reports.flatMap((report) => report.warnings ?? []),
        });
        return { deviceId: snapshot.device.id, snapshotType: "inventory", counts };
      });
    },
    upsertWorkStateSnapshot(snapshot) {
      return withTransaction(pool, async (client) => {
        await deleteExistingWorkStateForDevice(client, snapshot.deviceId);
        const runtimeIds = await readRuntimeIdsForDevice(client, snapshot.deviceId);
        const agentIds = await readAgentIdsForDevice(client, snapshot.deviceId);
        const workItemIds = new Set(snapshot.workItems.map((workItem) => workItem.id));
        const conversationIds = new Set(snapshot.conversations.map((conversation) => conversation.id));
        let conversations = 0;
        for (const conversation of snapshot.conversations) {
          if (await upsertWorkConversation(client, snapshot.deviceId, conversation, runtimeIds, agentIds)) {
            conversations += 1;
          }
        }
        const latestExecutionsByWorkItemId = createLatestExecutionsByWorkItemId(snapshot.executions);
        let workItems = 0;
        for (const workItem of snapshot.workItems) {
          if (await upsertWorkItem(
            client,
            snapshot.deviceId,
            workItem,
            latestExecutionsByWorkItemId.get(workItem.id),
            conversationIds,
            runtimeIds,
            agentIds,
          )) {
            workItems += 1;
          }
        }
        let executions = 0;
        for (const execution of snapshot.executions) {
          if (await upsertWorkExecution(client, snapshot.deviceId, execution, workItemIds, conversationIds, runtimeIds, agentIds)) {
            executions += 1;
          }
        }

        const counts = {
          conversations,
          executions,
          workItems,
        };
        await insertCollectorIngestion(client, {
          counts,
          deviceId: snapshot.deviceId,
          error: null,
          observedAt: snapshot.observedAt,
          snapshotType: "work_state",
          status: "succeeded",
          warnings: snapshot.warnings ?? [],
        });
        return { deviceId: snapshot.deviceId, snapshotType: "work_state", counts };
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
          channelBindings: await countTable(client, "channel_bindings"),
          collectorIngestions: await countTable(client, "collector_ingestions"),
          agentSkillProbeSnapshots: await countTable(client, "agent_skill_probe_snapshots"),
          devices: await countTable(client, "devices"),
          runtimes: await countTable(client, "runtimes"),
          workConversations: await countTable(client, "work_conversations"),
          workExecutions: await countTable(client, "work_executions"),
          workItems: await countTable(client, "work_items"),
        };
      } finally {
        client.release();
      }
    },
    async countWorkItemsBySource() {
      const result = await pool.query<{ source: string; count: string }>(`
        SELECT source, count(*) AS count
        FROM work_items
        GROUP BY source
        ORDER BY source
      `);
      return Object.fromEntries(result.rows.map((row) => [row.source, Number(row.count)]));
    },
    async readRuntimeFleet() {
      const [deviceResult, runtimeResult, agentResult] = await Promise.all([
        pool.query<{ raw: RuntimeDevice; observed_at: Date | null }>("SELECT raw, observed_at FROM devices ORDER BY hostname, id"),
        pool.query<{ raw: LorumeRuntime }>("SELECT raw FROM runtimes ORDER BY name"),
        pool.query<{ raw: ManagedRuntimeAgent }>("SELECT raw FROM agents ORDER BY name"),
      ]);
      const observedAt = deviceResult.rows
        .map((row) => row.observed_at?.toISOString() ?? null)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
      const devices = deviceResult.rows.map((row) => row.raw);
      const runtimes = runtimeResult.rows.map((row) => row.raw);
      const agents = agentResult.rows.map((row) => row.raw);

      return {
        observedAt,
        devices,
        runtimes,
        agents,
        summary: {
          agentCount: agents.length,
          deviceCount: devices.length,
          runtimeCount: runtimes.length,
        },
      };
    },
    async listRuntimeWorkItems(filters = {}) {
      const { clause, values } = createWorkItemWhereClause(filters);
      const countResult = await pool.query<{ count: string }>(
        `SELECT count(*) AS count
        FROM work_items w
        LEFT JOIN runtimes r ON r.id = w.runtime_id
        LEFT JOIN agents a ON a.id = w.agent_id
        LEFT JOIN work_conversations c ON c.id = w.conversation_id
        ${clause}`,
        values,
      );
      const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
      const result = await pool.query<PostgresWorkItemQueryRow>(`
        SELECT
          w.id,
          w.external_id AS "externalId",
          w.source,
          w.status,
          w.stage,
          w.title,
          w.description,
          w.runtime_id AS "runtimeId",
          w.agent_id AS "agentId",
          w.conversation_id AS "conversationId",
          w.channel_kind AS "channelKind",
          w.channel_label AS "channelLabel",
          w.creator,
          w.assignee,
          w.last_seen_at AS "lastSeenAt",
          ${workItemOrderExpression} AS "orderTimestamp"
        FROM work_items w
        LEFT JOIN runtimes r ON r.id = w.runtime_id
        LEFT JOIN agents a ON a.id = w.agent_id
        LEFT JOIN work_conversations c ON c.id = w.conversation_id
        ${clause}
        ORDER BY ${workItemOrderExpression} DESC, w.id DESC
        LIMIT $${values.length + 1}
      `, [...values, limit + 1]);
      const visibleRows = result.rows.slice(0, limit);
      const nextCursor = result.rows.length > limit
        ? encodeWorkItemCursor(visibleRows[visibleRows.length - 1])
        : undefined;
      return {
        items: visibleRows.map(stripWorkItemOrderTimestamp),
        nextCursor,
        total: Number(countResult.rows[0]?.count ?? 0),
      };
    },
    async readWorkItem(id) {
      const result = await pool.query<PostgresWorkItemRow>(`
        SELECT
          id,
          external_id AS "externalId",
          source,
          status,
          stage,
          title,
          description,
          runtime_id AS "runtimeId",
          agent_id AS "agentId",
          conversation_id AS "conversationId",
          channel_kind AS "channelKind",
          channel_label AS "channelLabel",
          creator,
          assignee,
          last_seen_at AS "lastSeenAt"
        FROM work_items
        WHERE id = $1
      `, [id]);
      return result.rows[0] ?? null;
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
          operation_id,
          command_id,
          error_summary,
          raw,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET
          device_id = excluded.device_id,
          runtime_id = excluded.runtime_id,
          agent_id = excluded.agent_id,
          status = excluded.status,
          observed_at = excluded.observed_at,
          probed_at = excluded.probed_at,
          operation_id = excluded.operation_id,
          command_id = excluded.command_id,
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
        normalized.operationId ?? null,
        normalized.commandId ?? null,
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
      return deriveDeviceCollectionHealth(deviceId, await listCollectorIngestions(deviceId));
    },
    close() {
      return pool.end();
    },
  };
}

async function upsertDevice(client: pg.PoolClient, snapshot: RuntimeInventorySnapshot): Promise<void> {
  await client.query(`
    INSERT INTO devices (
      id, hostname, os, architecture, collector, last_seen_at, observed_at, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      hostname = excluded.hostname,
      os = excluded.os,
      architecture = excluded.architecture,
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
    toJson(snapshot.collector),
    toDate(snapshot.device.lastSeenAt),
    toDate(snapshot.observedAt),
    toJson(snapshot.device),
  ]);
}

async function upsertRuntime(client: pg.PoolClient, runtime: RuntimeInventorySnapshot["runtimes"][number]): Promise<void> {
  await client.query(`
    INSERT INTO runtimes (
      id, device_id, kind, name, status, version, endpoint, capabilities, health, last_seen_at, source_refs, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      device_id = excluded.device_id,
      kind = excluded.kind,
      name = excluded.name,
      status = excluded.status,
      version = excluded.version,
      endpoint = excluded.endpoint,
      capabilities = excluded.capabilities,
      health = excluded.health,
      last_seen_at = excluded.last_seen_at,
      source_refs = excluded.source_refs,
      raw = excluded.raw,
      updated_at = now()
  `, [
    runtime.id,
    runtime.deviceId,
    runtime.kind,
    runtime.name,
    runtime.status,
    runtime.version ?? null,
    runtime.endpoint ?? null,
    toJson(runtime.capabilities),
    toJson(runtime.health ?? {}),
    toDate(runtime.lastSeenAt),
    toJson(runtime.sourceRefs),
    toJson(runtime),
  ]);
}

async function upsertAgent(client: pg.PoolClient, agent: RuntimeInventorySnapshot["agents"][number]): Promise<void> {
  await client.query(`
    INSERT INTO agents (
      id, runtime_id, name, origin, status, load, last_seen_at, source_refs, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      runtime_id = excluded.runtime_id,
      name = excluded.name,
      origin = excluded.origin,
      status = excluded.status,
      load = excluded.load,
      last_seen_at = excluded.last_seen_at,
      source_refs = excluded.source_refs,
      raw = excluded.raw,
      updated_at = now()
  `, [
    agent.id,
    agent.runtimeId,
    agent.name,
    agent.origin,
    agent.status,
    toJson(agent.load ?? {}),
    toDate(agent.lastSeenAt),
    toJson(agent.sourceRefs),
    toJson(agent),
  ]);
}

async function deleteChannelBindingsForAgents(client: pg.PoolClient, agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  await client.query("DELETE FROM channel_bindings WHERE agent_id = ANY($1::text[])", [agentIds]);
}

async function deleteStaleInventoryObjects(client: pg.PoolClient, snapshot: RuntimeInventorySnapshot): Promise<void> {
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

async function deleteExistingWorkStateForDevice(client: pg.PoolClient, deviceId: string): Promise<void> {
  await client.query("DELETE FROM work_executions WHERE device_id = $1", [deviceId]);
  await client.query("DELETE FROM work_items WHERE device_id = $1", [deviceId]);
  await client.query("DELETE FROM work_conversations WHERE device_id = $1", [deviceId]);
}

async function readRuntimeIdsForDevice(client: pg.PoolClient, deviceId: string): Promise<Set<string>> {
  const result = await client.query<{ id: string }>("SELECT id FROM runtimes WHERE device_id = $1", [deviceId]);
  return new Set(result.rows.map((row) => row.id));
}

async function readAgentIdsForDevice(client: pg.PoolClient, deviceId: string): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(`
    SELECT a.id
    FROM agents a
    INNER JOIN runtimes r ON r.id = a.runtime_id
    WHERE r.device_id = $1
  `, [deviceId]);
  return new Set(result.rows.map((row) => row.id));
}

async function upsertChannelBinding(
  client: pg.PoolClient,
  agentId: string,
  binding: RuntimeInventorySnapshot["agents"][number]["channelBindings"][number],
  index: number,
): Promise<void> {
  await client.query(`
    INSERT INTO channel_bindings (id, agent_id, kind, label, external_id, status, raw, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      agent_id = excluded.agent_id,
      kind = excluded.kind,
      label = excluded.label,
      external_id = excluded.external_id,
      status = excluded.status,
      raw = excluded.raw,
      updated_at = now()
  `, [
    createChannelBindingId(agentId, binding, index),
    agentId,
    binding.kind,
    binding.label,
    binding.externalId ?? null,
    binding.status ?? null,
    toJson(binding),
  ]);
}

async function upsertWorkConversation(
  client: pg.PoolClient,
  deviceId: string,
  conversation: RuntimeWorkStateSnapshot["conversations"][number],
  runtimeIds: Set<string> = new Set(),
  agentIds: Set<string> = new Set(),
): Promise<boolean> {
  await client.query(`
    INSERT INTO work_conversations (
      id, device_id, runtime_id, agent_id, source, external_id, status, channel_kind, channel_label, title,
      work_item_id, participants, started_at, last_activity_at, last_seen_at, source_refs, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      device_id = excluded.device_id,
      runtime_id = excluded.runtime_id,
      agent_id = excluded.agent_id,
      source = excluded.source,
      external_id = excluded.external_id,
      status = excluded.status,
      channel_kind = excluded.channel_kind,
      channel_label = excluded.channel_label,
      title = excluded.title,
      work_item_id = excluded.work_item_id,
      participants = excluded.participants,
      started_at = excluded.started_at,
      last_activity_at = excluded.last_activity_at,
      last_seen_at = excluded.last_seen_at,
      source_refs = excluded.source_refs,
      raw = excluded.raw,
      updated_at = now()
  `, [
    conversation.id,
    deviceId,
    knownOptionalRef(conversation.runtimeId, runtimeIds),
    knownOptionalRef(conversation.agentId, agentIds),
    conversation.source,
    conversation.externalId,
    conversation.status,
    conversation.channel?.kind ?? null,
    conversation.channel?.label ?? null,
    conversation.title ?? null,
    conversation.workItemId ?? null,
    toJson(conversation.participants ?? []),
    toDate(conversation.startedAt),
    toDate(conversation.lastActivityAt),
    toDate(conversation.lastSeenAt),
    toJson(conversation.sourceRefs ?? []),
    toJson(conversation),
  ]);
  return true;
}

async function upsertWorkItem(
  client: pg.PoolClient,
  deviceId: string,
  workItem: RuntimeWorkItem,
  execution?: RuntimeExecution,
  conversationIds: Set<string> = new Set(),
  runtimeIds: Set<string> = new Set(),
  agentIds: Set<string> = new Set(),
): Promise<boolean> {
  const stage = deriveRuntimeWorkStage({
    executionStatus: execution?.status,
    source: workItem.source,
    workItemStatus: workItem.status,
  }).stage;

  await client.query(`
    INSERT INTO work_items (
      id, device_id, runtime_id, agent_id, conversation_id, source, external_id, title, description, status,
      stage, channel_kind, channel_label, creator, assignee, created_source_at, updated_source_at, last_seen_at,
      source_refs, raw, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18,
      $19::jsonb, $20::jsonb, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      device_id = excluded.device_id,
      runtime_id = excluded.runtime_id,
      agent_id = excluded.agent_id,
      conversation_id = excluded.conversation_id,
      source = excluded.source,
      external_id = excluded.external_id,
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      stage = excluded.stage,
      channel_kind = excluded.channel_kind,
      channel_label = excluded.channel_label,
      creator = excluded.creator,
      assignee = excluded.assignee,
      created_source_at = excluded.created_source_at,
      updated_source_at = excluded.updated_source_at,
      last_seen_at = excluded.last_seen_at,
      source_refs = excluded.source_refs,
      raw = excluded.raw,
      updated_at = now()
  `, [
    workItem.id,
    deviceId,
    knownOptionalRef(workItem.runtimeId, runtimeIds),
    knownOptionalRef(workItem.agentId, agentIds),
    knownOptionalRef(workItem.conversationId, conversationIds),
    workItem.source,
    workItem.externalId,
    workItem.title,
    workItem.description ?? null,
    workItem.status,
    stage,
    workItem.channel?.kind ?? null,
    workItem.channel?.label ?? null,
    toJsonOrNull(workItem.creator),
    toJsonOrNull(workItem.assignee),
    toDate(workItem.createdAt),
    toDate(workItem.updatedAt),
    toDate(workItem.lastSeenAt),
    toJson(workItem.sourceRefs ?? []),
    toJson(workItem),
  ]);
  return true;
}

async function upsertWorkExecution(
  client: pg.PoolClient,
  deviceId: string,
  execution: RuntimeExecution,
  workItemIds: Set<string> = new Set(),
  conversationIds: Set<string> = new Set(),
  runtimeIds: Set<string> = new Set(),
  agentIds: Set<string> = new Set(),
): Promise<boolean> {
  if (!runtimeIds.has(execution.runtimeId)) return false;
  await client.query(`
    INSERT INTO work_executions (
      id, device_id, runtime_id, agent_id, work_item_id, conversation_id, source, external_id, status,
      queued_at, started_at, ended_at, last_seen_at, error, source_refs, raw, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      device_id = excluded.device_id,
      runtime_id = excluded.runtime_id,
      agent_id = excluded.agent_id,
      work_item_id = excluded.work_item_id,
      conversation_id = excluded.conversation_id,
      source = excluded.source,
      external_id = excluded.external_id,
      status = excluded.status,
      queued_at = excluded.queued_at,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      last_seen_at = excluded.last_seen_at,
      error = excluded.error,
      source_refs = excluded.source_refs,
      raw = excluded.raw,
      updated_at = now()
  `, [
    execution.id,
    deviceId,
    execution.runtimeId,
    knownOptionalRef(execution.agentId, agentIds),
    knownOptionalRef(execution.workItemId, workItemIds),
    knownOptionalRef(execution.conversationId, conversationIds),
    execution.source,
    execution.externalId,
    execution.status,
    toDate(execution.queuedAt),
    toDate(execution.startedAt),
    toDate(execution.endedAt),
    toDate(execution.lastSeenAt),
    execution.error ?? null,
    toJson(execution.sourceRefs ?? []),
    toJson(execution),
  ]);
  return true;
}

function knownOptionalRef(value: string | undefined, knownIds: Set<string>): string | null {
  if (!value) return null;
  return knownIds.has(value) ? value : null;
}

async function insertCollectorIngestion(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  input: {
    deviceId: string;
    snapshotType: "inventory" | "work_state";
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

function createLatestExecutionsByWorkItemId(executions: RuntimeExecution[]): Map<string, RuntimeExecution> {
  const latestExecutions = new Map<string, RuntimeExecution>();
  for (const execution of executions) {
    if (!execution.workItemId) continue;
    const current = latestExecutions.get(execution.workItemId);
    if (!current || executionTimestamp(execution) > executionTimestamp(current)) {
      latestExecutions.set(execution.workItemId, execution);
    }
  }
  return latestExecutions;
}

function createWorkItemWhereClause(filters: PostgresRuntimeWorkItemFilters): {
  clause: string;
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  addTextFilter(conditions, values, "w.source", filters.source);
  addTextFilter(conditions, values, "w.stage", filters.stage);
  addTextFilter(conditions, values, "w.channel_kind", filters.channelKind);

  const cursor = decodeWorkItemCursor(filters.cursor);
  if (cursor) {
    values.push(toDate(cursor.orderTimestamp), cursor.id);
    conditions.push(`(
      ${workItemOrderExpression} < $${values.length - 1}
      OR (${workItemOrderExpression} = $${values.length - 1} AND w.id < $${values.length})
    )`);
  }

  if (filters.startAt) {
    values.push(toDate(filters.startAt));
    conditions.push(`${workItemOrderExpression} >= $${values.length}`);
  }
  if (filters.endAt) {
    values.push(toDate(filters.endAt));
    conditions.push(`${workItemOrderExpression} <= $${values.length}`);
  }
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    conditions.push(`(
      w.title ILIKE $${values.length}
      OR coalesce(w.description, '') ILIKE $${values.length}
      OR w.source ILIKE $${values.length}
      OR coalesce(w.channel_label, '') ILIKE $${values.length}
      OR coalesce(w.creator->>'label', '') ILIKE $${values.length}
      OR coalesce(w.creator->>'externalId', '') ILIKE $${values.length}
      OR coalesce(w.assignee->>'label', '') ILIKE $${values.length}
      OR coalesce(w.assignee->>'externalId', '') ILIKE $${values.length}
      OR coalesce(w.assignee->>'objectId', '') ILIKE $${values.length}
      OR coalesce(w.agent_id, '') ILIKE $${values.length}
      OR coalesce(w.runtime_id, '') ILIKE $${values.length}
      OR coalesce(r.name, '') ILIKE $${values.length}
      OR coalesce(a.name, '') ILIKE $${values.length}
      OR coalesce(c.title, '') ILIKE $${values.length}
      OR coalesce(c.channel_label, '') ILIKE $${values.length}
    )`);
  }

  return {
    clause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

function encodeWorkItemCursor(row: PostgresWorkItemQueryRow | undefined): string | undefined {
  if (!row?.orderTimestamp) return undefined;
  return Buffer.from(JSON.stringify({
    id: row.id,
    orderTimestamp: row.orderTimestamp.toISOString(),
  })).toString("base64url");
}

function decodeWorkItemCursor(value: string | null | undefined): { id: string; orderTimestamp: string } | null {
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

function stripWorkItemOrderTimestamp(row: PostgresWorkItemQueryRow): PostgresWorkItemRow {
  const { orderTimestamp: _orderTimestamp, ...workItem } = row;
  return workItem;
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

function executionTimestamp(execution: RuntimeExecution): number {
  return Date.parse(execution.lastSeenAt ?? execution.endedAt ?? execution.startedAt ?? execution.queuedAt ?? "") || 0;
}

function createChannelBindingId(
  agentId: string,
  binding: RuntimeInventorySnapshot["agents"][number]["channelBindings"][number],
  index: number,
): string {
  return `${agentId}:channel:${normalizeObjectKey(binding.kind)}:${normalizeObjectKey(binding.externalId ?? binding.label)}:${index}`;
}

function agentSkillProbeSnapshotId(agentId: string): string {
  return `agent-skill-probe:${agentId}`;
}

function normalizeObjectKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
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
