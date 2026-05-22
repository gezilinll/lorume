import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/** Repository root used by DB integration harness commands. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Whether Postgres-backed tests should run in the current process. */
export function shouldRunPostgresTests(): boolean {
  return process.env.LORUME_RUN_DB_TESTS === "1";
}

/** Temporary database allocated for one DB integration test. */
export interface TemporaryPostgresDatabase {
  /** Database name, useful for debugging cleanup failures. */
  name: string;
  /** Connection URL for the temporary database. */
  url: string;
  /** Drop the temporary database and terminate remaining sessions. */
  drop: () => Promise<void>;
}

/** Create an isolated database under the local test Postgres instance. */
export async function createTemporaryPostgresDatabase(): Promise<TemporaryPostgresDatabase> {
  const adminUrl = getAdminDatabaseUrl();
  const databaseName = `lorume_test_${process.pid}_${Date.now()}_${Math.round(Math.random() * 1_000_000)}`;
  const adminClient = await connectWithRetry(adminUrl.toString());
  try {
    await adminClient.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await adminClient.end();
  }

  const databaseUrl = new URL(adminUrl.toString());
  databaseUrl.pathname = `/${databaseName}`;
  return {
    name: databaseName,
    url: databaseUrl.toString(),
    drop: () => dropTestDatabase(databaseName),
  };
}

/** Apply the current database schema baseline against a database URL. */
export function runDatabaseSchemaScript(databaseUrl: string): void {
  execFileSync(process.execPath, [path.join(repoRoot, "scripts/db-setup.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}

/** Connect to Postgres, retrying while Docker Compose finishes startup. */
export async function connectWithRetry(connectionString: string): Promise<Client> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 30_000) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      lastError = error;
      await delay(500);
    }
  }

  throw lastError;
}

async function dropTestDatabase(databaseName: string): Promise<void> {
  const adminClient = await connectWithRetry(getAdminDatabaseUrl().toString());
  try {
    await adminClient.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [
      databaseName,
    ]);
    await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } finally {
    await adminClient.end();
  }
}

function getAdminDatabaseUrl(): URL {
  const databaseUrl = new URL(process.env.LORUME_TEST_DATABASE_URL ?? "postgres://lorume:lorume@127.0.0.1:54329/postgres");
  databaseUrl.pathname = "/postgres";
  return databaseUrl;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
