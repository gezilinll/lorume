import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  connectWithRetry,
  createTemporaryPostgresDatabase,
  repoRoot,
  runDatabaseSchemaScript,
  shouldRunPostgresTests,
} from "../test/postgres";

const schemaScriptPath = path.join(repoRoot, "scripts/db-setup.mjs");
const describeDb = shouldRunPostgresTests() ? describe : describe.skip;

describeDb("database schema baseline", () => {
  it("creates the current backend schema baseline", async () => {
    expect(existsSync(schemaScriptPath)).toBe(true);
    const database = await createTemporaryPostgresDatabase();

    try {
      runDatabaseSchemaScript(database.url);
      runDatabaseSchemaScript(database.url);

      const client = await connectWithRetry(database.url);
      try {
        const tableNames = await listPublicTableNames(client);

        expect(tableNames).toEqual([
          "agent_analysis_reports",
          "agent_skill_probe_snapshots",
          "agents",
          "collector_ingestions",
          "device_tokens",
          "devices",
          "email_login_codes",
          "notification_deliveries",
          "notification_events",
          "notification_preferences",
          "notification_threads",
          "operation_jobs",
          "operations",
          "organization_audit_events",
          "organization_invitations",
          "organization_members",
          "organizations",
          "runtime_schedule_probe_snapshots",
          "runtime_skill_probe_snapshots",
          "runtimes",
          "sessions",
          "tasks",
          "users",
        ]);
        await expect(listPublicColumnNames(client, "devices")).resolves.toEqual([
          "id",
          "organization_id",
          "hostname",
          "os",
          "architecture",
          "collection_status",
          "collector",
          "last_seen_at",
          "collected_at",
          "raw",
          "created_at",
          "updated_at",
        ]);
        await expect(listPublicColumnNames(client, "tasks")).resolves.toEqual([
          "id",
          "device_id",
          "agent_id",
          "task_type",
          "user_message",
          "agent_reply",
          "status",
          "channel",
          "conversation",
          "creator",
          "assignee",
          "error",
          "created_source_at",
          "updated_source_at",
          "sync_hash",
          "stale_at",
          "raw",
          "created_at",
          "updated_at",
        ]);
        await expect(listPublicColumnNames(client, "collector_ingestions")).resolves.toEqual([
          "id",
          "device_id",
          "organization_id",
          "snapshot_type",
          "status",
          "collected_at",
          "received_at",
          "duration_ms",
          "counts",
          "diagnostics",
          "error",
          "created_at",
        ]);
        await expect(listPublicColumnNames(client, "device_tokens")).resolves.toEqual([
          "id",
          "organization_id",
          "device_id",
          "name",
          "token_hash",
          "token_ciphertext",
          "token_prefix",
          "status",
          "expires_at",
          "occupied_at",
          "revoked_at",
          "last_used_at",
          "created_at",
        ]);
        await expect(listPublicColumnNames(client, "organization_audit_events")).resolves.toEqual([
          "id",
          "organization_id",
          "actor_user_id",
          "event_type",
          "target_type",
          "target_id",
          "metadata",
          "created_at",
        ]);
        await expect(readColumnNullable(client, "organization_invitations", "expires_at")).resolves.toBe(true);
        await expect(listPublicColumnNames(client, "runtime_skill_probe_snapshots")).resolves.toEqual([
          "id",
          "device_id",
          "runtime_id",
          "runtime_kind",
          "status",
          "observed_at",
          "summary",
          "skills",
          "diagnostics",
          "raw",
          "created_at",
          "updated_at",
        ]);
        await expect(listPublicColumnNames(client, "runtime_schedule_probe_snapshots")).resolves.toEqual([
          "id",
          "device_id",
          "runtime_id",
          "runtime_kind",
          "status",
          "observed_at",
          "summary",
          "schedules",
          "diagnostics",
          "raw",
          "created_at",
          "updated_at",
        ]);
        await expect(readCheckConstraintDefinition(client, "operations", "operations_type_check")).resolves.toContain("collector_upgrade");
        await expect(readCheckConstraintDefinition(client, "operations", "operations_type_check")).resolves.toContain("agent_analysis");
        await expect(readCheckConstraintDefinition(client, "operation_jobs", "operation_jobs_type_check")).resolves.toContain("collector_upgrade_device");
        await expect(readCheckConstraintDefinition(client, "operation_jobs", "operation_jobs_type_check")).resolves.toContain("agent_analysis_openclaw");
        await expect(listPublicColumnNames(client, "agent_analysis_reports")).resolves.toEqual([
          "id",
          "organization_id",
          "operation_id",
          "device_id",
          "runtime_id",
          "agent_id",
          "runtime_kind",
          "period_start",
          "period_end",
          "prompt_kind",
          "prompt_version",
          "hard_metrics",
          "analysis",
          "model_metadata",
          "created_at",
        ]);
      } finally {
        await client.end();
      }
    } finally {
      await database.drop();
    }
  });
});

async function listPublicTableNames(client: Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
}

async function listPublicColumnNames(client: Client, tableName: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return result.rows.map((row) => row.column_name);
}

async function readColumnNullable(client: Client, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.query<{ is_nullable: string }>(`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
  `, [tableName, columnName]);
  return result.rows[0]?.is_nullable === "YES";
}

async function readCheckConstraintDefinition(client: Client, tableName: string, constraintName: string): Promise<string> {
  const result = await client.query<{ definition: string }>(`
    SELECT pg_get_constraintdef(pg_constraint.oid) AS definition
    FROM pg_constraint
    INNER JOIN pg_class table_class ON table_class.oid = pg_constraint.conrelid
    INNER JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_class.relname = $1
      AND pg_constraint.conname = $2
    LIMIT 1
  `, [tableName, constraintName]);
  return result.rows[0]?.definition ?? "";
}
