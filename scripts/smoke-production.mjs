#!/usr/bin/env node

const baseUrl = new URL(process.env.LORUME_BASE_URL || "https://lorume.com");
const deviceId = process.env.LORUME_DEVICE_ID || "gezilinll-claw";
const timeoutMs = Number(process.env.LORUME_SMOKE_TIMEOUT_MS || 10_000);
const smokeCookie = process.env.LORUME_SMOKE_COOKIE || "";
const smokeBearerToken = process.env.LORUME_SMOKE_BEARER_TOKEN || "";

const publicChecks = [
  {
    name: "healthz",
    path: "/healthz",
    type: "json",
    validate: (body) => body?.ok === true,
  },
  {
    name: "readyz",
    path: "/readyz",
    type: "json",
    validate: (body) => body?.ok === true,
  },
  {
    name: "installer",
    path: "/api/device-collector/install.sh",
    type: "text",
    validate: (body) => [
      'download "install-device-collector.sh"',
      'download "lorume-device-collector.mjs"',
      'download "lorume-runtime-adapters.mjs"',
      'download "lorume.mjs"',
    ].every((fragment) => body.includes(fragment)) && !body.includes("--device-name"),
  },
  {
    name: "collector manifest",
    path: "/api/device-collector/manifest.json",
    type: "json",
    validate: (body) => body?.schemaVersion === "collector-package-v1"
      && typeof body?.version === "string"
      && Array.isArray(body?.files)
      && body.files.some((file) => file?.fileName === "lorume-device-collector.mjs" && /^[a-f0-9]{64}$/.test(file?.sha256 ?? "")),
  },
];

const authenticatedChecks = [
  {
    name: "runtime fleet",
    path: "/api/runtime-fleet",
    type: "json",
    validate: (body) => Array.isArray(body?.devices) && Array.isArray(body?.runtimes) && Array.isArray(body?.agents),
  },
  {
    name: "runtime tasks",
    path: "/api/runtime-tasks?limit=1",
    type: "json",
    validate: (body) => Array.isArray(body?.items) && typeof body?.total === "number",
  },
  {
    name: "collection health",
    path: `/api/devices/${encodeURIComponent(deviceId)}/collection-health`,
    type: "json",
    validate: (body) => body?.deviceId === deviceId && Array.isArray(body?.checks),
  },
  {
    name: "diagnostics",
    path: `/api/devices/${encodeURIComponent(deviceId)}/diagnostics`,
    type: "json",
    validate: (body) => body?.deviceId === deviceId
      && ["syncing", "online", "offline", "error"].includes(body?.status)
      && typeof body?.label === "string",
  },
];

for (const check of publicChecks) {
  const url = new URL(check.path, baseUrl);
  const body = await fetchBody(url, check.type);
  if (!check.validate(body)) {
    fail(`${check.name} returned an unexpected payload`);
  }
  process.stdout.write(`smoke:${check.name}: ok\n`);
}

if (!smokeCookie && !smokeBearerToken) {
  process.stdout.write("smoke:authenticated-read: skipped\n");
} else {
  for (const check of authenticatedChecks) {
    const url = new URL(check.path, baseUrl);
    const body = await fetchBody(url, check.type, smokeAuthHeaders());
    if (!check.validate(body)) {
      fail(`${check.name} returned an unexpected payload`);
    }
    process.stdout.write(`smoke:${check.name}: ok\n`);
  }
}

process.stdout.write(`smoke: ok ${baseUrl.toString()}\n`);

async function fetchBody(url, type, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) fail(`${url.pathname} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
    if (type === "text") return text;
    try {
      return JSON.parse(text);
    } catch {
      fail(`${url.pathname} did not return JSON`);
    }
  } catch (error) {
    fail(`${url.pathname} request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function smokeAuthHeaders() {
  return {
    ...(smokeCookie ? { cookie: smokeCookie } : {}),
    ...(smokeBearerToken ? { authorization: `Bearer ${smokeBearerToken}` } : {}),
  };
}

function fail(message) {
  process.stderr.write(`smoke: failed: ${message}\n`);
  process.exit(1);
}
