import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createLorumeBackendServer } from "../src/backend/backend-server";

const { Client } = pg;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendPort = Number(process.env.LORUME_E2E_FRONTEND_PORT ?? 4175);
const backendPort = Number(process.env.LORUME_BACKEND_PORT ?? 4174);
const databaseUrl = process.env.DATABASE_URL ?? "postgres://lorume:lorume@127.0.0.1:54329/lorume_e2e";
const e2eSnapshotRoot = path.join(repoRoot, ".lorume", "e2e");
const e2eLoginCodePath = process.env.LORUME_E2E_LOGIN_CODE_PATH
  ?? path.join(e2eSnapshotRoot, "latest-login-code.json");

await prepareDatabase(databaseUrl);
rmSync(e2eLoginCodePath, { force: true });

const backend = createLorumeBackendServer({
  appMode: "agent",
  databaseUrl,
  emailProvider: {
    async sendLoginCode(input) {
      mkdirSync(path.dirname(e2eLoginCodePath), { recursive: true });
      writeFileSync(e2eLoginCodePath, JSON.stringify({
        ...input,
        sentAt: new Date().toISOString(),
      }, null, 2));
    },
  },
  host: "127.0.0.1",
  inventorySnapshotPath: path.join(e2eSnapshotRoot, "runtime-inventory", "latest.json"),
  port: backendPort,
  workStateSnapshotPath: path.join(e2eSnapshotRoot, "runtime-work-state", "latest.json"),
});
await backend.listen();
process.stdout.write(`Lorume E2E backend listening on ${backend.url}\n`);

const vite = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(frontendPort)], {
  cwd: repoRoot,
  env: {
    ...process.env,
    LORUME_BACKEND_URL: backend.url,
    VITE_LORUME_APP_MODE: "agent",
    VITE_LORUME_AUTH_MODE: "agent",
  },
  stdio: "inherit",
});

let shuttingDown = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!vite.killed) vite.kill();
  await backend.close();
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});
vite.on("exit", (code) => {
  void shutdown(code ?? 0);
});

async function prepareDatabase(connectionString: string): Promise<void> {
  execFileSync("docker", ["compose", "up", "-d", "postgres"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  await ensureDatabase(connectionString);
  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "db-migrate.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: "inherit",
  });
  await resetDatabase(connectionString);
}

async function ensureDatabase(connectionString: string): Promise<void> {
  const targetUrl = new URL(connectionString);
  const databaseName = targetUrl.pathname.replace(/^\//, "");
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const client = await connectWithRetry(adminUrl.toString());
  try {
    const result = await client.query<{ exists: number }>(
      "SELECT 1 AS exists FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    if (result.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } finally {
    await client.end();
  }
}

async function resetDatabase(connectionString: string): Promise<void> {
  const client = await connectWithRetry(connectionString);
  try {
    await client.query(`
      TRUNCATE
        notification_deliveries,
        notification_preferences,
        notification_threads,
        notification_events,
        operation_jobs,
        operations,
        device_tokens,
        organization_invitations,
        sessions,
        email_login_codes,
        organization_members,
        organizations,
        users,
        collector_ingestions,
        channel_bindings,
        work_executions,
        work_items,
        work_conversations,
        agents,
        runtimes,
        devices
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await client.end();
  }
}

async function connectWithRetry(connectionString: string): Promise<pg.Client> {
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
