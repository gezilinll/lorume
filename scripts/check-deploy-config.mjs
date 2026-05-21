#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
  "dist/backend/backend-server.mjs",
  ".dockerignore",
  "Dockerfile.backend",
  "Dockerfile.frontend",
  "docker-compose.prod-like.yml",
  "nginx.lorume.conf",
  "scripts/smoke-production.mjs",
];

for (const file of requiredFiles) {
  assert(existsSync(path.join(repoRoot, file)), `missing ${file}`);
}

const nginxConfig = read("nginx.lorume.conf");
assert(nginxConfig.includes("proxy_pass http://backend:4173"), "nginx must proxy backend API traffic");
assert(nginxConfig.includes("proxy_set_header Upgrade $http_upgrade"), "nginx must proxy WebSocket upgrades");
assert(nginxConfig.includes("client_max_body_size 50m"), "nginx must allow collector device-state payloads");

const backendDockerfile = read("Dockerfile.backend");
assert(backendDockerfile.includes("node scripts/db-migrate.mjs"), "backend container must run migrations before start");
assert(backendDockerfile.includes("node dist/backend/backend-server.mjs"), "backend container must start bundled backend");
for (const installerFile of [
  "scripts/install-device-collector.sh",
  "scripts/lorume-device-collector.mjs",
  "scripts/lorume-runtime-adapters.mjs",
  "scripts/lorume.mjs",
]) {
  assert(backendDockerfile.includes(installerFile), `backend container must include ${installerFile} for remote device registration`);
}

const composeFile = read("docker-compose.prod-like.yml");
assert(composeFile.includes("condition: service_healthy"), "backend must wait for healthy Postgres in prod-like compose");
assert(composeFile.includes("Dockerfile.frontend"), "prod-like compose must build the frontend image");
assert(composeFile.includes("LORUME_POSTGRES_PASSWORD"), "prod-like compose must allow overriding the Postgres password");
assert(composeFile.includes("LORUME_BACKEND_PUBLISH"), "prod-like compose must allow backend host port binding override");
assert(composeFile.includes("LORUME_FRONTEND_PUBLISH"), "prod-like compose must allow frontend host port binding override");
assert(composeFile.includes("LORUME_DEVICE_TOKEN_REQUIRED"), "prod-like compose must require device tokens by default");

const packageJson = JSON.parse(read("package.json"));
assert(packageJson.scripts?.["smoke:production"] === "node scripts/smoke-production.mjs", "package must expose production smoke script");

process.stdout.write("check:deploy: ok\n");

function read(file) {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`check:deploy: failed: ${message}\n`);
    process.exit(1);
  }
}
