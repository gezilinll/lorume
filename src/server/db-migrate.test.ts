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
          "collected_at",
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
          "user_message",
          "agent_reply",
          "status",
          "source_external_id",
          "channel",
          "conversation",
          "creator",
          "assignee",
          "error",
          "created_source_at",
          "updated_source_at",
          "sync_hash",
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
          "0012_runtime_task_batch_sync",
          "0013_devices_collected_at",
        ]);
      } finally {
        await client.end();
      }
    } finally {
      await database.drop();
    }
  });

  it("upgrades databases that already applied the old Task schema migration", async () => {
    const database = await createTemporaryPostgresDatabase();
    const client = await connectWithRetry(database.url);

    try {
      await client.query(`
        CREATE TABLE schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO schema_migrations(version) VALUES
          ('0001_backend_core'),
          ('0002_auth_access'),
          ('0005_operations_notifications'),
          ('0008_notification_read_state'),
          ('0009_agent_skill_probing'),
          ('0011_device_state_tasks');

        CREATE TABLE devices (
          id text PRIMARY KEY,
          hostname text NOT NULL,
          os text NOT NULL,
          architecture text,
          collection_status text NOT NULL DEFAULT 'syncing',
          collector jsonb NOT NULL DEFAULT '{}'::jsonb,
          last_seen_at timestamptz,
          observed_at timestamptz NOT NULL,
          raw jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        INSERT INTO devices(id, hostname, os, observed_at)
        VALUES ('device-1', 'fixture.local', 'darwin', '2026-05-22T08:00:00Z');

        CREATE TABLE collector_ingestions (
          id bigserial PRIMARY KEY,
          device_id text NOT NULL,
          snapshot_type text NOT NULL,
          status text NOT NULL,
          observed_at timestamptz,
          received_at timestamptz NOT NULL DEFAULT now(),
          duration_ms integer,
          counts jsonb NOT NULL DEFAULT '{}'::jsonb,
          warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
          error text,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE tasks (
          id text PRIMARY KEY,
          device_id text NOT NULL,
          agent_id text NOT NULL,
          task_type text NOT NULL DEFAULT 'conversation',
          title text NOT NULL,
          description text,
          status text NOT NULL,
          source_external_id text,
          channel jsonb NOT NULL DEFAULT '{}'::jsonb,
          conversation jsonb NOT NULL DEFAULT '{}'::jsonb,
          creator jsonb,
          assignee jsonb,
          error text,
          created_source_at timestamptz,
          updated_source_at timestamptz,
          last_seen_at timestamptz,
          raw jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        INSERT INTO tasks(id, device_id, agent_id, title, description, status)
        VALUES ('task-1', 'device-1', 'agent-1', 'Legacy title', 'Legacy description', 'todo');
      `);
      await client.end();

      runMigrationsScript(database.url);

      const migratedClient = await connectWithRetry(database.url);
      try {
        await expect(listPublicColumnNames(migratedClient, "devices")).resolves.toContain("collected_at");
        await expect(listPublicColumnNames(migratedClient, "devices")).resolves.not.toContain("observed_at");
        await expect(listPublicColumnNames(migratedClient, "collector_ingestions")).resolves.toContain("collected_at");
        await expect(listPublicColumnNames(migratedClient, "collector_ingestions")).resolves.not.toContain("observed_at");
        await expect(listPublicColumnNames(migratedClient, "tasks")).resolves.toEqual([
          "id",
          "device_id",
          "agent_id",
          "task_type",
          "status",
          "source_external_id",
          "channel",
          "conversation",
          "creator",
          "assignee",
          "error",
          "created_source_at",
          "updated_source_at",
          "raw",
          "created_at",
          "updated_at",
          "user_message",
          "agent_reply",
          "sync_hash",
        ]);
        const result = await migratedClient.query<{ user_message: string | null }>(
          "SELECT user_message FROM tasks WHERE id = 'task-1'",
        );
        expect(result.rows[0]?.user_message).toBe("Legacy description");
        const deviceResult = await migratedClient.query<{ collected_at: Date | null }>(
          "SELECT collected_at FROM devices WHERE id = 'device-1'",
        );
        expect(deviceResult.rows[0]?.collected_at?.toISOString()).toBe("2026-05-22T08:00:00.000Z");
        expect(await listMigrationVersions(migratedClient)).toContain("0013_devices_collected_at");
      } finally {
        await migratedClient.end();
      }
    } finally {
      await database.drop();
    }
  });

  it("upgrades production databases that applied task sync before device collected_at existed", async () => {
    const database = await createTemporaryPostgresDatabase();
    const client = await connectWithRetry(database.url);

    try {
      await client.query(`
        CREATE TABLE schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO schema_migrations(version) VALUES
          ('0001_backend_core'),
          ('0002_auth_access'),
          ('0005_operations_notifications'),
          ('0008_notification_read_state'),
          ('0009_agent_skill_probing'),
          ('0011_device_state_tasks'),
          ('0012_runtime_task_batch_sync');

        CREATE TABLE devices (
          id text PRIMARY KEY,
          hostname text NOT NULL,
          os text NOT NULL,
          architecture text,
          collection_status text NOT NULL DEFAULT 'syncing',
          collector jsonb NOT NULL DEFAULT '{}'::jsonb,
          last_seen_at timestamptz,
          observed_at timestamptz NOT NULL,
          raw jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        INSERT INTO devices(id, hostname, os, observed_at)
        VALUES ('device-1', 'fixture.local', 'darwin', '2026-05-22T08:00:00Z');
      `);
      await client.end();

      runMigrationsScript(database.url);

      const migratedClient = await connectWithRetry(database.url);
      try {
        await expect(listPublicColumnNames(migratedClient, "devices")).resolves.toContain("collected_at");
        await expect(listPublicColumnNames(migratedClient, "devices")).resolves.not.toContain("observed_at");
        const deviceResult = await migratedClient.query<{ collected_at: Date | null }>(
          "SELECT collected_at FROM devices WHERE id = 'device-1'",
        );
        expect(deviceResult.rows[0]?.collected_at?.toISOString()).toBe("2026-05-22T08:00:00.000Z");
        expect(await listMigrationVersions(migratedClient)).toContain("0013_devices_collected_at");
      } finally {
        await migratedClient.end();
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
