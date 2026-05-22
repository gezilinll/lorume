#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(repoRoot, "db", "schema.sql");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://lorume:lorume@127.0.0.1:54329/lorume";

try {
  await applySchema(databaseUrl);
  process.stdout.write("db:setup: schema ready\n");
} catch (error) {
  process.stderr.write(`db:setup: failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function applySchema(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(await readFile(schemaPath, "utf8"));
  } finally {
    await client.end();
  }
}
