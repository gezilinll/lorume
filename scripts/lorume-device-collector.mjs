#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir, hostname, arch, platform, networkInterfaces, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTOR_VERSION = "0.1.0";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_PROBE_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const POST_RETRY_DELAYS_MS = [0, 500, 1500];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LORUME_CLI_PATH = path.join(SCRIPT_DIR, "lorume.mjs");
const DEFAULT_COLLECTOR_LOG_MAX_BYTES = 5 * 1024 * 1024;
const COLLECTOR_LOG_SECRET_KEYS = new Set([
  "authorization",
  "bearertoken",
  "code",
  "devicetoken",
  "emailprovidertoken",
  "invitationtoken",
  "password",
  "sessiontoken",
  "token",
]);

function parseArgs(argv) {
  const args = {
    once: false,
    workStateOnce: false,
    printOnly: false,
    configPath: "",
    fixturePath: "",
    serverUrl: "",
    wsUrl: "",
    deviceId: "",
    deviceName: "",
    deviceToken: "",
    intervalMs: DEFAULT_INTERVAL_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    if (arg === "--once") args.once = true;
    else if (arg === "--work-state-once") args.workStateOnce = true;
    else if (arg === "--print-only") args.printOnly = true;
    else if (arg === "--config") args.configPath = next();
    else if (arg === "--fixture") args.fixturePath = next();
    else if (arg === "--server-url") args.serverUrl = next();
    else if (arg === "--ws-url") args.wsUrl = next();
    else if (arg === "--device-id") args.deviceId = next();
    else if (arg === "--device-name") args.deviceName = next();
    else if (arg === "--device-token") args.deviceToken = next();
    else if (arg === "--interval-ms") args.intervalMs = Number(next());
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: lorume-device-collector [options]

Options:
  --once                 Collect once and exit
  --work-state-once      Collect one runtime work-state snapshot and exit
  --print-only           Print snapshot instead of posting
  --config <path>        Read collector config JSON
  --fixture <path>       Load a fixture snapshot instead of probing the host
  --server-url <url>     Lorume server URL
  --ws-url <url>         Lorume device control WebSocket URL
  --device-id <id>       Override device id
  --device-name <name>   Override device name
  --device-token <token> Lorume device token for ingestion and control
  --interval-ms <ms>     Collection interval when not using --once
`);
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function homeDir() {
  return process.env.LORUME_COLLECTOR_HOME || homedir();
}

function loadConfig(configPath) {
  if (!configPath) return {};
  if (!existsSync(configPath)) return {};
  return readJsonFile(configPath);
}

function isoNow() {
  return new Date().toISOString();
}

function resolveCollectorLogPath(config = {}) {
  return process.env.LORUME_COLLECTOR_LOG_PATH || config.logPath || path.join(homeDir(), ".lorume", "logs", "collector.jsonl");
}

function resolveCollectorLogMaxBytes(config = {}) {
  const value = Number(process.env.LORUME_COLLECTOR_LOG_MAX_BYTES || config.logMaxBytes || DEFAULT_COLLECTOR_LOG_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COLLECTOR_LOG_MAX_BYTES;
}

function createCollectorLogger(config = {}) {
  const logPath = resolveCollectorLogPath(config);
  const maxBytes = resolveCollectorLogMaxBytes(config);
  const write = (level, fields, message) => writeCollectorLog(logPath, maxBytes, level, fields, message);

  return {
    error: (fields, message) => write("error", fields, message),
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
  };
}

function writeCollectorLog(logPath, maxBytes, level, fields, message) {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    rotateCollectorLogIfNeeded(logPath, maxBytes);
    appendFileSync(logPath, `${JSON.stringify({
      ...redactCollectorLogFields(fields || {}),
      level,
      message,
      service: "lorume-device-collector",
      time: isoNow(),
    })}\n`, "utf8");
  } catch {
    // Logging is best-effort and must never block device collection.
  }
}

function rotateCollectorLogIfNeeded(logPath, maxBytes) {
  try {
    if (statSync(logPath).size < maxBytes) return;
    renameSync(logPath, `${logPath}.1`);
  } catch {
    // Missing or unrotatable logs can be ignored.
  }
}

function redactCollectorLogFields(value) {
  if (Array.isArray(value)) return value.map((entry) => redactCollectorLogFields(entry));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    COLLECTOR_LOG_SECRET_KEYS.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase())
      ? "[redacted]"
      : redactCollectorLogFields(entry),
  ]));
}

function collectorErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/post failed/i.test(message)) return "collector_post_failed";
  if (/non-json|invalid|snapshot/i.test(message)) return "invalid_collector_snapshot";
  return "collector_run_failed";
}

function collectorErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeId(value) {
  return String(value || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function createDevice(config, observedAt) {
  const defaultId = sanitizeId(hostname());
  const localIps = collectLocalIps();
  return {
    id: config.deviceId || defaultId,
    name: config.deviceName || config.deviceId || hostname(),
    hostname: hostname(),
    os: platform(),
    architecture: arch(),
    status: "unknown",
    connectionMode: "collector",
    lastSeenAt: observedAt,
    user: { username: safeUsername() },
    ...(localIps.length ? { network: { localIps } } : {}),
  };
}

function safeUsername() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

function collectLocalIps() {
  const values = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.address) values.push(entry.address);
    }
  }
  return Array.from(new Set(values)).sort();
}

function applyDeviceOverrides(snapshot, config) {
  if (!config.deviceId && !config.deviceName) return snapshot;
  const nextDevice = {
    ...snapshot.device,
    id: config.deviceId || snapshot.device.id,
    name: config.deviceName || snapshot.device.name,
  };
  const idReplacements = new Map();
  const runtimes = snapshot.runtimes.map((runtime) => {
    const nextRuntime = {
      ...runtime,
      id: runtime.id.replace(`${snapshot.device.id}:`, `${nextDevice.id}:`),
      deviceId: nextDevice.id,
    };
    idReplacements.set(runtime.id, nextRuntime.id);
    return nextRuntime;
  });
  const agents = snapshot.agents.map((agent) => {
    const nextRuntimeId = idReplacements.get(agent.runtimeId) || agent.runtimeId.replace(`${snapshot.device.id}:`, `${nextDevice.id}:`);
    return {
      ...agent,
      id: agent.id.replace(`${snapshot.device.id}:`, `${nextDevice.id}:`),
      runtimeId: nextRuntimeId,
    };
  });
  return { ...snapshot, device: nextDevice, runtimes, agents };
}

function collectSnapshot(config, args) {
  return collectSnapshotViaLorumeCli(config, args);
}

function collectSnapshotViaLorumeCli(config, args) {
  const cliArgs = ["collect", "inventory", "--json"];
  if (args.configPath) cliArgs.push("--config", args.configPath);
  if (args.fixturePath) cliArgs.push("--snapshot", args.fixturePath);
  const identity = resolveCliDeviceIdentity(config, args);
  if (identity.deviceId) cliArgs.push("--device-id", identity.deviceId);
  if (identity.deviceName) cliArgs.push("--device-name", identity.deviceName);
  return stripCliCommand(runLorumeCliJson(config, cliArgs));
}

function resolveDeviceToken(config, args) {
  return String(args.deviceToken || config.deviceToken || "").trim();
}

async function postSnapshot(serverUrl, snapshot, deviceToken = "") {
  const url = new URL("/api/device-snapshots", serverUrl);
  await postJsonWithRetry(url, snapshot, "Snapshot", deviceToken);
}

async function postWorkStateSnapshot(serverUrl, snapshot, deviceToken = "") {
  const url = new URL("/api/runtime-work-state-snapshots", serverUrl);
  await postJsonWithRetry(url, snapshot, "Work state snapshot", deviceToken);
}

async function postJsonWithRetry(url, payload, label, deviceToken = "") {
  let lastError;
  for (const [attempt, delayMs] of POST_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      const headers = { "content-type": "application/json" };
      if (deviceToken) headers.authorization = `Bearer ${deviceToken}`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (response.ok) return;
      lastError = new Error(`${label} post failed: HTTP ${response.status}`);
      if (response.status < 500 || attempt === POST_RETRY_DELAYS_MS.length - 1) break;
    } catch (error) {
      lastError = error;
      if (attempt === POST_RETRY_DELAYS_MS.length - 1) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} post failed`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function runOnce(config, args) {
  const snapshot = collectSnapshot(config, args);
  const serverUrl = args.serverUrl || config.serverUrl || "";
  if (serverUrl && !args.printOnly) await postSnapshot(serverUrl, snapshot, resolveDeviceToken(config, args));
  if (args.printOnly || !serverUrl) console.log(JSON.stringify(snapshot, null, 2));
  return snapshot;
}

async function collectWorkStateSnapshot(config, args) {
  return collectWorkStateViaLorumeCli(config, args);
}

async function collectWorkStateViaLorumeCli(config, args) {
  const cliArgs = ["collect", "work-state", "--json"];
  if (args.configPath) cliArgs.push("--config", args.configPath);
  const identity = resolveCliDeviceIdentity(config, args);
  if (identity.deviceId) cliArgs.push("--device-id", identity.deviceId);
  return stripCliCommand(runLorumeCliJson(config, cliArgs));
}

function resolveCliDeviceIdentity(config, args) {
  if (args.deviceId || config.deviceId || args.deviceName || config.deviceName) {
    return {
      deviceId: args.deviceId || config.deviceId || "",
      deviceName: args.deviceName || config.deviceName || "",
    };
  }
  if (args.fixturePath) {
    try {
      const device = readJsonFile(args.fixturePath)?.device;
      return {
        deviceId: typeof device?.id === "string" ? device.id : "",
        deviceName: typeof device?.name === "string" ? device.name : "",
      };
    } catch {
      return { deviceId: "", deviceName: "" };
    }
  }
  return { deviceId: "", deviceName: "" };
}

function resolveLorumeCliPath(config) {
  return process.env.LORUME_CLI_PATH || config.lorumeCliPath || DEFAULT_LORUME_CLI_PATH;
}

function runLorumeCliJson(config, cliArgs) {
  const cliPath = resolveLorumeCliPath(config);
  const result = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: DEFAULT_PROBE_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(stderr || `lorume CLI failed with exit code ${result.status}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("lorume CLI returned non-JSON output");
  }
}

function stripCliCommand(value) {
  if (!value || typeof value !== "object") return value;
  const { command: _command, ...snapshot } = value;
  return snapshot;
}

async function runWorkStateOnce(config, args) {
  const snapshot = await collectWorkStateSnapshot(config, args);
  const serverUrl = args.serverUrl || config.serverUrl || "";
  if (serverUrl && !args.printOnly) {
    await postWorkStateSnapshot(serverUrl, snapshot, resolveDeviceToken(config, args));
  }
  if (args.printOnly || !serverUrl) console.log(JSON.stringify(snapshot, null, 2));
  return snapshot;
}

async function refreshSnapshots(config, args) {
  const inventorySnapshot = await runOnce(config, args);
  const workStateSnapshot = await runWorkStateOnce(config, args);
  return { inventorySnapshot, workStateSnapshot };
}

function createRefreshRunner(config, args) {
  let inFlight;
  return () => {
    if (!inFlight) {
      inFlight = refreshSnapshots(config, args).finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}

function resolveServerUrl(config, args) {
  return args.serverUrl || config.serverUrl || "";
}

function resolveWsUrl(config, args) {
  const explicitWsUrl = args.wsUrl || config.wsUrl || "";
  if (explicitWsUrl) return explicitWsUrl;
  const serverUrl = resolveServerUrl(config, args);
  if (!serverUrl) return "";
  try {
    const url = new URL("/api/device-control/ws", serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  } catch {
    return "";
  }
}

function sendControlMessage(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ sentAt: isoNow(), ...message }));
}

function heartbeatPayload(config, args) {
  const observedAt = isoNow();
  const device = createControlDevice(config, args, observedAt);
  return {
    type: "heartbeat",
    deviceId: device.id,
    deviceName: device.name,
    hostname: device.hostname,
    collectorVersion: COLLECTOR_VERSION,
  };
}

function mergedControlConfig(config, args) {
  return {
    ...config,
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
    ...(args.deviceName ? { deviceName: args.deviceName } : {}),
  };
}

function createControlDevice(config, args, observedAt) {
  if (args.fixturePath) {
    try {
      return applyDeviceOverrides(readJsonFile(args.fixturePath), mergedControlConfig(config, args)).device;
    } catch {
      // Fall back to local device identity when the fixture cannot be read.
    }
  }
  return createDevice(mergedControlConfig(config, args), observedAt);
}

function startControlChannel(config, args) {
  const wsUrl = resolveWsUrl(config, args);
  if (!wsUrl || typeof WebSocket === "undefined") return;

  const serverUrl = resolveServerUrl(config, args);
  if (!serverUrl && !args.printOnly) return;

  let heartbeatTimer;
  let reconnectTimer;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => {
      const observedAt = isoNow();
      const device = createControlDevice(config, args, observedAt);
      sendControlMessage(socket, {
        type: "hello",
        deviceId: device.id,
        deviceName: device.name,
        ...(resolveDeviceToken(config, args) ? { deviceToken: resolveDeviceToken(config, args) } : {}),
        hostname: device.hostname,
        collectorVersion: COLLECTOR_VERSION,
      });
      sendControlMessage(socket, heartbeatPayload(config, args));
      heartbeatTimer = setInterval(() => {
        sendControlMessage(socket, heartbeatPayload(config, args));
      }, Math.min(Number(args.intervalMs || config.intervalMs || DEFAULT_INTERVAL_MS), 30_000));
    });

    socket.addEventListener("close", () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (!closed) reconnectTimer = setTimeout(connect, 5_000);
    });

    socket.addEventListener("error", () => {
      // Close will schedule reconnect. Keep logs quiet so API keys in process args are never echoed.
    });
  };

  connect();
  return () => {
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const logger = createCollectorLogger(config);

  try {
    if (args.workStateOnce) {
      await runWorkStateOnce(config, args);
      return;
    }

    if (args.once) {
      await runOnce(config, args);
      return;
    }

    const refresh = createRefreshRunner(config, args);
    startControlChannel(config, args);
    await refresh();
    setInterval(() => {
      refresh().catch((error) => {
        logger.error({
          errorCode: collectorErrorCode(error),
          event: "collector_refresh_failed",
        }, collectorErrorMessage(error));
        console.error(`[lorume-device-collector] ${collectorErrorMessage(error)}`);
      });
    }, Number.isFinite(args.intervalMs) && args.intervalMs > 0 ? args.intervalMs : DEFAULT_INTERVAL_MS);
  } catch (error) {
    logger.error({
      errorCode: collectorErrorCode(error),
      event: "collector_run_failed",
    }, collectorErrorMessage(error));
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
