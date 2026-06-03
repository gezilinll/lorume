#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, hostname, arch, platform, networkInterfaces, userInfo } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { normalizeLocalIpsForDisplay } from "./local-ip-normalization.mjs";

const COLLECTOR_VERSION = "0.1.4";
const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_COLLECTION_TIMEOUT_MS = 240_000;
const DEFAULT_PROBE_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const POST_RETRY_DELAYS_MS = [0, 500, 1500];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LORUME_CLI_PATH = path.join(SCRIPT_DIR, "lorume.mjs");
const DEFAULT_COLLECTOR_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOCK_STALE_GRACE_MS = 60_000;
const DEFAULT_TASK_BATCH_MAX_BYTES = 512 * 1024;
const DEFAULT_TASK_BATCH_MAX_TASKS = 1000;
const TASK_SYNC_SCHEMA_VERSION = "device-state-v3";
const UPGRADE_PROTOCOL_VERSION = 1;
const ANALYSIS_PROTOCOL_VERSION = 1;
const FNM_MULTISHELL_SEARCH_LIMIT = 8;
const COLLECTOR_PACKAGE_FILES = new Map([
  ["lorume-device-collector.mjs", "0755"],
  ["lorume-runtime-adapters.mjs", "0644"],
  ["local-ip-normalization.mjs", "0644"],
  ["lorume.mjs", "0755"],
]);
const agentAnalysisJobsInFlight = new Set();
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

function resolveCollectionTimeoutMs(config = {}) {
  const value = Number(process.env.LORUME_COLLECTION_TIMEOUT_MS || config.collectionTimeoutMs || DEFAULT_COLLECTION_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_COLLECTION_TIMEOUT_MS;
}

function resolveCollectorLockPath(config = {}) {
  return process.env.LORUME_COLLECTOR_LOCK_PATH ||
    config.collectorLockPath ||
    path.join(homeDir(), ".lorume", "collector", "run.lock");
}

function resolveCollectorLockStaleMs(config = {}) {
  const explicit = Number(process.env.LORUME_COLLECTOR_LOCK_STALE_MS || config.collectorLockStaleMs || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  return resolveCollectionTimeoutMs(config) + DEFAULT_LOCK_STALE_GRACE_MS;
}

function createRunId() {
  return `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
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

function acquireCollectorRunLock(config, runId, mode) {
  const lockPath = resolveCollectorLockPath(config);
  const staleAfterMs = resolveCollectorLockStaleMs(config);
  mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      const lock = {
        collectorVersion: COLLECTOR_VERSION,
        mode,
        pid: process.pid,
        runId,
        startedAt: isoNow(),
      };
      writeFileSync(fd, `${JSON.stringify(lock)}\n`, "utf8");
      closeSync(fd);
      return { acquired: true, lockPath, runId };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readCollectorRunLock(lockPath);
      if (shouldReclaimCollectorRunLock(existing, staleAfterMs)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // Another process may have released or replaced the lock. Retry once.
          continue;
        }
      }
      return { acquired: false, existing, lockPath, runId };
    }
  }

  return { acquired: false, existing: readCollectorRunLock(lockPath), lockPath, runId };
}

function readCollectorRunLock(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function shouldReclaimCollectorRunLock(lock, staleAfterMs) {
  const pid = Number(lock?.pid);
  const startedAt = Date.parse(String(lock?.startedAt || ""));
  const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(pid) || pid <= 0) return true;
  if (ageMs > staleAfterMs) return true;
  return !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseCollectorRunLock(lock) {
  if (!lock?.acquired) return;
  try {
    const current = readCollectorRunLock(lock.lockPath);
    if (current?.runId === lock.runId && Number(current?.pid) === process.pid) unlinkSync(lock.lockPath);
  } catch {
    // Best effort: stale-lock recovery handles abandoned locks on later runs.
  }
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
  const localEntries = [];
  for (const interfaceEntries of Object.values(networkInterfaces())) {
    for (const entry of interfaceEntries ?? []) {
      localEntries.push(entry);
    }
  }
  return normalizeLocalIpsForDisplay(localEntries);
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

async function collectSnapshot(config, args) {
  return collectSnapshotViaLorumeCli(config, args);
}

async function collectSnapshotViaLorumeCli(config, args) {
  const cliArgs = ["collect", "device-state", "--json"];
  if (args.configPath) cliArgs.push("--config", args.configPath);
  if (args.fixturePath) cliArgs.push("--snapshot", args.fixturePath);
  const identity = resolveCliDeviceIdentity(config, args);
  if (identity.deviceId) cliArgs.push("--device-id", identity.deviceId);
  return stripCliCommand(await runLorumeCliJson(config, cliArgs));
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

async function postRuntimeSkillProbeSnapshot(serverUrl, snapshot, deviceToken = "") {
  const url = new URL("/api/runtime-skill-probe-snapshots", serverUrl);
  return postJsonWithRetry(url, snapshot, "Runtime Skill probe snapshot", deviceToken);
}

async function postRuntimeScheduleProbeSnapshot(serverUrl, snapshot, deviceToken = "") {
  const url = new URL("/api/runtime-schedule-probe-snapshots", serverUrl);
  return postJsonWithRetry(url, snapshot, "Runtime schedule probe snapshot", deviceToken);
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
  const { runtimeScheduleProbes: _runtimeScheduleProbes, runtimeSkillProbes: _runtimeSkillProbes, ...metadata } = snapshot;
  return {
    ...metadata,
    tasks: [],
  };
}

async function postRuntimeSkillProbes(serverUrl, snapshot, deviceToken, logger) {
  const runtimeSkillProbes = Array.isArray(snapshot.runtimeSkillProbes) ? snapshot.runtimeSkillProbes : [];
  for (const runtimeSkillProbe of runtimeSkillProbes) {
    await postRuntimeSkillProbeSnapshot(serverUrl, runtimeSkillProbe, deviceToken);
  }
  if (runtimeSkillProbes.length > 0) {
    logger.info({
      deviceId: snapshot.device.id,
      event: "runtime_skill_probe_upload_succeeded",
      runtimeSkillProbes: runtimeSkillProbes.length,
    });
  }
  return { runtimeSkillProbeCount: runtimeSkillProbes.length };
}

async function postRuntimeScheduleProbes(serverUrl, snapshot, deviceToken, logger) {
  const runtimeScheduleProbes = Array.isArray(snapshot.runtimeScheduleProbes) ? snapshot.runtimeScheduleProbes : [];
  for (const runtimeScheduleProbe of runtimeScheduleProbes) {
    await postRuntimeScheduleProbeSnapshot(serverUrl, runtimeScheduleProbe, deviceToken);
  }
  if (runtimeScheduleProbes.length > 0) {
    logger.info({
      deviceId: snapshot.device.id,
      event: "runtime_schedule_probe_upload_succeeded",
      runtimeScheduleProbes: runtimeScheduleProbes.length,
    });
  }
  return { runtimeScheduleProbeCount: runtimeScheduleProbes.length };
}

async function postChangedTaskBatches(serverUrl, snapshot, config, deviceToken, logger) {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const cachePath = resolveTaskSyncCachePath(config);
  const cacheScope = createTaskSyncCacheScope(serverUrl, snapshot.device.id, deviceToken);
  const cache = readTaskSyncCache(cachePath, cacheScope);
  const currentTaskIds = new Set(tasks.map((task) => String(task.id || "")).filter(Boolean));
  const currentAdapterKinds = taskAdapterKinds(tasks);
  const removedTaskIds = canTrustTaskPresence(snapshot)
    ? Object.entries(cache.tasks)
      .filter(([taskId, entry]) => !currentTaskIds.has(taskId) && cacheEntryCoveredByCurrentAdapters(entry, currentAdapterKinds))
      .map(([taskId]) => taskId)
    : [];
  const entries = tasks
    .map((task) => ({ task, hash: createRuntimeTaskHash(task) }))
    .filter((entry) => cache.tasks[entry.task.id]?.hash !== entry.hash);
  if (entries.length === 0 && removedTaskIds.length === 0) {
    logger.info({ deviceId: snapshot.device.id, event: "task_batch_upload_skipped", tasks: tasks.length }, "No changed tasks to upload.");
    return { batchCount: 0, changedTaskCount: 0, removedTaskCount: 0 };
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
  return { batchCount: batches.length, changedTaskCount: entries.length, removedTaskCount: removedTaskIds.length };
}

function canTrustTaskPresence(snapshot) {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  if (tasks.length > 0) return true;
  const runtimes = Array.isArray(snapshot.runtimes) ? snapshot.runtimes : [];
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  return runtimes.some((runtime) => runtime?.collectionStatus === "online") &&
    agents.some((agent) => agent?.collectionStatus === "online");
}

function taskAdapterKinds(tasks) {
  return new Set(tasks.map(taskAdapterKind).filter(Boolean));
}

function taskAdapterKind(task) {
  const kind = task?.adapter?.kind;
  return typeof kind === "string" && kind.trim() ? kind.trim() : "";
}

function cacheEntryCoveredByCurrentAdapters(entry, currentAdapterKinds) {
  if (currentAdapterKinds.size === 0) return false;
  const adapterKind = typeof entry?.adapterKind === "string" ? entry.adapterKind.trim() : "";
  return adapterKind ? currentAdapterKinds.has(adapterKind) : false;
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
    cache.tasks[entry.task.id] = { adapterKind: taskAdapterKind(entry.task), hash: entry.hash, lastAckedAt };
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
    adapter: stableObjectOrNull(task.adapter),
    assignee: stableObjectOrNull(task.assignee),
    channel: stableObjectOrNull(task.channel),
    conversation: stableObjectOrNull(task.conversation),
    createdAt: task.createdAt ?? null,
    creator: stableObjectOrNull(task.creator),
    error: normalizeTaskHashText(task.error),
    hashVersion: 1,
    id: task.id,
    ...(task.raw?.openclaw?.scheduleId || task.raw?.openclaw?.scheduleName
      ? {
        openclawSchedule: {
          scheduleId: task.raw.openclaw.scheduleId ?? null,
          scheduleName: task.raw.openclaw.scheduleName ?? null,
        },
      }
      : {}),
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

async function runOnce(config, args, mode = "once") {
  const logger = createCollectorLogger(config);
  const runId = createRunId();
  const lock = acquireCollectorRunLock(config, runId, mode);
  if (!lock.acquired) {
    logger.info({
      event: "collector_run_skipped",
      existingRunId: lock.existing?.runId,
      existingStartedAt: lock.existing?.startedAt,
      reason: "collector_run_in_progress",
      runId,
    }, "Collector run skipped because another run is in progress.");
    return undefined;
  }

  const startedAt = Date.now();
  const metrics = {
    batchCount: 0,
    changedTaskCount: 0,
    cliDurationMs: 0,
    metadataPostDurationMs: 0,
    removedTaskCount: 0,
    taskBatchPostDurationMs: 0,
    taskCount: 0,
  };
  logger.info({
    collectionTimeoutMs: resolveCollectionTimeoutMs(config),
    event: "collector_run_started",
    mode,
    runId,
  });
  try {
    const cliStartedAt = Date.now();
    const snapshot = await collectSnapshot(config, args);
    metrics.cliDurationMs = Date.now() - cliStartedAt;
    metrics.taskCount = Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0;

  logger.info({
    event: "device_state_collected",
    deviceId: snapshot.device.id,
    counts: {
      runtimes: snapshot.runtimes?.length ?? 0,
      agents: snapshot.agents?.length ?? 0,
      tasks: snapshot.tasks?.length ?? 0,
      runtimeSkillProbes: snapshot.runtimeSkillProbes?.length ?? 0,
      runtimeScheduleProbes: snapshot.runtimeScheduleProbes?.length ?? 0,
    },
  });
  const serverUrl = args.serverUrl || config.serverUrl || "";
  if (serverUrl && !args.printOnly) {
    const deviceToken = resolveDeviceToken(config, args);
    const metadataPostStartedAt = Date.now();
    await postSnapshot(serverUrl, metadataSnapshot(snapshot), deviceToken);
    metrics.metadataPostDurationMs = Date.now() - metadataPostStartedAt;
    await postRuntimeSkillProbes(serverUrl, snapshot, deviceToken, logger);
    await postRuntimeScheduleProbes(serverUrl, snapshot, deviceToken, logger);
    const taskBatchPostStartedAt = Date.now();
    const taskBatchStats = await postChangedTaskBatches(serverUrl, snapshot, config, deviceToken, logger);
    metrics.taskBatchPostDurationMs = Date.now() - taskBatchPostStartedAt;
    metrics.batchCount = taskBatchStats.batchCount;
    metrics.changedTaskCount = taskBatchStats.changedTaskCount;
    metrics.removedTaskCount = taskBatchStats.removedTaskCount;
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
  logger.info({
    ...metrics,
    deviceId: snapshot.device.id,
    event: "collector_run_finished",
    runId,
    totalDurationMs: Date.now() - startedAt,
  });
  return snapshot;
  } catch (error) {
    logger.error({
      durationMs: Date.now() - startedAt,
      errorCode: collectorErrorCode(error),
      event: "collector_run_failed",
      runId,
    }, collectorErrorMessage(error));
    throw error;
  } finally {
    releaseCollectorRunLock(lock);
  }
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
  const timeoutMs = resolveCollectionTimeoutMs(config);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let killTimer;

    const settle = (fn, value, options = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer && !options.keepKillTimer) clearTimeout(killTimer);
      fn(value);
    };

    const failAndKill = (error) => {
      if (settled) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 500);
      settle(reject, error, { keepKillTimer: true });
    };

    const timeoutTimer = setTimeout(() => {
      failAndKill(new Error(`lorume CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > DEFAULT_PROBE_MAX_BUFFER_BYTES) {
        failAndKill(new Error("lorume CLI output exceeded maximum buffer size"));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > DEFAULT_PROBE_MAX_BUFFER_BYTES) {
        failAndKill(new Error("lorume CLI output exceeded maximum buffer size"));
        return;
      }
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(reject, error);
    });
    child.on("close", (status) => {
      if (settled) return;
      if (status !== 0) {
        settle(reject, new Error(stderr.trim() || `lorume CLI failed with exit code ${status}`));
        return;
      }
      try {
        settle(resolve, JSON.parse(stdout));
      } catch {
        settle(reject, new Error("lorume CLI returned non-JSON output"));
      }
    });
  });
}

function stripCliCommand(value) {
  if (!value || typeof value !== "object") return value;
  const { command: _command, ...snapshot } = value;
  return snapshot;
}

async function refreshSnapshots(config, args) {
  const deviceStateSnapshot = await runOnce(config, args, "service");
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

function resolveCollectorInstallDir(config = {}) {
  return path.resolve(config.installDir || SCRIPT_DIR);
}

function resolveUpgradeStatePath(config = {}) {
  return path.join(resolveCollectorInstallDir(config), "upgrade-state.json");
}

function readUpgradeState(config = {}) {
  try {
    const parsed = JSON.parse(readFileSync(resolveUpgradeStatePath(config), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeUpgradeState(config, state) {
  const statePath = resolveUpgradeStatePath(config);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(redactCollectorLogFields(state), null, 2)}\n`, "utf8");
}

function collectorUpgradeCapability(config) {
  const state = readUpgradeState(config);
  return {
    supported: true,
    protocolVersion: UPGRADE_PROTOCOL_VERSION,
    installPath: resolveCollectorInstallDir(config),
    ...(typeof state.jobId === "string" ? { lastUpgradeJobId: state.jobId } : {}),
    ...(state.stage === "succeeded" || state.stage === "failed" || state.stage === "rolled_back"
      ? { lastUpgradeStatus: state.stage }
      : {}),
  };
}

function collectorAnalysisCapability() {
  return {
    supported: true,
    protocolVersion: ANALYSIS_PROTOCOL_VERSION,
    runtimes: ["openclaw"],
    promptKinds: ["daily_operation_review"],
  };
}

function sendControlMessage(socket, message) {
  if (!isControlSocketOpen(socket)) return;
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
    upgrade: collectorUpgradeCapability(config),
    analysis: collectorAnalysisCapability(),
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

function sendCollectorUpgradeProgress(socket, request, stage, status, message, extra = {}) {
  sendControlMessage(socket, {
    type: "collector.upgrade.progress",
    protocolVersion: UPGRADE_PROTOCOL_VERSION,
    operationId: request.operationId,
    jobId: request.jobId,
    deviceId: request.deviceId,
    nonce: request.nonce,
    stage,
    status,
    currentVersion: COLLECTOR_VERSION,
    targetVersion: request.targetVersion,
    message,
    observedAt: isoNow(),
    ...extra,
  });
}

function sendAgentAnalysisProgress(socket, request, stage, status, message, extra = {}) {
  sendControlMessage(socket, {
    type: "agent.analysis.progress",
    protocolVersion: ANALYSIS_PROTOCOL_VERSION,
    operationId: request.operationId,
    jobId: request.jobId,
    deviceId: request.deviceId,
    nonce: request.nonce,
    stage,
    status,
    message,
    observedAt: isoNow(),
    ...extra,
  });
}

function sendAgentAnalysisResult(socket, request, status, extra = {}) {
  sendControlMessage(socket, {
    type: "agent.analysis.result",
    protocolVersion: ANALYSIS_PROTOCOL_VERSION,
    operationId: request.operationId,
    jobId: request.jobId,
    deviceId: request.deviceId,
    nonce: request.nonce,
    status,
    observedAt: isoNow(),
    ...extra,
  });
}

async function handleControlMessage(socket, rawMessage, config, args, logger) {
  let message;
  try {
    message = JSON.parse(await controlMessageDataToText(rawMessage));
  } catch {
    return;
  }
  if (message?.type === "agent.analysis.request") {
    let request;
    try {
      request = normalizeAgentAnalysisRequest(message, config, args);
      if (!request) {
        sendAgentAnalysisResult(socket, fallbackAgentAnalysisRequest(message, config, args), "unsupported", {
          errorCode: "agent_analysis_unsupported",
          message: "Unsupported agent analysis request",
        });
        return;
      }
      await performAgentAnalysis(socket, request, logger);
    } catch (error) {
      const fallbackRequest = request || fallbackAgentAnalysisRequest(message, config, args);
      sendAgentAnalysisProgress(socket, fallbackRequest, "failed", "failed", collectorErrorMessage(error));
      sendAgentAnalysisResult(socket, fallbackRequest, "failed", {
        errorCode: "agent_analysis_failed",
        message: collectorErrorMessage(error),
      });
      logger.warn({
        errorCode: "agent_analysis_failed",
        event: "agent_analysis_failed",
        jobId: fallbackRequest.jobId,
        operationId: fallbackRequest.operationId,
      }, collectorErrorMessage(error));
    }
    return;
  }
  if (message?.type !== "collector.upgrade.request") return;
  try {
    await performCollectorUpgrade(socket, message, config, args, logger);
  } catch (error) {
    const request = normalizeCollectorUpgradeRequest(message, config, args);
    if (request) {
      sendCollectorUpgradeProgress(socket, request, "failed", "failed", collectorErrorMessage(error));
      writeUpgradeState(config, {
        operationId: request.operationId,
        jobId: request.jobId,
        deviceId: request.deviceId,
        nonce: request.nonce,
        targetVersion: request.targetVersion,
        stage: "failed",
        status: "failed",
        errorSummary: collectorErrorMessage(error),
        updatedAt: isoNow(),
      });
    }
    logger.warn({
      errorCode: "collector_upgrade_failed",
      event: "collector_upgrade_failed",
      jobId: request?.jobId,
      operationId: request?.operationId,
    }, collectorErrorMessage(error));
  }
}

async function performAgentAnalysis(socket, request, logger) {
  if (agentAnalysisJobsInFlight.has(request.jobId)) {
    sendAgentAnalysisProgress(socket, request, "executing", "running", "Agent analysis already running");
    return;
  }
  agentAnalysisJobsInFlight.add(request.jobId);
  try {
    sendAgentAnalysisProgress(socket, request, "accepted", "running", "Collector accepted Agent analysis request");
    sendAgentAnalysisProgress(socket, request, "executing", "running", "Running OpenClaw Agent analysis");
    const result = await runOpenClawAgentAnalysis(request);
    sendAgentAnalysisProgress(socket, request, "result_received", "running", "OpenClaw Agent analysis returned result");
    sendAgentAnalysisResult(socket, request, "succeeded", result);
    logger.info({
      event: "agent_analysis_succeeded",
      jobId: request.jobId,
      operationId: request.operationId,
      runtimeRunId: result.runtimeRunId,
    }, "Agent analysis completed.");
  } finally {
    agentAnalysisJobsInFlight.delete(request.jobId);
  }
}

function normalizeAgentAnalysisRequest(message, config, args) {
  if (message?.protocolVersion !== ANALYSIS_PROTOCOL_VERSION) return null;
  const device = createControlDevice(config, args, isoNow());
  if (message.deviceId !== device.id) return null;
  if (message.openclawAgentId !== "main") return null;
  if (message.promptKind !== "daily_operation_review") return null;
  if (message.promptVersion !== "openclaw-agent-analysis-v1") return null;
  if (typeof message.runtimeId !== "string" || !message.runtimeId.includes(":runtime:openclaw")) return null;
  if (!isNonEmptyString(message.operationId) || !isNonEmptyString(message.jobId)) return null;
  if (!isNonEmptyString(message.agentId) || !isNonEmptyString(message.prompt)) return null;
  if (!isNonEmptyString(message.periodStart) || !isNonEmptyString(message.periodEnd)) return null;
  if (!isNonEmptyString(message.deadlineAt) || Date.parse(message.deadlineAt) <= Date.now()) return null;
  if (!isNonEmptyString(message.nonce)) return null;
  const timeoutSeconds = Number(message.timeoutSeconds);
  return {
    agentId: message.agentId,
    deadlineAt: message.deadlineAt,
    deviceId: message.deviceId,
    jobId: message.jobId,
    nonce: message.nonce,
    openclawAgentId: "main",
    operationId: message.operationId,
    periodEnd: message.periodEnd,
    periodStart: message.periodStart,
    prompt: message.prompt,
    promptKind: "daily_operation_review",
    promptVersion: "openclaw-agent-analysis-v1",
    runtimeId: message.runtimeId,
    timeoutSeconds: Number.isFinite(timeoutSeconds) ? Math.max(1, Math.min(600, Math.trunc(timeoutSeconds))) : 120,
  };
}

function fallbackAgentAnalysisRequest(message, config, args) {
  const device = createControlDevice(config, args, isoNow());
  return {
    deviceId: typeof message?.deviceId === "string" ? message.deviceId : device.id,
    jobId: typeof message?.jobId === "string" ? message.jobId : "unknown",
    nonce: typeof message?.nonce === "string" ? message.nonce : "unknown",
    operationId: typeof message?.operationId === "string" ? message.operationId : "unknown",
  };
}

async function runOpenClawAgentAnalysis(request) {
  const executable = resolveExecutableFromPath("openclaw");
  const args = [
    "agent",
    "--agent",
    "main",
    "--session-id",
    `lorume-analysis-${request.jobId}`,
    "--message",
    request.prompt,
    "--json",
    "--thinking",
    "off",
    "--timeout",
    String(request.timeoutSeconds),
  ];
  const output = await spawnForJson(executable, args, request.timeoutSeconds * 1000);
  const parsed = parseJson(output.stdout, "openclaw stdout was not JSON");
  const analysisText = readOpenClawPayloadText(parsed);
  if (typeof analysisText !== "string" || !analysisText.trim()) {
    throw new Error("openclaw result missing payload text");
  }
  const analysis = parseJson(analysisText, "openclaw payload text was not JSON");
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    throw new Error("openclaw payload text must contain an analysis object");
  }
  return {
    analysis,
    ...(readString(parsed.runId) || readString(parsed.runtimeRunId) ? { runtimeRunId: readString(parsed.runId) || readString(parsed.runtimeRunId) } : {}),
    ...(readOpenClawDurationMs(parsed) !== undefined ? { durationMs: readOpenClawDurationMs(parsed) } : {}),
    modelMetadata: whitelistOpenClawModelMetadata(parsed),
  };
}

function spawnForJson(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: commandExecutionEnv(command),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("openclaw analysis timed out"));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `openclaw exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJson(value, errorMessage) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    throw new Error(errorMessage);
  }
}

function readOpenClawPayloadText(parsed) {
  const payloads = Array.isArray(parsed?.result?.payloads) ? parsed.result.payloads : parsed?.payloads;
  const text = Array.isArray(payloads) ? payloads[0]?.text : undefined;
  return typeof text === "string" ? text : undefined;
}

function readOpenClawDurationMs(parsed) {
  return readNumber(parsed?.result?.meta?.durationMs) ?? readNumber(parsed?.durationMs);
}

function whitelistOpenClawModelMetadata(parsed) {
  const source = [
    parsed?.modelMetadata,
    parsed?.result?.meta?.agentMeta,
    parsed?.result?.meta,
    parsed,
  ].find((candidate) => candidate && typeof candidate === "object") || {};
  const usageSource = source.usage && typeof source.usage === "object"
    ? source.usage
    : parsed?.usage;
  const usage = usageSource && typeof usageSource === "object"
    ? {
      ...(readNumber(usageSource.input) !== undefined ? { input: readNumber(usageSource.input) } : {}),
      ...(readNumber(usageSource.output) !== undefined ? { output: readNumber(usageSource.output) } : {}),
      ...(readNumber(usageSource.cacheRead) !== undefined ? { cacheRead: readNumber(usageSource.cacheRead) } : {}),
      ...(readNumber(usageSource.total) !== undefined ? { total: readNumber(usageSource.total) } : {}),
    }
    : {};
  return {
    ...(readString(source.provider) ? { provider: readString(source.provider) } : {}),
    ...(readString(source.model) ? { model: readString(source.model) } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}

function resolveExecutableFromPath(command) {
  for (const entry of commandSearchDirs({ includeDynamicShimDirs: true })) {
    const candidate = path.join(entry, command);
    try {
      const stats = statSync(candidate);
      if (stats.isFile() && (stats.mode & 0o111)) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return command;
}

function commandExecutionEnv(executable) {
  const executableDir = path.isAbsolute(executable) ? path.dirname(executable) : "";
  return {
    ...process.env,
    PATH: [...new Set([
      ...(executableDir ? [executableDir] : []),
      path.dirname(process.execPath),
      ...commandSearchDirs({ includeDynamicShimDirs: true }),
    ])].join(path.delimiter),
  };
}

function commandSearchDirs({ includeDynamicShimDirs = false } = {}) {
  const dirs = [];
  dirs.push(...String(process.env.PATH || "").split(path.delimiter).filter(Boolean));
  dirs.push(path.join(homeDir(), ".local", "bin"));
  dirs.push(path.join(homeDir(), ".npm-global", "bin"));
  dirs.push(path.join(homeDir(), ".volta", "bin"));

  const fnmRoot = path.join(homeDir(), ".local", "share", "fnm", "node-versions");
  try {
    for (const version of readdirSync(fnmRoot)) {
      dirs.push(path.join(fnmRoot, version, "installation", "bin"));
    }
  } catch {
    // Ignore missing fnm installs.
  }

  if (includeDynamicShimDirs) dirs.push(...recentFnmMultishellBinDirs());

  dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin");
  dirs.push("/usr/bin");
  dirs.push("/bin");
  dirs.push("/usr/sbin");
  dirs.push("/sbin");
  return [...new Set(dirs)];
}

function recentFnmMultishellBinDirs() {
  const root = path.join(homeDir(), ".local", "state", "fnm_multishells");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sortKey: fnmMultishellSortKey(entry.name),
    }))
    .sort(compareFnmSessions)
    .slice(0, FNM_MULTISHELL_SEARCH_LIMIT)
    .map((entry) => path.join(root, entry.name, "bin"))
    .filter((binDir) => {
      try {
        return statSync(binDir).isDirectory();
      } catch {
        return false;
      }
    });
}

function fnmMultishellSortKey(session) {
  const match = /(?:^|_)(\d{10,})$/.exec(String(session || ""));
  return match ? Number(match[1]) : 0;
}

function compareFnmSessions(left, right) {
  const keyDelta = right.sortKey - left.sortKey;
  if (keyDelta !== 0) return keyDelta;
  return right.name.localeCompare(left.name);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function controlMessageDataToText(rawMessage) {
  if (typeof rawMessage === "string") return rawMessage;
  if (Buffer.isBuffer(rawMessage)) return rawMessage.toString("utf8");
  if (rawMessage instanceof ArrayBuffer) return Buffer.from(rawMessage).toString("utf8");
  if (ArrayBuffer.isView(rawMessage)) {
    return Buffer.from(rawMessage.buffer, rawMessage.byteOffset, rawMessage.byteLength).toString("utf8");
  }
  if (typeof rawMessage?.text === "function") return rawMessage.text();
  return String(rawMessage);
}

async function performCollectorUpgrade(socket, message, config, args, logger) {
  const request = normalizeCollectorUpgradeRequest(message, config, args);
  if (!request) throw new Error("invalid collector upgrade request");
  if (compareCollectorVersions(COLLECTOR_VERSION, request.targetVersion) === 0) {
    sendCollectorUpgradeProgress(socket, request, "succeeded", "succeeded", "Collector already at target version", {
      collectorVersion: COLLECTOR_VERSION,
    });
    return;
  }
  if (compareCollectorVersions(COLLECTOR_VERSION, request.targetVersion) > 0) {
    throw new Error("collector downgrade is not supported");
  }

  const lock = await acquireCollectorUpgradeRunLock(config, createRunId());
  if (!lock.acquired) {
    sendCollectorUpgradeProgress(socket, request, "failed", "requires_manual_step", "Collector is busy; retry upgrade after current collection finishes.");
    return;
  }

  const installDir = resolveCollectorInstallDir(config);
  const upgradeDir = path.join(installDir, ".upgrade", request.jobId);
  const backupDir = path.join(installDir, ".previous", request.jobId);
  try {
    writeUpgradeState(config, {
      operationId: request.operationId,
      jobId: request.jobId,
      deviceId: request.deviceId,
      nonce: request.nonce,
      targetVersion: request.targetVersion,
      stage: "acknowledged",
      status: "running",
      startedAt: isoNow(),
    });
    sendCollectorUpgradeProgress(socket, request, "acknowledged", "running", "Collector accepted upgrade request");
    sendCollectorUpgradeProgress(socket, request, "downloading", "running", "Downloading collector package manifest");
    const manifest = normalizeCollectorPackageManifest(await fetchJson(request.manifestUrl));
    if (!manifest) throw new Error("invalid collector package manifest");
    if (manifest.version !== request.targetVersion) throw new Error("collector package manifest version mismatch");

    rmSync(upgradeDir, { force: true, recursive: true });
    mkdirSync(upgradeDir, { recursive: true });
    sendCollectorUpgradeProgress(socket, request, "verifying", "running", "Verifying collector package manifest");
    for (const file of manifest.files) {
      const body = await fetchArrayBuffer(new URL(encodeURIComponent(file.fileName), `${request.packageBaseUrl.replace(/\/+$/g, "")}/`).toString());
      verifyCollectorPackageFile(file, body);
      writeFileSync(path.join(upgradeDir, file.fileName), Buffer.from(body));
    }

    sendCollectorUpgradeProgress(socket, request, "installing", "running", "Installing collector package");
    mkdirSync(backupDir, { recursive: true });
    for (const file of manifest.files) {
      const destinationPath = path.join(installDir, file.fileName);
      if (existsSync(destinationPath)) copyFileSync(destinationPath, path.join(backupDir, file.fileName));
    }
    for (const file of manifest.files) {
      const stagedPath = path.join(upgradeDir, file.fileName);
      const destinationPath = path.join(installDir, file.fileName);
      renameSync(stagedPath, destinationPath);
      chmodSync(destinationPath, file.mode === "0755" ? 0o755 : 0o644);
    }

    writeUpgradeState(config, {
      operationId: request.operationId,
      jobId: request.jobId,
      deviceId: request.deviceId,
      nonce: request.nonce,
      targetVersion: request.targetVersion,
      stage: "restart_pending",
      status: "running",
      updatedAt: isoNow(),
    });
    logger.info({
      event: "collector_upgrade_restart_pending",
      jobId: request.jobId,
      operationId: request.operationId,
      targetVersion: request.targetVersion,
    }, "Collector upgrade installed; exiting for service restart.");
    sendCollectorUpgradeProgress(socket, request, "restart_pending", "running", "Collector package installed; restarting collector");
    setTimeout(() => process.exit(0), 25);
  } catch (error) {
    rollbackCollectorUpgrade(installDir, backupDir);
    writeUpgradeState(config, {
      operationId: request.operationId,
      jobId: request.jobId,
      deviceId: request.deviceId,
      nonce: request.nonce,
      targetVersion: request.targetVersion,
      stage: "failed",
      status: "failed",
      errorSummary: collectorErrorMessage(error),
      updatedAt: isoNow(),
    });
    throw error;
  } finally {
    releaseCollectorRunLock(lock);
  }
}

async function acquireCollectorUpgradeRunLock(config, runId) {
  const deadline = Date.now() + 2_000;
  let lock = acquireCollectorRunLock(config, runId, "upgrade");
  while (!lock.acquired && Date.now() < deadline) {
    await sleep(50);
    lock = acquireCollectorRunLock(config, runId, "upgrade");
  }
  return lock;
}

function normalizeCollectorUpgradeRequest(message, config, args) {
  if (!message || typeof message !== "object") return null;
  const device = createControlDevice(config, args, isoNow());
  if (message.type !== "collector.upgrade.request") return null;
  if (message.protocolVersion !== UPGRADE_PROTOCOL_VERSION) return null;
  if (message.deviceId !== device.id) return null;
  for (const key of ["operationId", "jobId", "nonce", "targetVersion", "manifestUrl", "packageBaseUrl", "deadlineAt"]) {
    if (typeof message[key] !== "string" || !message[key].trim()) return null;
  }
  const manifestUrl = new URL(message.manifestUrl);
  const packageBaseUrl = new URL(message.packageBaseUrl);
  if (manifestUrl.origin !== packageBaseUrl.origin) return null;
  return {
    operationId: message.operationId,
    jobId: message.jobId,
    deviceId: message.deviceId,
    nonce: message.nonce,
    targetVersion: message.targetVersion,
    manifestUrl: manifestUrl.toString(),
    packageBaseUrl: packageBaseUrl.toString(),
    deadlineAt: message.deadlineAt,
  };
}

function normalizeCollectorPackageManifest(value) {
  if (!value || typeof value !== "object") return null;
  if (value.schemaVersion !== "collector-package-v1") return null;
  if (typeof value.version !== "string" || !value.version.trim()) return null;
  if (!Number.isInteger(value.minUpgradeProtocolVersion) || value.minUpgradeProtocolVersion > UPGRADE_PROTOCOL_VERSION) return null;
  if (!Array.isArray(value.files) || value.files.length === 0) return null;
  const seen = new Set();
  const files = [];
  for (const entry of value.files) {
    if (!entry || typeof entry !== "object") return null;
    if (!COLLECTOR_PACKAGE_FILES.has(entry.fileName)) return null;
    if (entry.path !== entry.fileName) return null;
    if (COLLECTOR_PACKAGE_FILES.get(entry.fileName) !== entry.mode) return null;
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) return null;
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) return null;
    if (seen.has(entry.fileName)) return null;
    seen.add(entry.fileName);
    files.push({
      fileName: entry.fileName,
      path: entry.path,
      mode: entry.mode,
      sha256: entry.sha256.toLowerCase(),
      bytes: entry.bytes,
    });
  }
  return { version: value.version, files };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`collector package manifest download failed: HTTP ${response.status}`);
  return response.json();
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`collector package file download failed: HTTP ${response.status}`);
  return response.arrayBuffer();
}

function verifyCollectorPackageFile(file, body) {
  const buffer = Buffer.from(body);
  const actualHash = createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== file.sha256) throw new Error(`collector package file hash mismatch: ${file.fileName}`);
  if (buffer.byteLength !== file.bytes) throw new Error(`collector package file size mismatch: ${file.fileName}`);
}

function rollbackCollectorUpgrade(installDir, backupDir) {
  if (!existsSync(backupDir)) return;
  for (const fileName of COLLECTOR_PACKAGE_FILES.keys()) {
    const backupPath = path.join(backupDir, fileName);
    if (existsSync(backupPath)) copyFileSync(backupPath, path.join(installDir, fileName));
  }
}

function compareCollectorVersions(left, right) {
  const leftParts = String(left || "").split(/[+-]/, 1)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || "").split(/[+-]/, 1)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

class MinimalWebSocketClient {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(wsUrl) {
    this.url = new URL(wsUrl);
    this.readyState = MinimalWebSocketClient.CONNECTING;
    this.events = new EventEmitter();
    this.socket = undefined;
    this.frameBuffer = Buffer.alloc(0);
    queueMicrotask(() => this.connect());
  }

  addEventListener(type, listener) {
    this.events.on(type, listener);
  }

  removeEventListener(type, listener) {
    this.events.off(type, listener);
  }

  send(data) {
    if (this.readyState !== MinimalWebSocketClient.OPEN || !this.socket) return;
    this.socket.write(createWebSocketTextFrame(String(data)));
  }

  close() {
    if (this.readyState === MinimalWebSocketClient.CLOSED) return;
    this.readyState = MinimalWebSocketClient.CLOSING;
    this.socket?.end();
  }

  connect() {
    const secure = this.url.protocol === "wss:";
    if (!secure && this.url.protocol !== "ws:") {
      this.emitError(new Error(`unsupported WebSocket protocol: ${this.url.protocol}`));
      this.markClosed();
      return;
    }

    const port = Number(this.url.port || (secure ? 443 : 80));
    const key = randomBytes(16).toString("base64");
    const socket = secure
      ? tls.connect({ host: this.url.hostname, port, servername: this.url.hostname })
      : net.connect({ host: this.url.hostname, port });
    this.socket = socket;
    let handshakeBuffer = Buffer.alloc(0);
    let handshakeSent = false;
    let upgraded = false;
    const sendHandshake = () => {
      if (handshakeSent) return;
      handshakeSent = true;
      socket.write(createWebSocketHandshake(this.url, key));
    };

    socket.setNoDelay(true);
    if (secure) socket.on("secureConnect", sendHandshake);
    else socket.on("connect", sendHandshake);
    socket.on("data", (chunk) => {
      if (upgraded) {
        this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
        this.drainFrames();
        return;
      }
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      try {
        verifyWebSocketHandshake(handshakeBuffer.subarray(0, headerEnd).toString("latin1"), key);
        upgraded = true;
        this.readyState = MinimalWebSocketClient.OPEN;
        this.events.emit("open");
      } catch (error) {
        this.emitError(error);
        this.close();
      }
    });
    socket.on("error", (error) => {
      this.emitError(error);
    });
    socket.on("close", () => {
      this.markClosed();
    });
  }

  emitError(error) {
    this.events.emit("error", error);
  }

  markClosed() {
    if (this.readyState === MinimalWebSocketClient.CLOSED) return;
    this.readyState = MinimalWebSocketClient.CLOSED;
    this.events.emit("close");
  }

  drainFrames() {
    while (this.frameBuffer.length >= 2) {
      const first = this.frameBuffer[0];
      const second = this.frameBuffer[1];
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.frameBuffer.length < 4) return;
        length = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.frameBuffer.length < 10) return;
        const bigLength = this.frameBuffer.readBigUInt64BE(2);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.emitError(new Error("WebSocket frame too large"));
          this.close();
          return;
        }
        length = Number(bigLength);
        offset = 10;
      }
      const masked = Boolean(second & 0x80);
      const maskLength = masked ? 4 : 0;
      if (this.frameBuffer.length < offset + maskLength + length) return;
      const mask = masked ? this.frameBuffer.subarray(offset, offset + 4) : null;
      const bodyStart = offset + maskLength;
      const body = Buffer.from(this.frameBuffer.subarray(bodyStart, bodyStart + length));
      this.frameBuffer = this.frameBuffer.subarray(bodyStart + length);
      if (mask) {
        for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4];
      }
      if (opcode === 0x1) this.events.emit("message", { data: body.toString("utf8") });
      else if (opcode === 0x8) this.close();
    }
  }
}

function resolveWebSocketClient() {
  if (typeof WebSocket !== "undefined") return WebSocket;
  return MinimalWebSocketClient;
}

function createWebSocketHandshake(url, key) {
  const pathWithSearch = `${url.pathname || "/"}${url.search || ""}`;
  return [
    `GET ${pathWithSearch} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "\r\n",
  ].join("\r\n");
}

function verifyWebSocketHandshake(rawHeaders, key) {
  const lines = rawHeaders.split("\r\n");
  if (!/^HTTP\/1\.[01] 101\b/.test(lines[0] || "")) {
    throw new Error("WebSocket handshake failed");
  }
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const expectedAccept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  if (headers.get("sec-websocket-accept") !== expectedAccept) {
    throw new Error("WebSocket handshake accept mismatch");
  }
}

function createWebSocketTextFrame(payload) {
  const body = Buffer.from(payload);
  const mask = randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x81;
  const maskedBody = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) {
    maskedBody[index] = body[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, maskedBody]);
}

function isControlSocketOpen(socket) {
  const constructorOpen = socket?.constructor?.OPEN;
  const globalOpen = typeof WebSocket !== "undefined" ? WebSocket.OPEN : undefined;
  const openState = typeof constructorOpen === "number"
    ? constructorOpen
    : typeof globalOpen === "number"
      ? globalOpen
      : 1;
  return socket.readyState === openState;
}

function startControlChannel(config, args, logger = createCollectorLogger(config)) {
  const wsUrl = resolveWsUrl(config, args);
  const WebSocketClient = resolveWebSocketClient();
  if (!wsUrl || !WebSocketClient) return;

  const serverUrl = resolveServerUrl(config, args);
  if (!serverUrl && !args.printOnly) return;

  let heartbeatTimer;
  let reconnectTimer;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const socket = new WebSocketClient(wsUrl);

    socket.addEventListener("open", () => {
      const observedAt = isoNow();
      const device = createControlDevice(config, args, observedAt);
      sendControlMessage(socket, {
        type: "hello",
        deviceId: device.id,
        ...(resolveDeviceToken(config, args) ? { deviceToken: resolveDeviceToken(config, args) } : {}),
        hostname: device.hostname,
        collectorVersion: COLLECTOR_VERSION,
        upgrade: collectorUpgradeCapability(config),
        analysis: collectorAnalysisCapability(),
      });
      sendControlMessage(socket, heartbeatPayload(config, args));
      sendPendingUpgradeStartupProgress(socket, config, args);
      heartbeatTimer = setInterval(() => {
        sendControlMessage(socket, heartbeatPayload(config, args));
      }, Math.min(Number(args.intervalMs || config.intervalMs || DEFAULT_INTERVAL_MS), 30_000));
    });

    socket.addEventListener("message", (event) => {
      handleControlMessage(socket, event?.data, config, args, logger);
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

function sendPendingUpgradeStartupProgress(socket, config, args) {
  const state = readUpgradeState(config);
  if (state.stage !== "restart_pending") return;
  if (state.targetVersion !== COLLECTOR_VERSION) return;
  const device = createControlDevice(config, args, isoNow());
  if (state.deviceId && state.deviceId !== device.id) return;
  const request = {
    operationId: state.operationId,
    jobId: state.jobId,
    deviceId: device.id,
    nonce: state.nonce,
    targetVersion: state.targetVersion,
  };
  if (!request.operationId || !request.jobId || !request.nonce || !request.targetVersion) return;
  sendCollectorUpgradeProgress(socket, request, "succeeded", "succeeded", "Collector restarted with target version", {
    collectorVersion: COLLECTOR_VERSION,
  });
  writeUpgradeState(config, {
    ...state,
    stage: "succeeded",
    status: "succeeded",
    updatedAt: isoNow(),
  });
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
    startControlChannel(config, args, logger);
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
