import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  connectWithRetry,
  createTemporaryPostgresDatabase,
  repoRoot,
  runMigrationsScript,
  shouldRunPostgresTests,
} from "../test/postgres";

const migrationScriptPath = path.join(repoRoot, "scripts/db-migrate.mjs");
const describeDb = shouldRunPostgresTests() ? describe : describe.skip;

describeDb("database migrations", () => {
  it("creates the backend core schema and can run repeatedly", async () => {
    expect(existsSync(migrationScriptPath)).toBe(true);
    const database = await createTemporaryPostgresDatabase();

    try {
      runMigrationsScript(database.url);
      runMigrationsScript(database.url);

      const client = await connectWithRetry(database.url);
      try {
        const tableNames = await listPublicTableNames(client);

        expect(tableNames).toEqual([
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
          "organization_invitations",
          "organization_members",
          "organizations",
          "runtimes",
          "schema_migrations",
          "sessions",
          "tasks",
          "users",
        ]);
        await expect(listPublicColumnNames(client, "devices")).resolves.toEqual([
          "id",
          "hostname",
          "os",
          "architecture",
          "collection_status",
          "collector",
          "last_seen_at",
          "observed_at",
          "raw",
          "created_at",
          "updated_at",
        ]);
        await expect(listPublicColumnNames(client, "runtimes")).resolves.toEqual([
          "id",
          "device_id",
          "kind",
          "name",
          "collection_status",
          "version",
          "diagnostics",
          "last_seen_at",
          "raw",
          "created_at",
          "updated_at",
        ]);
        await expect(listPublicColumnNames(client, "agents")).resolves.toEqual([
          "id",
          "runtime_id",
          "name",
          "collection_status",
          "diagnostics",
          "last_seen_at",
          "raw",
          "created_at",
          "updated_at",
        ]);
        await expect(listPublicColumnNames(client, "tasks")).resolves.toEqual([
          "id",
          "device_id",
          "agent_id",
          "task_type",
          "title",
          "description",
          "status",
          "source_external_id",
          "channel",
          "conversation",
          "creator",
          "assignee",
          "error",
          "created_source_at",
          "updated_source_at",
          "last_seen_at",
          "raw",
          "created_at",
          "updated_at",
        ]);
        await expect(listPublicColumnNames(client, "agent_skill_probe_snapshots")).resolves.toEqual([
          "id",
          "device_id",
          "runtime_id",
          "agent_id",
          "status",
          "observed_at",
          "probed_at",
          "error_summary",
          "raw",
          "created_at",
          "updated_at",
        ]);
        expect(await listMigrationVersions(client)).toEqual([
          "0001_backend_core",
          "0002_auth_access",
          "0005_operations_notifications",
          "0008_notification_read_state",
          "0009_agent_skill_probing",
          "0011_device_state_tasks",
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

async function listMigrationVersions(client: Client): Promise<string[]> {
  const result = await client.query<{ version: string }>(`
    SELECT version
    FROM schema_migrations
    ORDER BY version
  `);
  return result.rows.map((row) => row.version);
}
