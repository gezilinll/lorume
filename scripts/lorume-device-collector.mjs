#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
const DEFAULT_TASK_BATCH_MAX_BYTES = 512 * 1024;
const DEFAULT_TASK_BATCH_MAX_TASKS = 1000;
const TASK_SYNC_SCHEMA_VERSION = "device-state-v2";
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
    printOnly: false,
    configPath: "",
    fixturePath: "",
    serverUrl: "",
    wsUrl: "",
    deviceId: "",
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
    else if (arg === "--print-only") args.printOnly = true;
    else if (arg === "--config") args.configPath = next();
    else if (arg === "--fixture") args.fixturePath = next();
    else if (arg === "--server-url") args.serverUrl = next();
    else if (arg === "--ws-url") args.wsUrl = next();
    else if (arg === "--device-id") args.deviceId = next();
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
  --print-only           Print snapshot instead of posting
  --config <path>        Read collector config JSON
  --fixture <path>       Load a fixture snapshot instead of probing the host
  --server-url <url>     Lorume server URL
  --ws-url <url>         Lorume device control WebSocket URL
  --device-id <id>       Override device id
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
  if (/non-json|invalid|snapshot/i.test(message)) return "invalid_device_state_snapshot";
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
    hostname: hostname(),
    os: platform(),
    architecture: arch(),
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
  if (!config.deviceId) return snapshot;
  const nextDevice = {
    ...snapshot.device,
    id: config.deviceId,
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
  const cliArgs = ["collect", "device-state", "--json"];
  if (args.configPath) cliArgs.push("--config", args.configPath);
  if (args.fixturePath) cliArgs.push("--snapshot", args.fixturePath);
  const identity = resolveCliDeviceIdentity(config, args);
  if (identity.deviceId) cliArgs.push("--device-id", identity.deviceId);
  return stripCliCommand(runLorumeCliJson(config, cliArgs));
}

function resolveDeviceToken(config, args) {
  return String(args.deviceToken || config.deviceToken || "").trim();
}

async function postSnapshot(serverUrl, snapshot, deviceToken = "") {
  const url = new URL("/api/device-state-snapshots", serverUrl);
  await postJsonWithRetry(url, snapshot, "Device state snapshot", deviceToken);
}

async function postTaskBatch(serverUrl, batch, deviceToken = "") {
  const url = new URL("/api/device-task-batches", serverUrl);
  return postJsonWithRetry(url, batch, "Runtime task batch", deviceToken);
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
      if (response.ok) return response.json().catch(() => ({}));
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

function metadataSnapshot(snapshot) {
  return {
    ...snapshot,
    tasks: [],
  };
}

async function postChangedTaskBatches(serverUrl, snapshot, config, deviceToken, logger) {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const cachePath = resolveTaskSyncCachePath(config);
  const cacheScope = createTaskSyncCacheScope(serverUrl, snapshot.device.id, deviceToken);
  const cache = readTaskSyncCache(cachePath, cacheScope);
  const currentTaskIds = new Set(tasks.map((task) => String(task.id || "")).filter(Boolean));
  const removedTaskIds = canTrustTaskPresence(snapshot)
    ? Object.keys(cache.tasks).filter((taskId) => !currentTaskIds.has(taskId))
    : [];
  const entries = tasks
    .map((task) => ({ task, hash: createRuntimeTaskHash(task) }))
    .filter((entry) => cache.tasks[entry.task.id]?.hash !== entry.hash);
  if (entries.length === 0 && removedTaskIds.length === 0) {
    logger.info({ deviceId: snapshot.device.id, event: "task_batch_upload_skipped", tasks: tasks.length }, "No changed tasks to upload.");
    return;
  }
  const batchOptions = {
    batchMaxBytes: positiveInteger(config.taskBatchMaxBytes, DEFAULT_TASK_BATCH_MAX_BYTES),
    batchMaxTasks: positiveInteger(config.taskBatchMaxTasks, DEFAULT_TASK_BATCH_MAX_TASKS),
    collectedAt: snapshot.collectedAt,
    deviceId: snapshot.device.id,
  };
  const batches = sequenceRuntimeTaskBatches([
    ...createRuntimeTaskBatches(entries, batchOptions),
    ...createRuntimeTaskRemovalBatches(removedTaskIds, batchOptions),
  ], batchOptions);

  for (const batch of batches) {
    const response = await postTaskBatch(serverUrl, batch, deviceToken);
    applyTaskBatchAck(cache, response?.acked, response?.removed, batch);
    writeTaskSyncCache(cachePath, cache);
  }
  logger.info({
    deviceId: snapshot.device.id,
    event: "task_batch_upload_succeeded",
    batches: batches.length,
    removedTasks: removedTaskIds.length,
    tasks: entries.length,
  });
}

function canTrustTaskPresence(snapshot) {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  if (tasks.length > 0) return true;
  const runtimes = Array.isArray(snapshot.runtimes) ? snapshot.runtimes : [];
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  return runtimes.some((runtime) => runtime?.collectionStatus === "online") &&
    agents.some((agent) => agent?.collectionStatus === "online");
}

function resolveTaskSyncCachePath(config = {}) {
  return process.env.LORUME_TASK_SYNC_CACHE_PATH || config.taskSyncCachePath || path.join(homeDir(), ".lorume", "task-sync-cache.json");
}

function createTaskSyncCacheScope(serverUrl, deviceId, deviceToken) {
  return {
    deviceId: String(deviceId || ""),
    serverUrl: normalizeTaskSyncServerUrl(serverUrl),
    tokenPrefix: String(deviceToken || "").slice(0, 12),
  };
}

function normalizeTaskSyncServerUrl(serverUrl) {
  try {
    const url = new URL(String(serverUrl || ""));
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/g, "");
    return url.toString().replace(/\/$/g, "");
  } catch {
    return String(serverUrl || "").replace(/\/+$/g, "");
  }
}

function readTaskSyncCache(cachePath, scope) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schemaVersion === TASK_SYNC_SCHEMA_VERSION &&
      taskSyncScopesEqual(parsed.scope, scope) &&
      parsed.tasks &&
      typeof parsed.tasks === "object"
    ) {
      return {
        schemaVersion: TASK_SYNC_SCHEMA_VERSION,
        scope,
        tasks: parsed.tasks,
      };
    }
  } catch {
    // Missing or malformed cache starts empty.
  }
  return createEmptyTaskSyncCache(scope);
}

function taskSyncScopesEqual(left, right) {
  return Boolean(left && right) &&
    left.deviceId === right.deviceId &&
    left.serverUrl === right.serverUrl &&
    left.tokenPrefix === right.tokenPrefix;
}

function createEmptyTaskSyncCache(scope) {
  return {
    schemaVersion: TASK_SYNC_SCHEMA_VERSION,
    scope,
    tasks: {},
  };
}

function writeTaskSyncCache(cachePath, cache) {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(tempPath, cachePath);
}

function applyTaskBatchAck(cache, acked, removed, batch) {
  const ackById = new Map((Array.isArray(acked) ? acked : []).map((entry) => [entry?.id, entry?.hash]));
  const removedIds = new Set((Array.isArray(removed) ? removed : []).map((entry) => entry?.id).filter(Boolean));
  const lastAckedAt = new Date().toISOString();
  for (const entry of batch.tasks) {
    if (ackById.get(entry.task.id) !== entry.hash) continue;
    cache.tasks[entry.task.id] = { hash: entry.hash, lastAckedAt };
  }
  for (const taskId of batch.removedTaskIds ?? []) {
    if (removedIds.has(taskId)) delete cache.tasks[taskId];
  }
}

function createRuntimeTaskBatches(entries, options) {
  const orderedEntries = [...entries].sort((left, right) => compareTasksBySyncOrder(left.task, right.task));
  const batches = [];
  let current = [];
  for (const entry of orderedEntries) {
    const next = [...current, entry];
    if (
      current.length > 0 &&
      (next.length > options.batchMaxTasks || byteLength(taskBatchDraft(options, batches.length, next)) > options.batchMaxBytes)
    ) {
      batches.push(finalizeTaskBatch(options, batches.length, current));
      current = [entry];
    } else {
      current = next;
    }
  }
  if (current.length > 0) batches.push(finalizeTaskBatch(options, batches.length, current));
  return batches.map((batch) => ({ ...batch, batchCount: batches.length }));
}

function createRuntimeTaskRemovalBatches(removedTaskIds, options) {
  const orderedIds = [...new Set(removedTaskIds.map((id) => String(id).trim()).filter(Boolean))].sort();
  const batches = [];
  let current = [];
  for (const taskId of orderedIds) {
    const next = [...current, taskId];
    if (
      current.length > 0 &&
      (next.length > options.batchMaxTasks || byteLength(taskBatchDraft(options, batches.length, [], next)) > options.batchMaxBytes)
    ) {
      batches.push(finalizeTaskBatch(options, batches.length, [], current));
      current = [taskId];
    } else {
      current = next;
    }
  }
  if (current.length > 0) batches.push(finalizeTaskBatch(options, batches.length, [], current));
  return batches.map((batch) => ({ ...batch, batchCount: batches.length }));
}

function sequenceRuntimeTaskBatches(batches, options) {
  return batches
    .map((batch, index) => finalizeTaskBatch(options, index, batch.tasks, batch.removedTaskIds))
    .map((batch, _index, all) => ({ ...batch, batchCount: all.length }));
}

function finalizeTaskBatch(options, batchIndex, tasks, removedTaskIds = []) {
  const draft = taskBatchDraft(options, batchIndex, tasks, removedTaskIds);
  return {
    ...draft,
    batchId: createBatchId(options, batchIndex, tasks, removedTaskIds),
  };
}

function taskBatchDraft(options, batchIndex, tasks, removedTaskIds = []) {
  return {
    batchCount: 0,
    batchId: "",
    batchIndex,
    collectedAt: options.collectedAt,
    deviceId: options.deviceId,
    removedTaskIds,
    schemaVersion: TASK_SYNC_SCHEMA_VERSION,
    tasks,
  };
}

function createBatchId(options, batchIndex, tasks, removedTaskIds = []) {
  return hashStableJson({
    batchIndex,
    collectedAt: options.collectedAt,
    deviceId: options.deviceId,
    removedTaskIds,
    tasks: tasks.map((entry) => ({ hash: entry.hash, id: entry.task.id })),
  });
}

function createRuntimeTaskHash(task) {
  return hashStableJson({
    agentId: task.agentId,
    agentReply: normalizeTaskHashText(task.agentReply),
    assignee: stableObjectOrNull(task.assignee),
    channel: stableObjectOrNull(task.channel),
    conversation: stableObjectOrNull(task.conversation),
    createdAt: task.createdAt ?? null,
    creator: stableObjectOrNull(task.creator),
    error: normalizeTaskHashText(task.error),
    hashVersion: 1,
    id: task.id,
    source: stableObjectOrNull(task.source),
    status: task.status,
    taskType: task.taskType,
    updatedAt: task.updatedAt ?? null,
    userMessage: normalizeTaskHashText(task.userMessage),
  });
}

function normalizeTaskHashText(value) {
  const text = value?.replace(/\r\n/g, "\n").trim();
  return text ? text : null;
}

function compareTasksBySyncOrder(left, right) {
  const rightTime = taskSyncTimestamp(right);
  const leftTime = taskSyncTimestamp(left);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return String(left.id).localeCompare(String(right.id));
}

function taskSyncTimestamp(task) {
  for (const value of [task.updatedAt, task.createdAt]) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function stableObjectOrNull(value) {
  if (!value || typeof value !== "object") return null;
  return stableValue(value);
}

function hashStableJson(value) {
  return fnv1a64(JSON.stringify(stableValue(value)));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) output[key] = stableValue(child);
  }
  return output;
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runOnce(config, args) {
  const logger = createCollectorLogger(config);
  const snapshot = collectSnapshot(config, args);
  logger.info({
    event: "device_state_collected",
    deviceId: snapshot.device.id,
    counts: {
      runtimes: snapshot.runtimes?.length ?? 0,
      agents: snapshot.agents?.length ?? 0,
      tasks: snapshot.tasks?.length ?? 0,
    },
  });
  const serverUrl = args.serverUrl || config.serverUrl || "";
  if (serverUrl && !args.printOnly) {
    const deviceToken = resolveDeviceToken(config, args);
    await postSnapshot(serverUrl, metadataSnapshot(snapshot), deviceToken);
    await postChangedTaskBatches(serverUrl, snapshot, config, deviceToken, logger);
    logger.info({
      event: "device_state_upload_succeeded",
      deviceId: snapshot.device.id,
      counts: {
        runtimes: snapshot.runtimes?.length ?? 0,
        agents: snapshot.agents?.length ?? 0,
        tasks: snapshot.tasks?.length ?? 0,
      },
    });
  }
  if (args.printOnly || !serverUrl) console.log(JSON.stringify(snapshot, null, 2));
  return snapshot;
}

function resolveCliDeviceIdentity(config, args) {
  if (args.deviceId || config.deviceId) {
    return {
      deviceId: args.deviceId || config.deviceId || "",
    };
  }
  if (args.fixturePath) {
    try {
      const device = readJsonFile(args.fixturePath)?.device;
      return {
        deviceId: typeof device?.id === "string" ? device.id : "",
      };
    } catch {
      return { deviceId: "" };
    }
  }
  return { deviceId: "" };
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

async function refreshSnapshots(config, args) {
  const deviceStateSnapshot = await runOnce(config, args);
  return { deviceStateSnapshot };
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
    hostname: device.hostname,
    collectorVersion: COLLECTOR_VERSION,
  };
}

function mergedControlConfig(config, args) {
  return {
    ...config,
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
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
