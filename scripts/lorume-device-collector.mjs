#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir, hostname, arch, platform, networkInterfaces, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTOR_VERSION = "0.1.0";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_SLOCK_SERVER_URL = process.env.SLOCK_DEFAULT_SERVER_URL || "https://api.slock.ai";
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

function makeRuntimeId(deviceId, source, externalId) {
  return `${sanitizeId(deviceId)}:${sanitizeId(source)}:${sanitizeId(externalId)}`;
}

function makeAgentId(runtimeId, externalId) {
  return `${runtimeId}:agent:${sanitizeId(externalId)}`;
}

function commandExists(command) {
  return findExecutable(command) !== null;
}

function commandSearchDirs() {
  const dirs = [];
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  dirs.push(...pathDirs);
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

  dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin");

  return [...new Set(dirs)];
}

function candidateExecutables(command) {
  return commandSearchDirs().map((dir) => path.join(dir, command));
}

function probeEnv(executable) {
  const executableDir = path.dirname(executable);
  return {
    ...process.env,
    PATH: [...new Set([executableDir, path.dirname(process.execPath), ...commandSearchDirs()])].join(path.delimiter),
  };
}

function findExecutable(command) {
  for (const candidate of candidateExecutables(command)) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep scanning.
    }
  }

  try {
    const resolved = execFileSync("sh", ["-c", `command -v -- ${shellQuote(command)}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: commandSearchDirs().join(path.delimiter) },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function runJson(command, args, timeoutMs = 10_000) {
  const executable = findExecutable(command);
  if (!executable) return null;
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: probeEnv(executable),
    maxBuffer: DEFAULT_PROBE_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function runText(command, args, timeoutMs = 5_000) {
  const executable = findExecutable(command);
  if (!executable) return null;
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: probeEnv(executable),
    maxBuffer: DEFAULT_PROBE_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
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

function createRuntime({ deviceId, source, externalId, kind, name, status, version, capabilities, lastSeenAt, health, paths }) {
  return {
    id: makeRuntimeId(deviceId, source, externalId),
    deviceId,
    kind,
    name,
    status,
    ...(version ? { version } : {}),
    capabilities,
    lastSeenAt,
    sourceRefs: [{ source, externalId, label: name }],
    ...(health ? { health } : {}),
    ...(Array.isArray(paths) && paths.length ? { paths } : {}),
  };
}

function createAgent({ runtimeId, source, externalId, name, origin, status, channelBindings, lastSeenAt, load, paths }) {
  return {
    id: makeAgentId(runtimeId, externalId),
    runtimeId,
    name,
    origin,
    status,
    channelBindings,
    sourceRefs: [{ source, externalId, label: name }],
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(load ? { load } : {}),
    ...(Array.isArray(paths) && paths.length ? { paths } : {}),
  };
}

function rollupDeviceStatus(collectorStatus, runtimes) {
  if (collectorStatus === "offline") return "offline";
  if (collectorStatus === "degraded") return "degraded";
  if (runtimes.some((runtime) => runtime.status === "degraded")) return "degraded";
  if (runtimes.some((runtime) => runtime.status === "online")) return "online";
  if (runtimes.some((runtime) => runtime.status === "offline")) return "offline";
  return "unknown";
}

function readOpenClawConfig() {
  const configPath = path.join(homeDir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return null;
  try {
    return readJsonFile(configPath);
  } catch {
    return null;
  }
}

function listOpenClawConfigAgentIds(config) {
  const list = config?.agents?.list;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && typeof entry.id === "string") return entry.id;
      return "";
    })
    .filter(Boolean);
}

function channelKind(channel) {
  return channel === "dingtalk" ? "dingtalk" : "other";
}

function resolveOpenClawChannelBindings(config, health, agentId) {
  const fromHealth = Object.keys(health?.channels || {}).map((channel) => ({
    kind: channelKind(channel),
    label: health?.channelLabels?.[channel] || channel,
    status: health?.channels?.[channel]?.enabled === false ? "disabled" : "enabled",
  }));

  const fromConfig = Array.isArray(config?.bindings)
    ? config.bindings
        .filter((binding) => !binding?.agentId || binding.agentId === agentId)
        .map((binding) => {
          const channel = binding?.match?.channel || "other";
          const accountId = binding?.match?.accountId;
          const enabled = config?.channels?.[channel]?.enabled;
          return {
            kind: channelKind(channel),
            label: `${channel === "dingtalk" ? "DingTalk" : channel}${accountId ? ` ${accountId}` : ""}`,
            ...(accountId ? { externalId: accountId } : {}),
            status: enabled === false ? "disabled" : "enabled",
          };
        })
    : [];

  const deduped = new Map();
  for (const binding of [...fromHealth, ...fromConfig]) {
    deduped.set(`${binding.kind}:${binding.externalId || binding.label}`, binding);
  }
  return Array.from(deduped.values());
}

function collectOpenClaw(deviceId, observedAt) {
  const config = readOpenClawConfig();
  const health = runJson("openclaw", ["health", "--json", "--timeout", "5000"]);
  const status = runJson("openclaw", ["status", "--json", "--timeout", "5000"]);
  if (!health && !status && !config) return { runtimes: [], agents: [] };

  const gateway = status?.gateway;
  const runtimeStatus = health?.ok === false || gateway?.reachable === false ? "degraded" : health || status ? "online" : "unknown";
  const version = gateway?.self?.version || undefined;
  const runtime = createRuntime({
    deviceId,
    source: "openclaw",
    externalId: gateway?.url ? `gateway-${gateway.url}` : "gateway-local",
    kind: "openclaw",
    name: "OpenClaw Gateway",
    status: runtimeStatus,
    version,
    capabilities: ["config", ...(health ? ["health"] : []), ...(status ? ["status", "tasks"] : [])],
    lastSeenAt: observedAt,
    health: {
      historicalSessions: status?.agents?.totalSessions,
      lastError: health?.ok === false ? "openclaw health returned ok=false" : undefined,
    },
    paths: compactPaths([
      { label: "Config", path: path.join(homeDir(), ".openclaw", "openclaw.json") },
      { label: "Agents", path: path.join(homeDir(), ".openclaw", "agents") },
    ]),
  });

  const openclawAgents = health?.agents || status?.agents?.agents || [];
  const agentIds = Array.from(new Set([
    ...openclawAgents.map((agent) => agent.agentId || agent.id || "main"),
    ...listOpenClawConfigAgentIds(config),
  ])).filter(Boolean);
  const agents = agentIds.map((agentId) => {
    const agent = openclawAgents.find((candidate) => (candidate.agentId || candidate.id || "main") === agentId) || {};
    return createAgent({
      runtimeId: runtime.id,
      source: "openclaw",
      externalId: agentId,
      name: agentId,
      origin: "openclaw",
      status: health || status ? "idle" : "unknown",
      channelBindings: resolveOpenClawChannelBindings(config, health, agentId),
      lastSeenAt: observedAt,
      load: {
        ...(agent.sessions?.count === undefined ? {} : { historicalSessions: agent.sessions.count }),
      },
      paths: compactPaths([{ label: "Agent", path: path.join(homeDir(), ".openclaw", "agents", agentId) }]),
    });
  });

  return { runtimes: [runtime], agents };
}

function collectMultica(deviceId, observedAt) {
  const daemonStatus = runJson("multica", ["daemon", "status", "--output", "json"]);
  const runtimeList = runJson("multica", ["runtime", "list", "--output", "json"]);
  const agentList = runJson("multica", ["agent", "list", "--output", "json"]);
  if (!daemonStatus && !Array.isArray(runtimeList) && !Array.isArray(agentList)) {
    return { runtimes: [], agents: [] };
  }

  const runtimes = Array.isArray(runtimeList)
    ? runtimeList.map((runtime) =>
        createRuntime({
          deviceId,
          source: "multica",
          externalId: runtime.id || runtime.name || "runtime",
          kind: runtime.provider === "openclaw" ? "openclaw" : runtime.provider === "codex" ? "codex" : "multica",
          name: runtime.name || runtime.provider || "Multica runtime",
          status: runtime.status === "online" ? "online" : runtime.status === "offline" ? "offline" : "unknown",
          version: runtime.metadata?.version || undefined,
          capabilities: ["daemon:status", "runtime:list", "agent:list"],
          lastSeenAt: runtime.last_seen_at || observedAt,
          health: { activeTasks: daemonStatus?.active_task_count },
        }),
      )
    : [];

  const runtimeIdByExternalId = new Map(runtimes.map((runtime) => [runtime.sourceRefs[0].externalId, runtime.id]));
  const agents = Array.isArray(agentList)
    ? agentList.map((agent) => {
        const runtimeId = runtimeIdByExternalId.get(agent.runtime_id) || makeRuntimeId(deviceId, "multica", agent.runtime_id || "unknown-runtime");
        return createAgent({
          runtimeId,
          source: "multica",
          externalId: agent.id || agent.name || "agent",
          name: agent.name || "Multica Agent",
          origin: "multica",
          status: normalizeMulticaAgentStatus(agent.status),
          channelBindings: [{ kind: "multica", label: "Multica", status: "enabled" }],
          lastSeenAt: agent.last_seen_at || agent.updated_at || observedAt,
          load: {
            ...(agent.max_concurrent_tasks === undefined ? {} : { maxConcurrency: agent.max_concurrent_tasks }),
          },
        });
      })
    : [];

  return { runtimes, agents };
}

function readSlockAgentName(agentDir, fallbackName) {
  try {
    const memory = readFileSync(path.join(agentDir, "MEMORY.md"), "utf8");
    const heading = memory.split("\n").find((line) => line.startsWith("# "));
    return heading ? heading.replace(/^#\s+/, "").trim() || fallbackName : fallbackName;
  } catch {
    return fallbackName;
  }
}

function collectSlock(deviceId, observedAt) {
  const slockAgentsDir = path.join(homeDir(), ".slock", "agents");
  if (!existsSync(slockAgentsDir)) return { runtimes: [], agents: [] };

  const agentDirs = readdirSync(slockAgentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const runtime = createRuntime({
    deviceId,
    source: "slock",
    externalId: "slock-daemon",
    kind: "slock",
    name: "Slock daemon",
    status: commandExists("slock-daemon") || agentDirs.length > 0 ? "online" : "unknown",
    capabilities: ["agent:start", "agent:deliver", "workspace:files"],
    lastSeenAt: observedAt,
    paths: compactPaths([{ label: "Agents", path: slockAgentsDir }]),
  });

  const agents = agentDirs.map((entry) =>
    createAgent({
      runtimeId: runtime.id,
      source: "slock",
      externalId: entry.name,
      name: readSlockAgentName(path.join(slockAgentsDir, entry.name), entry.name),
      origin: "slock",
      status: "unknown",
      channelBindings: [{ kind: "slock", label: "Slock", status: "enabled" }],
      lastSeenAt: observedAt,
      paths: compactPaths([{ label: "Agent", path: path.join(slockAgentsDir, entry.name) }]),
    }),
  );

  return { runtimes: [runtime], agents };
}

function compactPaths(paths) {
  return paths.filter((entry) => entry?.path && existsSync(entry.path));
}

function normalizeMulticaAgentStatus(status) {
  if (status === "active") return "active";
  if (status === "idle") return "idle";
  if (status === "inactive") return "inactive";
  if (status === "degraded") return "degraded";
  if (status === "unknown") return "unknown";
  return "idle";
}

function collectCliRuntime(deviceId, observedAt, command, kind, name) {
  const version = runText(command, ["--version"]);
  if (!version) return { runtimes: [], agents: [] };
  return {
    runtimes: [
      createRuntime({
        deviceId,
        source: kind,
        externalId: command,
        kind,
        name,
        status: "online",
        version,
        capabilities: ["cli:version"],
        lastSeenAt: observedAt,
      }),
    ],
    agents: [],
  };
}

function mergeParts(parts) {
  return {
    runtimes: parts.flatMap((part) => part.runtimes),
    agents: parts.flatMap((part) => part.agents),
  };
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
  if (!isInternalLegacyCollectorMode()) return collectSnapshotViaLorumeCli(config, args);

  const mergedConfig = {
    ...config,
    ...(args.serverUrl ? { serverUrl: args.serverUrl } : {}),
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
    ...(args.deviceName ? { deviceName: args.deviceName } : {}),
  };

  if (args.fixturePath) {
    return applyDeviceOverrides(readJsonFile(args.fixturePath), {
      deviceId: mergedConfig.deviceId,
      deviceName: mergedConfig.deviceName,
    });
  }

  const observedAt = isoNow();
  const device = createDevice(mergedConfig, observedAt);
  const collector = {
    version: COLLECTOR_VERSION,
    status: "online",
    installPath: config.installDir,
  };
  const collected = mergeParts([
    collectOpenClaw(device.id, observedAt),
    collectMultica(device.id, observedAt),
    collectSlock(device.id, observedAt),
    collectCliRuntime(device.id, observedAt, "codex", "codex", "Codex CLI"),
    collectCliRuntime(device.id, observedAt, "claude", "claude_code", "Claude Code"),
  ]);
  const deviceStatus = rollupDeviceStatus(collector.status, collected.runtimes);

  return {
    observedAt,
    collector,
    device: { ...device, status: deviceStatus },
    runtimes: collected.runtimes,
    agents: collected.agents,
    reports: [],
  };
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

async function postAgentSkillProbeSnapshot(serverUrl, snapshot, deviceToken = "") {
  const url = new URL("/api/agent-skill-probe-snapshots", serverUrl);
  await postJsonWithRetry(url, snapshot, "Agent Skill probe snapshot", deviceToken);
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

function toArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.items)) return value.items;
  return [];
}

function toRecordArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function toIsoTimestamp(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    const epochMs = value > 10_000_000_000 ? value : value * 1000;
    return new Date(epochMs).toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) return toIsoTimestamp(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

function supportCapability(support, strategies, evidence, limitations) {
  return { support, strategies, evidence, limitations };
}

function openClawWorkStateCapability(collectedAt, options = {}) {
  return {
    source: "openclaw",
    collectedAt,
    workItems: supportCapability(
      options.workItemsSupport || "unsupported",
      options.workItemsStrategies || ["local_state", "cli", "native_api"],
      options.workItemsEvidence || ["OpenClaw tasks, linked DingTalk local state, session runtime-context, and trajectory prompt.submitted can expose message-backed work items."],
      options.workItemsLimitations || ["OpenClaw has no pending or review phase without an upstream work item source."],
    ),
    conversations: supportCapability(
      options.conversationsSupport || "unknown",
      ["cli", "native_api"],
      options.conversationsEvidence || ["openclaw health/status was not available for this snapshot."],
      options.conversationsLimitations || ["Session count can include historical sessions; recent sessions require health/status evidence."],
    ),
    executions: supportCapability(
      options.executionsSupport || "unknown",
      ["cli", "native_api"],
      options.executionsEvidence || ["openclaw tasks list --json and trajectory trace.artifacts were not available for this snapshot."],
      options.executionsLimitations || ["Lost, timed out, and trajectory error states are normalized to failed when task data is available."],
    ),
  };
}

function multicaWorkStateCapability(collectedAt, options = {}) {
  return {
    source: "multica",
    collectedAt,
    workItems: supportCapability(
      options.workItemsSupport || "unknown",
      ["cli", "native_api"],
      options.workItemsEvidence || ["multica issue list --output json was not available for this snapshot."],
      options.workItemsLimitations || ["Backlog is normalized to todo when issue data is available."],
    ),
    conversations: supportCapability(
      options.conversationsSupport || "unknown",
      ["cli", "native_api"],
      options.conversationsEvidence || ["multica agent tasks did not expose chat_session_id in this snapshot."],
      options.conversationsLimitations || ["Conversation messages require separate issue run-message reads."],
    ),
    executions: supportCapability(
      options.executionsSupport || "unknown",
      ["cli", "native_api"],
      options.executionsEvidence || ["multica agent tasks --output json was not available for this snapshot."],
      options.executionsLimitations || ["Completed is normalized to succeeded when task data is available."],
    ),
  };
}

function slockWorkStateCapability(collectedAt, options = {}) {
  return {
    source: "slock",
    collectedAt,
    workItems: supportCapability(
      options.workItemsSupport || "unknown",
      options.workItemsStrategies || ["cli", "native_api"],
      options.workItemsEvidence || ["No Slock task-board probe was available for this snapshot."],
      options.workItemsLimitations || ["Workspace agent files prove local agent presence, not board state."],
    ),
    conversations: supportCapability(
      options.conversationsSupport || "unknown",
      options.conversationsStrategies || ["cli", "native_api"],
      options.conversationsEvidence || ["No Slock channel/thread history probe was available for this snapshot."],
      options.conversationsLimitations || ["DM and thread history depend on the active Slock agent context."],
    ),
    executions: supportCapability(
      "unknown",
      ["network_proxy", "managed_launcher"],
      ["Slock task board is available; realtime activity is not collected in the v1 adapter path."],
      ["Execution state requires activity events, an observer, or a proxy path; server active is not execution running evidence."],
    ),
  };
}

function normalizeOpenClawExecutionStatus(status) {
  if (status === "succeeded") return "succeeded";
  if (status === "cancelled") return "cancelled";
  if (status === "queued" || status === "pending") return "queued";
  if (status === "running" || status === "in_progress") return "running";
  if (status === "failed" || status === "lost" || status === "timed_out" || status === "timeout") return "failed";
  return "unknown";
}

function normalizeOpenClawTrajectoryExecutionStatus(run) {
  if (run.finalStatus === "success" || run.endedStatus === "success") return "succeeded";
  if (run.finalStatus === "cancelled" || run.endedStatus === "cancelled") return "cancelled";
  if (run.finalStatus === "error" || run.endedStatus === "error" || run.aborted || run.timedOut || run.idleTimedOut) return "failed";
  if (!run.finalStatus && !run.endedStatus) return "running";
  return "unknown";
}

function normalizeMulticaWorkItemStatus(status) {
  if (status === "todo" || status === "backlog" || status === "open") return "todo";
  if (status === "in_progress" || status === "running") return "in_progress";
  if (status === "in_review" || status === "review") return "in_review";
  if (status === "done" || status === "completed" || status === "succeeded") return "done";
  if (status === "blocked") return "blocked";
  if (status === "cancelled" || status === "canceled" || status === "closed") return "cancelled";
  return "unknown";
}

function normalizeMulticaExecutionStatus(status) {
  if (status === "completed" || status === "succeeded" || status === "done") return "succeeded";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "queued" || status === "pending") return "queued";
  if (status === "running" || status === "in_progress") return "running";
  return "unknown";
}

function normalizeSlockWorkItemStatus(status) {
  const normalized = normalizeStatusKey(status);
  if (normalized === "todo" || normalized === "backlog" || normalized === "open") return "todo";
  if (normalized === "in_progress" || normalized === "working" || normalized === "running") return "in_progress";
  if (normalized === "in_review" || normalized === "review") return "in_review";
  if (normalized === "done" || normalized === "completed" || normalized === "succeeded") return "done";
  if (normalized === "blocked") return "blocked";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "closed") return "cancelled";
  return "unknown";
}

function normalizeStatusKey(status) {
  return String(status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function extractOpenClawSessionKey(session) {
  if (typeof session === "string") return session;
  if (!session || typeof session !== "object") return "";
  return session.sessionKey || session.session_key || session.key || session.id || session.requesterSessionKey || session.childSessionKey || "";
}

function addOpenClawSession(sessionMap, runtimeId, agentId, session, observedAt, fallbackStatus = "unknown") {
  const sessionKey = extractOpenClawSessionKey(session);
  if (!sessionKey) return;
  const existing = sessionMap.get(sessionKey) || {};
  const lastActivityAt = toIsoTimestamp(session?.updatedAt || session?.updated_at || session?.lastActivityAt || session?.last_activity_at || session?.lastEventAt);
  sessionMap.set(sessionKey, {
    id: existing.id || `${runtimeId}:conversation:${sanitizeId(sessionKey)}`,
    source: "openclaw",
    externalId: sessionKey,
    status: existing.status === "active" || session?.status === "active" || fallbackStatus === "active"
      ? "active"
      : existing.status || fallbackStatus,
    agentId: existing.agentId || agentId,
    runtimeId,
    ...(session?.title || existing.title ? { title: existing.title || session.title } : {}),
    ...(session?.channel || existing.channel ? { channel: existing.channel || session.channel } : {}),
    ...(session?.participants || existing.participants ? { participants: existing.participants || session.participants } : {}),
    ...(lastActivityAt || existing.lastActivityAt ? { lastActivityAt: latestIsoTimestamp(existing.lastActivityAt, lastActivityAt) } : {}),
    lastSeenAt: observedAt,
    sourceRefs: existing.sourceRefs || [{ source: "openclaw", externalId: sessionKey }],
  });
}

function latestIsoTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function readOpenClawDingTalkState() {
  const agentsRoot = path.join(homeDir(), ".openclaw", "agents");
  const messages = [];
  const targetsByConversationId = new Map();
  try {
    for (const agentEntry of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const stateDir = path.join(agentsRoot, agentEntry.name, "sessions", "dingtalk-state");
      let stateEntries = [];
      try {
        stateEntries = readdirSync(stateDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of stateEntries) {
        if (!entry.isFile() || !entry.name.startsWith("targets.directory") || !entry.name.endsWith(".json")) continue;
        try {
          const directory = readJsonFile(path.join(stateDir, entry.name));
          for (const [conversationId, group] of Object.entries(directory.groups || {})) {
            const target = {
              conversationId,
              kind: "group",
              label: group?.currentTitle || group?.title || conversationId,
              lastSeenAt: toIsoTimestamp(group?.lastSeenAt || group?.updatedAt),
            };
            targetsByConversationId.set(conversationId, target);
            targetsByConversationId.set(String(conversationId).toLowerCase(), target);
          }
          for (const [conversationId, user] of Object.entries(directory.users || {})) {
            const target = {
              conversationId,
              kind: "direct",
              label: user?.displayName || user?.name || user?.nick || conversationId,
              lastSeenAt: toIsoTimestamp(user?.lastSeenAt || user?.updatedAt),
            };
            targetsByConversationId.set(conversationId, target);
            targetsByConversationId.set(String(conversationId).toLowerCase(), target);
          }
        } catch {
          // Ignore malformed local channel directory files.
        }
      }

      for (const entry of stateEntries) {
        if (!entry.isFile() || !entry.name.startsWith("messages.context") || !entry.name.endsWith(".json")) continue;
        try {
          const context = readJsonFile(path.join(stateDir, entry.name));
          for (const record of toRecordArray(context.records)) {
            if (!record?.msgId && !record?.messageId) continue;
            if (!record?.conversationId) continue;
            const target = targetsByConversationId.get(record.conversationId);
            const sessionKind = target?.kind || "group";
            messages.push({
              msgId: String(record.msgId || record.messageId),
              sessionKey: record.sessionKey || `agent:main:dingtalk:${sessionKind}:${record.conversationId}`,
              conversationId: String(record.conversationId),
              direction: record.direction === "outbound" ? "outbound" : "inbound",
              text: typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : undefined,
              senderId: record.senderId ? String(record.senderId) : undefined,
              senderName: record.senderName || record.senderNick || record.sender ? String(record.senderName || record.senderNick || record.sender) : undefined,
              createdAt: toIsoTimestamp(record.createdAt || record.created_at),
              updatedAt: toIsoTimestamp(record.updatedAt || record.updated_at || context.updatedAt),
            });
          }
        } catch {
          // Ignore malformed local message context files.
        }
      }
    }
  } catch {
    return { messages: [], targetsByConversationId: new Map() };
  }
  return { messages, targetsByConversationId };
}

function walkOpenClawFiles(root, predicate, output = []) {
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) walkOpenClawFiles(fullPath, predicate, output);
    else if (entry.isFile() && predicate(fullPath, entry)) output.push(fullPath);
  }
  return output;
}

function readOpenClawTrajectoryRuns() {
  const agentsRoot = path.join(homeDir(), ".openclaw", "agents");
  const runs = [];
  let agentEntries = [];
  try {
    agentEntries = readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return runs;
  }

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentExternalId = agentEntry.name || "main";
    const sessionsRoot = path.join(agentsRoot, agentEntry.name, "sessions");
    const trajectoryFiles = walkOpenClawFiles(sessionsRoot, (filePath) => filePath.endsWith(".trajectory.jsonl"));
    for (const trajectoryFile of trajectoryFiles) {
      for (const run of readOpenClawTrajectoryFile(trajectoryFile, agentExternalId)) {
        if (parseOpenClawDingTalkSession(run.sessionKey)) runs.push(run);
      }
    }
  }

  return runs;
}

function readOpenClawTrajectoryFile(trajectoryFile, fallbackAgentId) {
  const runById = new Map();
  let lines = [];
  try {
    lines = readFileSync(trajectoryFile, "utf8").split(/\n+/).filter(Boolean);
  } catch {
    return [];
  }

  for (const line of lines) {
    if (!isOpenClawTrajectoryLineNeeded(line)) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const runId = String(event.runId || event.run_id || event.data?.runId || event.data?.run_id || event.sessionId || path.basename(trajectoryFile, ".trajectory.jsonl"));
    if (!runId) continue;
    const current = runById.get(runId) || {
      runId,
      sessionKey: event.sessionKey || event.session_key || event.data?.sessionKey || event.data?.session_key || "",
      agentExternalId: event.data?.agentId || event.agentId || fallbackAgentId || "main",
    };
    current.sessionKey ||= event.sessionKey || event.session_key || event.data?.sessionKey || event.data?.session_key || "";
    current.agentExternalId ||= event.data?.agentId || event.agentId || fallbackAgentId || "main";
    current.lastEventAt = latestIsoTimestamp(current.lastEventAt, toIsoTimestamp(event.ts || event.timestamp));

    if (event.type === "session.started") {
      current.startedAt = current.startedAt || toIsoTimestamp(event.ts || event.timestamp);
      current.sessionFile = event.data?.sessionFile || event.data?.session_file || current.sessionFile;
    }
    const runtimeContext = extractOpenClawRuntimeContextFromEvent(event);
    if (runtimeContext) applyOpenClawRuntimeContext(current, runtimeContext);

    if (event.type === "prompt.submitted") {
      const prompt = extractOpenClawPrompt(event.data);
      applyOpenClawRuntimeContext(current, extractOpenClawRuntimeContext(prompt));
      current.prompt = cleanOpenClawPromptText(prompt || current.prompt);
    } else if (event.type === "trace.artifacts") {
      const data = event.data || {};
      current.finalStatus = data.finalStatus || current.finalStatus;
      current.aborted = Boolean(data.aborted || current.aborted);
      current.timedOut = Boolean(data.timedOut || data.timed_out || current.timedOut);
      current.idleTimedOut = Boolean(data.idleTimedOut || data.idle_timed_out || current.idleTimedOut);
      current.didSendViaMessagingTool = Boolean(data.didSendViaMessagingTool || current.didSendViaMessagingTool);
      current.assistantTexts = Array.isArray(data.assistantTexts) ? data.assistantTexts.map(String) : current.assistantTexts;
      current.error = data.promptErrorSource || data.error || current.error;
    } else if (event.type === "model.completed") {
      const data = event.data || {};
      current.aborted = Boolean(data.aborted || current.aborted);
      current.timedOut = Boolean(data.timedOut || data.timed_out || current.timedOut);
      current.idleTimedOut = Boolean(data.idleTimedOut || data.idle_timed_out || current.idleTimedOut);
      current.assistantTexts = current.assistantTexts || (Array.isArray(data.assistantTexts) ? data.assistantTexts.map(String) : undefined);
      current.error = data.promptErrorSource || data.error || current.error;
    } else if (event.type === "session.ended") {
      current.endedAt = toIsoTimestamp(event.ts || event.timestamp) || current.endedAt;
      current.endedStatus = event.data?.status || event.status || current.endedStatus;
      current.aborted = Boolean(event.data?.aborted || current.aborted);
      current.timedOut = Boolean(event.data?.timedOut || event.data?.timed_out || current.timedOut);
      current.idleTimedOut = Boolean(event.data?.idleTimedOut || event.data?.idle_timed_out || current.idleTimedOut);
    }
    runById.set(runId, current);
  }

  for (const run of runById.values()) {
    if (run.sessionFile) {
      const sessionDetails = readLatestOpenClawUserPromptDetails(run.sessionFile);
      if (!run.prompt) run.prompt = sessionDetails.prompt;
      applyOpenClawRuntimeContext(run, sessionDetails.runtimeContext);
    }
  }

  return Array.from(runById.values()).filter((run) => run.sessionKey);
}

function isOpenClawTrajectoryLineNeeded(line) {
  return line.includes('"session.started"') ||
    line.includes('"prompt.submitted"') ||
    line.includes('"openclaw.runtime-context"') ||
    line.includes('"custom_message"') ||
    line.includes('"model.completed"') ||
    line.includes('"trace.artifacts"') ||
    line.includes('"session.ended"');
}

function extractOpenClawPrompt(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.prompt === "string" && data.prompt.trim()) return data.prompt;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if ((message?.role || message?.message?.role) !== "user") continue;
    const text = openClawTextFromContent(message.content ?? message.message?.content ?? message.text);
    if (text.trim()) return text;
  }
  return "";
}

function readLatestOpenClawUserPromptDetails(sessionFile) {
  let records = [];
  try {
    records = readFileSync(sessionFile, "utf8").split(/\n+/).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return { prompt: "", runtimeContext: null };
  }

  let prompt = "";
  let runtimeContext = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const content = record.content ?? record.message?.content ?? record.data?.content;
    runtimeContext ||= extractOpenClawRuntimeContext(content);
    if (!prompt && (record?.role || record?.message?.role || record?.data?.role) === "user") {
      const text = openClawTextFromContent(content);
      if (text.trim()) prompt = cleanOpenClawPromptText(text);
    }
    if (prompt && runtimeContext) break;
  }
  return { prompt, runtimeContext };
}

function extractOpenClawRuntimeContextFromEvent(event) {
  const data = event?.data || {};
  return extractOpenClawRuntimeContext(data.runtimeContext || data.runtime_context || data.context || data.prompt || data.messages || event.content);
}

function extractOpenClawRuntimeContext(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const nested = extractOpenClawRuntimeContext(value[index]?.content ?? value[index]?.message?.content ?? value[index]?.text ?? value[index]);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value === "object") {
    if (value.message_id || value.messageId || value.msgId || value.sender || value.sender_id || value.chat_id || value.group_subject) return value;
    return null;
  }
  const text = String(value);
  const codeBlockMatch = text.match(/Conversation info[^\n]*:\s*```json\s*([\s\S]*?)```/i);
  const xmlMatch = text.match(/<conversation-metadata>\s*([\s\S]*?)<\/conversation-metadata>/i);
  const metadataMatch = text.match(/Conversation metadata:\s*(\{[\s\S]*?\})(?:\n\n|$)/i);
  const candidates = [codeBlockMatch?.[1], xmlMatch?.[1], metadataMatch?.[1]].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = parseJsonMaybe(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function applyOpenClawRuntimeContext(run, context) {
  if (!context || typeof context !== "object") return;
  const messageId = context.message_id || context.messageId || context.msgId || context.msg_id;
  const senderId = context.sender_id || context.senderId || context.user_id || context.userId;
  const senderName = context.sender || context.sender_name || context.senderName || context.user_name || context.userName;
  const conversationId = context.chat_id || context.chatId || context.conversation_id || context.conversationId;
  const conversationLabel = context.conversation_label || context.conversationLabel;
  const groupSubject = context.group_subject || context.groupSubject;
  const groupChannel = context.group_channel || context.groupChannel;
  if (messageId) run.messageId ||= String(messageId);
  if (senderId) run.senderId ||= String(senderId);
  if (senderName) run.senderName ||= String(senderName);
  if (conversationId) run.conversationId ||= String(conversationId);
  if (conversationLabel) run.conversationLabel ||= String(conversationLabel);
  if (groupSubject) run.groupSubject ||= String(groupSubject);
  if (!run.sessionKey && groupChannel) run.sessionKey = String(groupChannel);
}

function openClawTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      if (part && typeof part.content === "string") return part.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

function cleanOpenClawPromptText(value) {
  return String(value || "")
    .replace(/Conversation metadata:[\s\S]*?(?:\n\n|$)/i, "")
    .replace(/<conversation-metadata>[\s\S]*?<\/conversation-metadata>/gi, "")
    .replace(/\[media attached(?::| )[^\]]+\]/gi, "[media attached]")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldCreateOpenClawTrajectoryWorkItem(run) {
  const prompt = cleanOpenClawPromptText(run?.prompt);
  if (!prompt) return false;
  if (prompt === "HEARTBEAT_OK" || /^\[OpenClaw heartbeat poll\]/i.test(prompt)) return false;
  if (/^\[[^\]]+\]\s+An async command the user already approved has completed/i.test(prompt)) return false;
  if (/^\[[^\]]+\]\s+\[System\]/i.test(prompt)) return false;
  return Boolean(parseOpenClawDingTalkSession(run?.sessionKey));
}

function messageTitle(value) {
  const normalized = String(value || "DingTalk 消息").replace(/\s+/g, " ").trim();
  const firstSentence = normalized.split(/[，。！？,.!?]/)[0]?.trim();
  const title = firstSentence || normalized || "DingTalk 消息";
  return title.length > 32 ? `${title.slice(0, 32)}...` : title;
}

function findOpenClawMessageLink(candidates, probe) {
  const textKey = normalizeOpenClawLinkText(probe.text);
  if (!textKey) return undefined;

  const probeSession = parseOpenClawDingTalkSession(probe.sessionKey);
  const probeSessionKey = normalizeOpenClawLinkKey(probe.sessionKey);
  const probeConversationKey = normalizeOpenClawLinkKey(probe.conversationId || probeSession?.conversationId);
  const probeTime = parseOpenClawLinkTime(probe.occurredAt);

  const matches = candidates
    .map((candidate) => {
      const candidateSession = parseOpenClawDingTalkSession(candidate.sessionKey);
      const candidateSessionKey = normalizeOpenClawLinkKey(candidate.sessionKey);
      const candidateConversationKey = normalizeOpenClawLinkKey(candidate.conversationId || candidateSession?.conversationId);
      const senderMatchesDirectSession = openClawLinkSenderMatchesDirectSession(probe, candidate, probeSession);
      const locationMatches = Boolean(
        (probeSessionKey && candidateSessionKey && probeSessionKey === candidateSessionKey) ||
        (probeConversationKey && candidateConversationKey && probeConversationKey === candidateConversationKey) ||
        senderMatchesDirectSession,
      );
      if (!locationMatches) return null;

      const candidateTextKey = normalizeOpenClawLinkText(candidate.text);
      if (!openClawLinkTextMatches(textKey, candidateTextKey)) return null;

      const candidateTime = parseOpenClawLinkTime(candidate.occurredAt);
      const distance = probeTime !== undefined && candidateTime !== undefined ? Math.abs(probeTime - candidateTime) : 0;
      if (distance > 2 * 60 * 60 * 1000) return null;
      return { candidate, distance };
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance);

  return matches[0]?.candidate.messageId;
}

function openClawLinkSenderMatchesDirectSession(probe, candidate, probeSession) {
  if (probeSession?.kind !== "direct") return false;
  const probeDirectId = normalizeOpenClawLinkKey(probeSession.conversationId);
  const probeSenderId = normalizeOpenClawLinkKey(probe.senderId);
  const candidateSenderId = normalizeOpenClawLinkKey(candidate.senderId);
  if (candidateSenderId && (candidateSenderId === probeDirectId || candidateSenderId === probeSenderId)) return true;

  const probeSenderName = normalizeOpenClawLinkKey(probe.senderName);
  const candidateSenderName = normalizeOpenClawLinkKey(candidate.senderName);
  return Boolean(!probeSenderId && !candidateSenderId && probeSenderName && candidateSenderName && probeSenderName === candidateSenderName);
}

function normalizeOpenClawLinkKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeOpenClawLinkText(value) {
  return cleanOpenClawPromptText(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function openClawLinkTextMatches(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const comparableLength = Math.min(left.length, right.length);
  return comparableLength >= 12 && (left.startsWith(right) || right.startsWith(left));
}

function parseOpenClawLinkTime(value) {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractOpenClawMessageId(task) {
  const origin = parseJsonMaybe(task.requesterOriginJson || task.requester_origin_json || task.requester_origin);
  return task.messageId || task.message_id || task.msgId || origin?.messageId || origin?.message_id || origin?.msgId || origin?.msg_id;
}

function extractOpenClawOrigin(task) {
  return parseJsonMaybe(task.requesterOriginJson || task.requester_origin_json || task.requester_origin);
}

function normalizeOpenClawMessageStatus(status) {
  if (status === "queued" || status === "running") return "in_progress";
  if (status === "succeeded") return "done";
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "unknown") return "blocked";
  return "unknown";
}

function shouldCreateOpenClawTaskWorkItem(task, origin) {
  if (!task?.task && !task?.label) return false;
  if (String(task.sourceId || task.source_id || "").startsWith("exec-approval-followup:")) return false;
  const text = String(task.task || task.label || "");
  if (/^\[[^\]]+\]\s+An async command the user already approved has completed/i.test(text)) return false;
  if (/^\[[^\]]+\]\s+\[System\]/i.test(text)) return false;
  return Boolean(origin?.channel || parseOpenClawDingTalkSession(task.requesterSessionKey || task.requester_session_key || task.sessionKey || task.session_key));
}

function normalizeOpenClawOriginConversationId(origin) {
  return origin?.to ? String(origin.to) : undefined;
}

function openClawChannelFromOrigin(origin, targetsByConversationId) {
  const channel = origin?.channel ? String(origin.channel) : "";
  if (!channel) return undefined;
  if (channel === "dingtalk") {
    const conversationId = normalizeOpenClawOriginConversationId(origin);
    return openClawDingTalkChannel(conversationId, targetsByConversationId, "group");
  }
  if (channel === "webchat") return { kind: "other", label: "OpenClaw Webchat" };
  if (channel === "cron") return { kind: "other", label: "OpenClaw Cron" };
  return { kind: "other", label: channel };
}

function parseOpenClawDingTalkSession(sessionKey) {
  const match = /^agent:[^:]+:dingtalk:(group|direct):(.+)$/.exec(String(sessionKey || ""));
  return match?.[2] ? { kind: match[1], conversationId: match[2] } : null;
}

function openClawChannelFromDingTalkSession(sessionKey, targetsByConversationId) {
  const parsed = parseOpenClawDingTalkSession(sessionKey);
  if (!parsed) return undefined;
  return openClawDingTalkChannel(parsed.conversationId, targetsByConversationId, parsed.kind);
}

function openClawDingTalkChannel(conversationId, targetsByConversationId, fallbackKind) {
  const target = conversationId
    ? targetsByConversationId.get(conversationId) || targetsByConversationId.get(String(conversationId).toLowerCase())
    : undefined;
  return {
    kind: "dingtalk",
    label: formatOpenClawDingTalkLabel(conversationId, target, fallbackKind),
    ...(conversationId ? { externalId: conversationId } : {}),
  };
}

function formatOpenClawDingTalkLabel(conversationId, target, fallbackKind) {
  const rawLabel = typeof target?.label === "string" ? target.label.trim() : "";
  if (rawLabel && rawLabel.toLowerCase() !== String(conversationId || "").toLowerCase()) return rawLabel;
  if (!conversationId) return "DingTalk";
  const prefix = (target?.kind || fallbackKind) === "direct" ? "DingTalk 私聊" : "DingTalk 群聊";
  return prefix;
}

function createOpenClawTaskWorkItem({ task, origin, runtimeId, agentId, sessionKey, executionStatus, observedAt, dingtalkState }) {
  const taskId = task.taskId || task.task_id || task.id || task.runId || "task";
  const channel = openClawChannelFromOrigin(origin, dingtalkState.targetsByConversationId) ||
    openClawChannelFromDingTalkSession(sessionKey, dingtalkState.targetsByConversationId) ||
    { kind: "other", label: "OpenClaw" };
  const conversationId = sessionKey ? `${runtimeId}:conversation:${sanitizeId(sessionKey)}` : undefined;
  const titleSource = task.label || task.task || taskId;
  return {
    id: `${runtimeId}:work-item:${sanitizeId(taskId)}`,
    source: "openclaw",
    externalId: String(taskId),
    title: messageTitle(titleSource),
    description: typeof task.task === "string" ? task.task.slice(0, 500) : String(titleSource),
    status: normalizeOpenClawMessageStatus(executionStatus),
    channel,
    creator: { kind: "unknown", label: "不支持采集", ...(task.sourceId || task.source_id ? { externalId: String(task.sourceId || task.source_id) } : {}) },
    agentId,
    runtimeId,
    ...(conversationId ? { conversationId } : {}),
    ...(toIsoTimestamp(task.createdAt || task.created_at) ? { createdAt: toIsoTimestamp(task.createdAt || task.created_at) } : {}),
    ...(toIsoTimestamp(task.endedAt || task.ended_at || task.completedAt || task.completed_at || task.lastEventAt || task.last_event_at) ? { updatedAt: toIsoTimestamp(task.endedAt || task.ended_at || task.completedAt || task.completed_at || task.lastEventAt || task.last_event_at) } : {}),
    lastSeenAt: toIsoTimestamp(task.lastEventAt || task.last_event_at || task.endedAt || task.ended_at || task.startedAt || task.started_at) || observedAt,
    sourceRefs: [{ source: "openclaw", externalId: String(taskId) }],
  };
}

function openClawTrajectoryWorkItemStatus(run, executionStatus) {
  if (executionStatus === "succeeded" && !hasOpenClawTrajectoryDeliveryEvidence(run)) return "blocked";
  return normalizeOpenClawMessageStatus(executionStatus);
}

function hasOpenClawTrajectoryDeliveryEvidence(run) {
  if (run.didSendViaMessagingTool) return true;
  if (!Array.isArray(run.assistantTexts)) return false;
  return run.assistantTexts.some((text) => {
    const normalized = String(text || "").trim();
    return normalized && normalized !== "NO_REPLY" && normalized !== "HEARTBEAT_OK";
  });
}

function createOpenClawTrajectoryWorkItem({ run, runtimeId, agentId, executionStatus, observedAt, dingtalkState }) {
  const channel = openClawChannelFromTrajectoryRun(run, dingtalkState.targetsByConversationId);
  const conversationId = `${runtimeId}:conversation:${sanitizeId(run.sessionKey)}`;
  const prompt = cleanOpenClawPromptText(run.prompt);
  return {
    id: `${runtimeId}:work-item:${sanitizeId(run.runId)}`,
    source: "openclaw",
    externalId: String(run.runId),
    title: messageTitle(prompt),
    description: prompt,
    status: openClawTrajectoryWorkItemStatus(run, executionStatus),
    channel,
    creator: openClawCreatorFromTrajectoryRun(run) || { kind: "unknown", label: "不支持采集" },
    agentId,
    runtimeId,
    conversationId,
    ...(run.startedAt ? { createdAt: run.startedAt } : {}),
    ...(run.endedAt || run.lastEventAt || run.startedAt ? { updatedAt: run.endedAt || run.lastEventAt || run.startedAt } : {}),
    lastSeenAt: run.lastEventAt || run.endedAt || observedAt,
    sourceRefs: [{ source: "openclaw", externalId: String(run.runId) }],
  };
}

function openClawChannelFromTrajectoryRun(run, targetsByConversationId) {
  const session = parseOpenClawDingTalkSession(run.sessionKey);
  const conversationId = run.conversationId || session?.conversationId;
  const channel = openClawDingTalkChannel(conversationId, targetsByConversationId, session?.kind || "group");
  const metadataLabel = run.groupSubject || run.conversationLabel;
  if (metadataLabel && String(channel.label || "").startsWith("DingTalk ")) {
    return { ...channel, label: metadataLabel, ...(run.conversationId ? { externalId: run.conversationId } : {}) };
  }
  return channel;
}

function openClawCreatorFromTrajectoryRun(run) {
  if (!run.senderName && !run.senderId) return undefined;
  return {
    kind: "human",
    label: run.senderName || run.senderId || "未知发起人",
    ...(run.senderId ? { externalId: run.senderId } : {}),
  };
}

function applyOpenClawLinkedConversationEvidence(workItem, { runtimeId, sessionKey, channel }) {
  if (!runtimeId || !sessionKey || !channel) return;
  if (!shouldPreferOpenClawConversationEvidence(workItem.channel, channel)) return;
  workItem.channel = channel;
  workItem.conversationId = `${runtimeId}:conversation:${sanitizeId(sessionKey)}`;
}

function shouldPreferOpenClawConversationEvidence(current, candidate) {
  if (!candidate) return false;
  if (!current) return true;
  if (current.kind !== "dingtalk" || candidate.kind !== "dingtalk") return false;

  const currentGenerated = isGeneratedOpenClawDingTalkFallback(current.label);
  const candidateGenerated = isGeneratedOpenClawDingTalkFallback(candidate.label);
  if (!currentGenerated) return false;

  if (isGeneratedOpenClawDingTalkDirect(candidate.label)) return true;
  return !candidateGenerated;
}

function isGeneratedOpenClawDingTalkFallback(label) {
  return /^DingTalk\s+(群聊|私聊)(?:\s+.+)?$/i.test(String(label || "").trim());
}

function isGeneratedOpenClawDingTalkDirect(label) {
  return /^DingTalk\s+私聊(?:\s+.+)?$/i.test(String(label || "").trim());
}

function collectOpenClawWorkState(deviceId, observedAt) {
  if (!commandExists("openclaw")) {
    return {
      workItems: [],
      conversations: [],
      executions: [],
      capabilities: [openClawWorkStateCapability(observedAt)],
      warnings: ["OpenClaw work-state probe unavailable: openclaw command not found."],
    };
  }

  const health = runJson("openclaw", ["health", "--json", "--timeout", "5000"]);
  const status = runJson("openclaw", ["status", "--json", "--timeout", "5000"]);
  const taskReport = runJson("openclaw", ["tasks", "list", "--json"], 20_000);
  const tasks = toArray(taskReport, ["tasks"]);
  const gateway = status?.gateway;
  const runtimeId = makeRuntimeId(deviceId, "openclaw", gateway?.url ? `gateway-${gateway.url}` : "gateway-local");
  const sessionMap = new Map();
  const dingtalkState = readOpenClawDingTalkState();
  const trajectoryRuns = readOpenClawTrajectoryRuns();
  const workItemByMessageId = new Map();
  const workItemIdByMessageId = new Map();
  const visibleWorkItemIds = new Set();
  const messageLinkCandidates = [];
  const workItemByTaskId = new Map();
  const workItemByTrajectoryRunId = new Map();
  const coveredRunIds = new Set();

  const healthAgents = toArray(health?.agents, ["agents"]);
  const statusAgents = toArray(status?.agents?.agents || status?.agents, ["agents"]);
  for (const agent of [...healthAgents, ...statusAgents]) {
    const agentExternalId = agent?.agentId || agent?.agent_id || agent?.id || "main";
    const agentId = makeAgentId(runtimeId, agentExternalId);
    const recentSessions = [
      ...toArray(agent?.sessions?.recent, ["sessions"]),
      ...toArray(agent?.sessions?.recentSessions, ["sessions"]),
      ...toArray(agent?.recentSessions, ["sessions"]),
    ];
    for (const session of recentSessions) addOpenClawSession(sessionMap, runtimeId, agentId, session, observedAt, session?.status || "unknown");
  }

  for (const message of dingtalkState.messages) {
    if (message.direction !== "inbound") continue;
    const target = dingtalkState.targetsByConversationId.get(message.conversationId);
    const channel = openClawDingTalkChannel(message.conversationId, dingtalkState.targetsByConversationId, target?.kind || "group");
    const creator = message.senderName || message.senderId
      ? { kind: "human", label: message.senderName || message.senderId || "未知发起人", ...(message.senderId ? { externalId: message.senderId } : {}) }
      : undefined;
    const agentId = makeAgentId(runtimeId, "main");
    addOpenClawSession(
      sessionMap,
      runtimeId,
      agentId,
      {
        sessionKey: message.sessionKey,
        title: channel.label,
        channel,
        ...(creator ? { participants: [creator] } : {}),
        lastActivityAt: message.updatedAt || message.createdAt || target?.lastSeenAt,
        status: "active",
      },
      observedAt,
      "active",
    );
    const workItemId = `${runtimeId}:work-item:${sanitizeId(message.msgId)}`;
    messageLinkCandidates.push({
      messageId: message.msgId,
      sessionKey: message.sessionKey,
      conversationId: message.conversationId,
      text: message.text,
      senderId: message.senderId,
      senderName: message.senderName,
      occurredAt: message.updatedAt || message.createdAt,
    });
    const workItem = {
      id: workItemId,
      source: "openclaw",
      externalId: message.msgId,
      title: messageTitle(message.text),
      ...(message.text ? { description: message.text } : {}),
      status: "todo",
      channel,
      ...(creator ? { creator } : {}),
      agentId,
      runtimeId,
      conversationId: `${runtimeId}:conversation:${sanitizeId(message.sessionKey)}`,
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      ...(message.updatedAt ? { updatedAt: message.updatedAt } : {}),
      lastSeenAt: observedAt,
      sourceRefs: [{ source: "openclaw", externalId: message.msgId }],
    };
    workItemByMessageId.set(message.msgId, workItem);
    workItemIdByMessageId.set(message.msgId, workItemId);
  }

  const executions = tasks.map((task) => {
    const taskId = task.taskId || task.task_id || task.id || task.runId || "task";
    const runId = task.runId || task.run_id || taskId;
    coveredRunIds.add(String(runId));
    const agentExternalId = task.agentId || task.agent_id || "main";
    const agentId = makeAgentId(runtimeId, agentExternalId);
    const sessionKey = task.requesterSessionKey || task.requester_session_key || task.childSessionKey || task.child_session_key || task.sessionKey || task.session_key;
    const origin = extractOpenClawOrigin(task);
    const messageId = extractOpenClawMessageId(task);
    const executionStatus = normalizeOpenClawExecutionStatus(task.status);
    const sessionChannel = sessionKey ? openClawChannelFromDingTalkSession(sessionKey, dingtalkState.targetsByConversationId) : undefined;
    let workItemId = messageId ? workItemIdByMessageId.get(String(messageId)) : undefined;
    let executionConversationId = sessionKey ? `${runtimeId}:conversation:${sanitizeId(sessionKey)}` : undefined;
    if (messageId && workItemId) {
      const workItem = workItemByMessageId.get(String(messageId));
      if (workItem) {
        visibleWorkItemIds.add(workItem.id);
        workItem.status = normalizeOpenClawMessageStatus(executionStatus);
        applyOpenClawLinkedConversationEvidence(workItem, { runtimeId, sessionKey, channel: sessionChannel });
        executionConversationId = workItem.conversationId || executionConversationId;
      }
    }
    if (sessionKey) {
      addOpenClawSession(
        sessionMap,
        runtimeId,
        agentId,
        {
          sessionKey,
          ...(sessionChannel ? { title: sessionChannel.label, channel: sessionChannel } : {}),
          lastEventAt: task.lastEventAt || task.last_event_at || task.startedAt || task.started_at,
          status: executionStatus === "running" ? "active" : "idle",
        },
        observedAt,
        executionStatus === "running" ? "active" : "idle",
      );
    }
    if (!workItemId && shouldCreateOpenClawTaskWorkItem(task, origin)) {
      const workItem = createOpenClawTaskWorkItem({
        task,
        origin,
        runtimeId,
        agentId,
        sessionKey,
        executionStatus,
        observedAt,
        dingtalkState,
      });
      workItemByTaskId.set(String(taskId), workItem);
      visibleWorkItemIds.add(workItem.id);
      workItemId = workItem.id;
    }
    const error = task.error || task.lastError || task.last_error;
    const executionKey = taskId && String(taskId) !== String(runId)
      ? `${sanitizeId(runId)}-${sanitizeId(taskId)}`
      : sanitizeId(runId);
    return {
      id: `${runtimeId}:execution:${executionKey}`,
      source: "openclaw",
      externalId: String(runId),
      runtimeId,
      agentId,
      ...(workItemId ? { workItemId } : {}),
      ...(executionConversationId ? { conversationId: executionConversationId } : {}),
      status: executionStatus,
      ...(toIsoTimestamp(task.createdAt || task.created_at) ? { queuedAt: toIsoTimestamp(task.createdAt || task.created_at) } : {}),
      ...(toIsoTimestamp(task.startedAt || task.started_at) ? { startedAt: toIsoTimestamp(task.startedAt || task.started_at) } : {}),
      ...(toIsoTimestamp(task.endedAt || task.ended_at || task.completedAt || task.completed_at) ? { endedAt: toIsoTimestamp(task.endedAt || task.ended_at || task.completedAt || task.completed_at) } : {}),
      lastSeenAt: toIsoTimestamp(task.lastEventAt || task.last_event_at || task.endedAt || task.ended_at || task.startedAt || task.started_at) || observedAt,
      ...(error ? { error: String(error).slice(0, 240) } : {}),
      sourceRefs: [{ source: "openclaw", externalId: String(taskId) }],
    };
  });

  const trajectoryExecutions = [];
  for (const run of trajectoryRuns) {
    if (coveredRunIds.has(String(run.runId))) continue;
    if (!shouldCreateOpenClawTrajectoryWorkItem(run)) continue;
    const executionStatus = normalizeOpenClawTrajectoryExecutionStatus(run);
    const agentId = makeAgentId(runtimeId, run.agentExternalId || "main");
    const channel = openClawChannelFromDingTalkSession(run.sessionKey, dingtalkState.targetsByConversationId);
    addOpenClawSession(
      sessionMap,
      runtimeId,
      agentId,
      {
        sessionKey: run.sessionKey,
        title: channel?.label,
        ...(channel ? { channel } : {}),
        lastEventAt: run.lastEventAt || run.endedAt || run.startedAt,
        status: executionStatus === "running" ? "active" : "idle",
      },
      observedAt,
      executionStatus === "running" ? "active" : "idle",
    );
    const linkedMessageId = run.messageId
      ? String(run.messageId)
      : findOpenClawMessageLink(messageLinkCandidates, {
          sessionKey: run.sessionKey,
          conversationId: run.conversationId,
          text: run.prompt,
          senderId: run.senderId,
          senderName: run.senderName,
          occurredAt: run.startedAt || run.lastEventAt || run.endedAt,
        });
    let workItemId = linkedMessageId ? workItemIdByMessageId.get(linkedMessageId) : undefined;
    let conversationId = `${runtimeId}:conversation:${sanitizeId(run.sessionKey)}`;
    if (linkedMessageId && workItemId) {
      const linkedWorkItem = workItemByMessageId.get(linkedMessageId);
      if (linkedWorkItem) {
        visibleWorkItemIds.add(linkedWorkItem.id);
        linkedWorkItem.status = normalizeOpenClawMessageStatus(executionStatus);
        linkedWorkItem.updatedAt = run.endedAt || run.lastEventAt || linkedWorkItem.updatedAt;
        linkedWorkItem.lastSeenAt = run.lastEventAt || run.endedAt || observedAt;
        applyOpenClawLinkedConversationEvidence(linkedWorkItem, { runtimeId, sessionKey: run.sessionKey, channel });
        conversationId = linkedWorkItem.conversationId || conversationId;
      }
    } else {
      const workItem = createOpenClawTrajectoryWorkItem({
        run,
        runtimeId,
        agentId,
        executionStatus,
        observedAt,
        dingtalkState,
      });
      workItemByTrajectoryRunId.set(String(run.runId), workItem);
      visibleWorkItemIds.add(workItem.id);
      workItemId = workItem.id;
      conversationId = workItem.conversationId;
    }
    trajectoryExecutions.push({
      id: `${runtimeId}:execution:${sanitizeId(run.runId)}`,
      source: "openclaw",
      externalId: String(run.runId),
      runtimeId,
      agentId,
      ...(workItemId ? { workItemId } : {}),
      conversationId,
      status: executionStatus,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      lastSeenAt: run.lastEventAt || run.endedAt || observedAt,
      ...(run.error ? { error: String(run.error).slice(0, 240) } : {}),
      sourceRefs: [{ source: "openclaw", externalId: String(run.runId) }],
    });
  }

  const warnings = [];
  if (!taskReport) warnings.push("OpenClaw work-state probe unavailable: openclaw tasks list --json failed or returned non-JSON.");
  if (!health && !status) warnings.push("OpenClaw conversation probe unavailable: health/status failed or returned non-JSON.");
  const visibleWorkItemCount = visibleWorkItemIds.size;

  return {
    workItems: [
      ...Array.from(workItemByMessageId.values()).filter((item) => visibleWorkItemIds.has(item.id)),
      ...Array.from(workItemByTaskId.values()).filter((item) => visibleWorkItemIds.has(item.id)),
      ...Array.from(workItemByTrajectoryRunId.values()).filter((item) => visibleWorkItemIds.has(item.id)),
    ],
    conversations: Array.from(sessionMap.values()),
    executions: [...executions, ...trajectoryExecutions],
    capabilities: [
      openClawWorkStateCapability(observedAt, {
        workItemsSupport: visibleWorkItemCount > 0 ? "partial" : "unsupported",
        workItemsEvidence: visibleWorkItemCount > 0
          ? ["OpenClaw linked DingTalk message context, task origin, or trajectory prompt.submitted exposed user work items."]
          : undefined,
        workItemsLimitations: visibleWorkItemCount > 0
          ? ["OpenClaw has no review phase; creator identity depends on channel message context."]
          : undefined,
        conversationsSupport: health || status || sessionMap.size > 0 ? "partial" : "unknown",
        conversationsEvidence: health || status || sessionMap.size > 0
          ? ["openclaw health/status, task session keys, or trajectory session keys exposed recent session evidence."]
          : undefined,
        executionsSupport: taskReport || trajectoryExecutions.length > 0 ? "supported" : "unknown",
        executionsEvidence: taskReport || trajectoryExecutions.length > 0 ? ["openclaw tasks list --json and trajectory trace.artifacts exposed execution status."] : undefined,
      }),
    ],
    warnings,
  };
}

function runtimeIdFromMulticaRuntime(deviceId, runtime) {
  return makeRuntimeId(deviceId, "multica", runtime?.id || runtime?.name || runtime?.provider || "runtime");
}

function runtimeIdForMulticaAgent(deviceId, agent, runtimeIdByExternalId) {
  return runtimeIdByExternalId.get(agent?.runtime_id || agent?.runtimeId) ||
    makeRuntimeId(deviceId, "multica", agent?.runtime_id || agent?.runtimeId || "unknown-runtime");
}

function collectMulticaWorkState(deviceId, observedAt) {
  if (!commandExists("multica")) {
    return {
      workItems: [],
      conversations: [],
      executions: [],
      capabilities: [multicaWorkStateCapability(observedAt)],
      warnings: ["Multica work-state probe unavailable: multica command not found."],
    };
  }

  const runtimeReport = runJson("multica", ["runtime", "list", "--output", "json"]);
  const agentReport = runJson("multica", ["agent", "list", "--output", "json"]);
  const issueReport = runJson("multica", ["issue", "list", "--output", "json"], 20_000);
  const runtimes = toArray(runtimeReport, ["runtimes"]);
  const agents = toArray(agentReport, ["agents"]);
  const issues = toArray(issueReport, ["issues"]);
  const runtimeIdByExternalId = new Map(
    runtimes.map((runtime) => [runtime.id || runtime.name || runtime.provider, runtimeIdFromMulticaRuntime(deviceId, runtime)]),
  );
  const agentByExternalId = new Map(agents.map((agent) => [agent.id || agent.name, agent]));
  const firstRuntimeId = runtimes.length ? runtimeIdFromMulticaRuntime(deviceId, runtimes[0]) : makeRuntimeId(deviceId, "multica", "unknown-runtime");

  const workItems = issues.map((issue) => {
    const issueId = issue.id || issue.identifier || issue.number || "issue";
    const assigneeId = issue.assignee_id || issue.assigneeId || issue.assignee?.id || issue.assignee;
    const assigneeAgent = assigneeId ? agentByExternalId.get(assigneeId) : undefined;
    const runtimeId = issue.runtime_id
      ? makeRuntimeId(deviceId, "multica", issue.runtime_id)
      : assigneeAgent
        ? runtimeIdForMulticaAgent(deviceId, assigneeAgent, runtimeIdByExternalId)
        : firstRuntimeId;
    const agentId = assigneeId && (issue.assignee_type === "agent" || assigneeAgent)
      ? makeAgentId(runtimeId, assigneeId)
      : undefined;
    return {
      id: `${runtimeId}:work-item:${sanitizeId(issueId)}`,
      source: "multica",
      externalId: String(issueId),
      title: issue.title || issue.name || issue.identifier || String(issueId),
      ...(issue.description ? { description: String(issue.description).slice(0, 500) } : {}),
      status: normalizeMulticaWorkItemStatus(issue.status),
      ...(assigneeId ? { assignee: { kind: issue.assignee_type === "agent" || assigneeAgent ? "agent" : "unknown", label: String(issue.assignee_name || issue.assigneeName || assigneeId), externalId: String(assigneeId) } } : {}),
      ...(issue.creator_id || issue.creatorId || issue.creator ? { creator: { kind: issue.creator_type === "agent" ? "agent" : "human", label: String(issue.creator_name || issue.creatorName || issue.creator_id || issue.creatorId || issue.creator), externalId: String(issue.creator_id || issue.creatorId || issue.creator) } } : {}),
      ...(agentId ? { agentId } : {}),
      runtimeId,
      ...(toIsoTimestamp(issue.created_at || issue.createdAt) ? { createdAt: toIsoTimestamp(issue.created_at || issue.createdAt) } : {}),
      ...(toIsoTimestamp(issue.updated_at || issue.updatedAt) ? { updatedAt: toIsoTimestamp(issue.updated_at || issue.updatedAt) } : {}),
      lastSeenAt: toIsoTimestamp(issue.updated_at || issue.updatedAt || issue.created_at || issue.createdAt) || observedAt,
      sourceRefs: [{ source: "multica", externalId: String(issue.identifier || issueId) }],
    };
  });

  const conversationsById = new Map();
  const executions = [];
  let taskProbeSucceeded = false;
  for (const agent of agents) {
    const agentExternalId = agent.id || agent.name;
    if (!agentExternalId) continue;
    const taskReport = runJson("multica", ["agent", "tasks", String(agentExternalId), "--output", "json"], 20_000);
    if (taskReport) taskProbeSucceeded = true;
    const tasks = toArray(taskReport, ["tasks", "runs"]);
    for (const task of tasks) {
      const taskId = task.id || task.task_id || task.run_id || task.runId || "task";
      const runtimeId = task.runtime_id
        ? makeRuntimeId(deviceId, "multica", task.runtime_id)
        : runtimeIdForMulticaAgent(deviceId, agent, runtimeIdByExternalId);
      const executionAgentId = makeAgentId(runtimeId, task.agent_id || task.agentId || agentExternalId);
      const issueId = task.issue_id || task.issueId;
      const workItemId = issueId ? `${runtimeId}:work-item:${sanitizeId(issueId)}` : undefined;
      const chatSessionId = task.chat_session_id || task.chatSessionId;
      const conversationId = chatSessionId ? `${runtimeId}:conversation:${sanitizeId(chatSessionId)}` : undefined;
      if (chatSessionId) {
        conversationsById.set(chatSessionId, {
          id: conversationId,
          source: "multica",
          externalId: String(chatSessionId),
          status: normalizeMulticaExecutionStatus(task.status) === "running" ? "active" : "idle",
          ...(workItemId ? { workItemId } : {}),
          agentId: executionAgentId,
          runtimeId,
          ...(toIsoTimestamp(task.started_at || task.startedAt || task.created_at || task.createdAt) ? { startedAt: toIsoTimestamp(task.started_at || task.startedAt || task.created_at || task.createdAt) } : {}),
          lastSeenAt: toIsoTimestamp(task.completed_at || task.completedAt || task.started_at || task.startedAt || task.created_at || task.createdAt) || observedAt,
          sourceRefs: [{ source: "multica", externalId: String(chatSessionId) }],
        });
      }
      executions.push({
        id: `${runtimeId}:execution:${sanitizeId(taskId)}`,
        source: "multica",
        externalId: String(taskId),
        runtimeId,
        agentId: executionAgentId,
        ...(workItemId ? { workItemId } : {}),
        ...(conversationId ? { conversationId } : {}),
        status: normalizeMulticaExecutionStatus(task.status),
        ...(toIsoTimestamp(task.created_at || task.createdAt) ? { queuedAt: toIsoTimestamp(task.created_at || task.createdAt) } : {}),
        ...(toIsoTimestamp(task.started_at || task.startedAt || task.dispatched_at || task.dispatchedAt) ? { startedAt: toIsoTimestamp(task.started_at || task.startedAt || task.dispatched_at || task.dispatchedAt) } : {}),
        ...(toIsoTimestamp(task.completed_at || task.completedAt || task.ended_at || task.endedAt) ? { endedAt: toIsoTimestamp(task.completed_at || task.completedAt || task.ended_at || task.endedAt) } : {}),
        lastSeenAt: toIsoTimestamp(task.updated_at || task.updatedAt || task.completed_at || task.completedAt || task.started_at || task.startedAt) || observedAt,
        ...(task.error ? { error: String(task.error).slice(0, 240) } : {}),
        sourceRefs: [{ source: "multica", externalId: String(taskId) }],
      });
    }
  }

  const warnings = [];
  if (!issueReport) warnings.push("Multica work-state probe unavailable: multica issue list --output json failed or returned non-JSON.");
  if (!agentReport) warnings.push("Multica execution probe unavailable: multica agent list --output json failed or returned non-JSON.");
  if (agents.length > 0 && !taskProbeSucceeded) warnings.push("Multica execution probe unavailable: multica agent tasks failed for every agent.");

  return {
    workItems,
    conversations: Array.from(conversationsById.values()),
    executions,
    capabilities: [
      multicaWorkStateCapability(observedAt, {
        workItemsSupport: issueReport ? "supported" : "unknown",
        workItemsEvidence: issueReport ? ["multica issue list --output json exposed issue lifecycle fields."] : undefined,
        conversationsSupport: conversationsById.size > 0 ? "partial" : taskProbeSucceeded ? "partial" : "unknown",
        conversationsEvidence: conversationsById.size > 0 || taskProbeSucceeded ? ["multica agent tasks can expose chat_session_id for task-linked conversations."] : undefined,
        executionsSupport: taskProbeSucceeded ? "supported" : "unknown",
        executionsEvidence: taskProbeSucceeded ? ["multica agent tasks <agent-id> --output json exposed task status and timestamps."] : undefined,
      }),
    ],
    warnings,
  };
}

function normalizeSlockTask(rawTask, runtimeId, agentId, channel, observedAt) {
  const taskId = rawTask.id || rawTask.taskId || rawTask.messageId || rawTask.taskNumber || "task";
  const threadId = rawTask.threadId || rawTask.thread_id;
  const assigneeLabel = readSlockParticipantLabel(rawTask, [
    "claimedByName",
    "claimed_by_name",
    "assigneeName",
    "assignee_name",
    "assignedToName",
    "assigned_to_name",
    "claimedBy",
    "claimed_by",
    "assignee",
    "assignedTo",
    "assigned_to",
  ]);
  const creatorLabel = readSlockParticipantLabel(rawTask, [
    "createdByName",
    "created_by_name",
    "creatorName",
    "creator_name",
    "createdBy",
    "created_by",
    "creator",
    "author",
  ]);
  return {
    id: `${runtimeId}:work-item:${sanitizeId(taskId)}`,
    source: "slock",
    externalId: String(taskId),
    title: rawTask.title || rawTask.content || rawTask.summary || String(taskId),
    status: normalizeSlockWorkItemStatus(rawTask.status || rawTask.taskStatus || rawTask.task_status),
    channel: { kind: "slock", label: channel.label, externalId: channel.externalId },
    ...(assigneeLabel ? { assignee: { kind: "agent", label: assigneeLabel } } : {}),
    ...(creatorLabel ? { creator: { kind: "human", label: creatorLabel } } : {}),
    agentId,
    runtimeId,
    ...(threadId ? { conversationId: `${runtimeId}:conversation:${sanitizeId(threadId)}` } : {}),
    ...(toIsoTimestamp(rawTask.createdAt || rawTask.created_at) ? { createdAt: toIsoTimestamp(rawTask.createdAt || rawTask.created_at) } : {}),
    ...(toIsoTimestamp(rawTask.updatedAt || rawTask.updated_at || rawTask.completedAt || rawTask.completed_at) ? { updatedAt: toIsoTimestamp(rawTask.updatedAt || rawTask.updated_at || rawTask.completedAt || rawTask.completed_at) } : {}),
    lastSeenAt: toIsoTimestamp(rawTask.updatedAt || rawTask.updated_at || rawTask.completedAt || rawTask.completed_at || rawTask.createdAt || rawTask.created_at) || observedAt,
    sourceRefs: [{ source: "slock", externalId: String(rawTask.taskNumber || rawTask.task_number || taskId) }],
  };
}

function readSlockParticipantLabel(source, keys) {
  for (const key of keys) {
    const label = readNamedValue(source?.[key]);
    if (label) return label;
  }
  return "";
}

function readNamedValue(value) {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value !== "object") return "";
  for (const key of ["displayName", "display_name", "name", "username", "handle", "label", "id"]) {
    const nested = value[key];
    if (typeof nested === "string" || typeof nested === "number") return String(nested);
  }
  return "";
}

function readSlockAgentContexts(config) {
  const agentsRoot = path.join(homeDir(), ".slock", "agents");
  if (!existsSync(agentsRoot)) return [];
  const contexts = [];
  for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (config.slockAgentId && entry.name !== config.slockAgentId) continue;
    const agentDir = path.join(agentsRoot, entry.name);
    const tokenPath = path.join(agentDir, ".slock", "agent-token");
    let token = "";
    try {
      token = readFileSync(tokenPath, "utf8").trim();
    } catch {
      // Agent workspaces can exist before the process has received an internal API token.
    }
    contexts.push({ agentExternalId: entry.name, token });
  }
  return contexts;
}

async function fetchSlockInternalJson(serverUrl, agentExternalId, token, pathSuffix, attempts = 2) {
  if (!serverUrl || !token) return null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const url = new URL(`/internal/agent/${encodeURIComponent(agentExternalId)}${pathSuffix}`, serverUrl);
      const response = await fetch(url, {
        headers: { accept: "application/json", authorization: `Bearer ${token}`, "x-agent-id": agentExternalId },
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
      if (response.status === 401 || response.status === 403 || response.status === 404) return null;
    } catch {
      // Retry transient network and timeout failures below.
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

function normalizeSlockChannel(channelEntry) {
  return typeof channelEntry === "string"
    ? { label: channelEntry, externalId: channelEntry }
    : {
        label: channelEntry.label || (channelEntry.name ? `#${channelEntry.name}` : undefined) || channelEntry.externalId || channelEntry.id || "Slock channel",
        externalId: channelEntry.externalId || (channelEntry.name ? `#${channelEntry.name}` : undefined) || channelEntry.id || channelEntry.label || "unknown",
      };
}

function discoverSlockChannels(serverReport, configuredChannels) {
  if (configuredChannels.length > 0) return configuredChannels.map(normalizeSlockChannel);
  return toArray(serverReport, ["channels"])
    .filter((channel) => channel?.type === "channel" && !channel.archivedAt && !channel.deletedAt && channel.joined !== false)
    .map(normalizeSlockChannel);
}

function dedupeById(items) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function appendSlockTasks({ rawTasks, workItems, conversations, runtimeId, agentId, channel, observedAt }) {
  for (const rawTask of rawTasks) {
    const workItem = normalizeSlockTask(rawTask, runtimeId, agentId, channel, observedAt);
    workItems.push(workItem);
    const threadId = rawTask.threadId || rawTask.thread_id;
    if (threadId) {
      conversations.push({
        id: `${runtimeId}:conversation:${sanitizeId(threadId)}`,
        source: "slock",
        externalId: String(threadId),
        status: workItem.status === "done" || workItem.status === "cancelled" ? "closed" : "open",
        channel: workItem.channel,
        title: workItem.title,
        workItemId: workItem.id,
        agentId,
        runtimeId,
        lastActivityAt: workItem.updatedAt,
        lastSeenAt: observedAt,
        sourceRefs: [{ source: "slock", externalId: String(rawTask.messageId || rawTask.id || threadId) }],
      });
    }
  }
}

async function collectSlockWorkState(deviceId, observedAt, config) {
  const runtimeId = makeRuntimeId(deviceId, "slock", "slock-daemon");
  const configuredChannels = Array.isArray(config.slockTaskChannels) ? config.slockTaskChannels : [];
  const hasWorkspace = existsSync(path.join(homeDir(), ".slock", "agents"));
  const agentContexts = readSlockAgentContexts(config);
  const serverUrl = config.slockServerUrl || process.env.SLOCK_SERVER_URL || DEFAULT_SLOCK_SERVER_URL;
  const workItems = [];
  const conversations = [];
  const warnings = [];

  if (serverUrl && agentContexts.some((context) => context.token)) {
    let apiProbeSucceeded = false;
    const failedChannelLabels = new Set();
    const succeededChannelLabels = new Set();
    for (const context of agentContexts) {
      if (!context.token) continue;
      const agentId = makeAgentId(runtimeId, context.agentExternalId);
      const serverReport = await fetchSlockInternalJson(serverUrl, context.agentExternalId, context.token, "/server");
      const channels = discoverSlockChannels(serverReport, configuredChannels);
      for (const channel of channels) {
        const taskReport = await fetchSlockInternalJson(
          serverUrl,
          context.agentExternalId,
          context.token,
          `/tasks?channel=${encodeURIComponent(channel.externalId)}`,
        );
        if (!taskReport) {
          failedChannelLabels.add(channel.label);
          continue;
        }
        apiProbeSucceeded = true;
        succeededChannelLabels.add(channel.label);
        appendSlockTasks({
          rawTasks: toArray(taskReport, ["tasks"]),
          workItems,
          conversations,
          runtimeId,
          agentId,
          channel,
          observedAt,
        });
      }
    }
    if (apiProbeSucceeded) {
      for (const channelLabel of failedChannelLabels) {
        if (!succeededChannelLabels.has(channelLabel)) {
          warnings.push(`Slock task-board API probe failed for channel ${channelLabel}.`);
        }
      }
      return {
        workItems: dedupeById(workItems),
        conversations: dedupeById(conversations),
        executions: [],
        capabilities: [
          slockWorkStateCapability(observedAt, {
            workItemsSupport: "supported",
            workItemsStrategies: ["native_api", "local_state"],
            workItemsEvidence: ["Slock internal agent task API exposed task board fields using local agent token."],
            conversationsSupport: conversations.length > 0 ? "partial" : "unknown",
            conversationsStrategies: ["native_api", "local_state"],
            conversationsEvidence: conversations.length > 0 ? ["Slock internal task API exposed threadId/messageId for conversation linkage."] : undefined,
          }),
        ],
        warnings,
      };
    }
  }

  if (!commandExists("slock") || configuredChannels.length === 0) {
    const apiReason = !serverUrl
      ? "slockServerUrl is empty"
      : agentContexts.length === 0
          ? "Slock agent workspace not found"
          : !agentContexts.some((context) => context.token)
            ? "Slock agent token not found"
            : "Slock internal API probe failed";
    const reason = !commandExists("slock")
      ? `${apiReason}; slock command not found`
      : "config.slockTaskChannels is empty and internal channel discovery failed";
    return {
      workItems: [],
      conversations: [],
      executions: [],
      capabilities: [
        slockWorkStateCapability(observedAt, {
          workItemsEvidence: hasWorkspace
            ? [`Slock workspace agent files exist, but task-board probe is unavailable: ${reason}.`]
            : [`Slock task-board probe is unavailable: ${reason}.`],
          conversationsEvidence: [`Slock conversation probe is unavailable: ${reason}.`],
        }),
      ],
      warnings: [`Slock work-state probe unavailable: ${reason}.`],
    };
  }

  const agentId = makeAgentId(runtimeId, config.slockAgentId || "unknown-agent");
  for (const channelEntry of configuredChannels) {
    const channel = normalizeSlockChannel(channelEntry);
    const taskReport = runJson("slock", ["task", "list", "--channel", channel.externalId, "--output", "json"], 20_000) ||
      runJson("slock", ["task", "list", "--channel", channel.externalId], 20_000);
    if (!taskReport) {
      warnings.push(`Slock task-board probe failed for channel ${channel.label}.`);
      continue;
    }
    const tasks = toArray(taskReport, ["tasks"]);
    appendSlockTasks({ rawTasks: tasks, workItems, conversations, runtimeId, agentId, channel, observedAt });
  }

  return {
    workItems,
    conversations,
    executions: [],
    capabilities: [
      slockWorkStateCapability(observedAt, {
        workItemsSupport: workItems.length > 0 || warnings.length < channels.length ? "supported" : "unknown",
        workItemsEvidence: workItems.length > 0 || warnings.length < channels.length
          ? ["slock task list --channel <channel> exposed task board fields."]
          : undefined,
        conversationsSupport: conversations.length > 0 ? "partial" : "unknown",
        conversationsEvidence: conversations.length > 0 ? ["Slock task board exposed threadId/messageId for conversation linkage."] : undefined,
      }),
    ],
    warnings,
  };
}

function mergeWorkStateParts(parts) {
  return {
    workItems: parts.flatMap((part) => part.workItems),
    conversations: parts.flatMap((part) => part.conversations),
    executions: parts.flatMap((part) => part.executions),
    capabilities: parts.flatMap((part) => part.capabilities),
    warnings: parts.flatMap((part) => part.warnings || []),
  };
}

async function collectWorkStateSnapshot(config, args) {
  if (!isInternalLegacyCollectorMode()) return collectWorkStateViaLorumeCli(config, args);

  const mergedConfig = {
    ...config,
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
    ...(args.deviceName ? { deviceName: args.deviceName } : {}),
  };
  const observedAt = isoNow();
  let device;
  if (args.fixturePath) {
    try {
      device = applyDeviceOverrides(readJsonFile(args.fixturePath), mergedConfig).device;
    } catch {
      device = createDevice(mergedConfig, observedAt);
    }
  } else {
    device = createDevice(mergedConfig, observedAt);
  }
  const slock = await collectSlockWorkState(device.id, observedAt, mergedConfig);
  const collected = mergeWorkStateParts([
    collectOpenClawWorkState(device.id, observedAt),
    collectMulticaWorkState(device.id, observedAt),
    slock,
  ]);

  return {
    observedAt,
    deviceId: device.id,
    workItems: collected.workItems,
    conversations: collected.conversations,
    executions: collected.executions,
    capabilities: collected.capabilities,
    ...(collected.warnings.length ? { warnings: collected.warnings } : {}),
  };
}

async function collectWorkStateViaLorumeCli(config, args) {
  const cliArgs = ["collect", "work-state", "--json"];
  if (args.configPath) cliArgs.push("--config", args.configPath);
  const identity = resolveCliDeviceIdentity(config, args);
  if (identity.deviceId) cliArgs.push("--device-id", identity.deviceId);
  return stripCliCommand(runLorumeCliJson(config, cliArgs));
}

async function collectAgentSkillProbeViaLorumeCli(config, message) {
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  const targetAgentId = payload.targetAgentId || message.targetAgentId;
  if (!targetAgentId || typeof targetAgentId !== "string") {
    throw new Error("agent.skill_probe missing targetAgentId");
  }
  const cliArgs = ["agent", "skill-probe", "--json", "--agent-id", targetAgentId];
  if (typeof payload.runtimeId === "string" && payload.runtimeId) cliArgs.push("--runtime-id", payload.runtimeId);
  if (typeof message.deviceId === "string" && message.deviceId) cliArgs.push("--device-id", message.deviceId);
  if (typeof payload.targetAgentName === "string" && payload.targetAgentName) cliArgs.push("--agent-name", payload.targetAgentName);
  if (typeof payload.runtimeName === "string" && payload.runtimeName) cliArgs.push("--runtime-name", payload.runtimeName);
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
    env: {
      ...process.env,
      LORUME_CLI_USE_COLLECTOR_ADAPTERS: "1",
      LORUME_COLLECTOR_INTERNAL_LEGACY: "1",
    },
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

function isInternalLegacyCollectorMode() {
  return process.env.LORUME_COLLECTOR_INTERNAL_LEGACY === "1";
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

async function handleControlMessage(socket, rawMessage, config, args, seenCommandIds, refresh) {
  let message;
  try {
    message = JSON.parse(String(rawMessage));
  } catch {
    sendControlMessage(socket, { type: "error", error: "invalid control message json" });
    return;
  }

  if (message.type === "agent.skill_probe") {
    await handleAgentSkillProbeCommand(socket, message, config, args, seenCommandIds);
    return;
  }
  if (message.type !== "inventory.refresh") return;
  if (!message.commandId) {
    sendControlMessage(socket, { type: "error", error: "inventory.refresh missing commandId" });
    return;
  }
  if (seenCommandIds.has(message.commandId)) {
    sendControlMessage(socket, {
      type: "command.result",
      commandId: message.commandId,
      deviceId: message.deviceId || config.deviceId || args.deviceId,
      status: "succeeded",
      result: { duplicate: true },
    });
    return;
  }

  seenCommandIds.add(message.commandId);
  sendControlMessage(socket, {
    type: "command.accepted",
    commandId: message.commandId,
    deviceId: message.deviceId || config.deviceId || args.deviceId,
  });

  try {
    const { inventorySnapshot, workStateSnapshot } = await refresh();
    sendControlMessage(socket, {
      type: "command.result",
      commandId: message.commandId,
      deviceId: inventorySnapshot.device.id,
      status: "succeeded",
      result: {
        observedAt: inventorySnapshot.observedAt,
        workStateObservedAt: workStateSnapshot.observedAt,
      },
    });
  } catch (error) {
    sendControlMessage(socket, {
      type: "command.result",
      commandId: message.commandId,
      deviceId: message.deviceId || config.deviceId || args.deviceId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleAgentSkillProbeCommand(socket, message, config, args, seenCommandIds) {
  if (!message.commandId) {
    sendControlMessage(socket, { type: "error", error: "agent.skill_probe missing commandId" });
    return;
  }
  if (seenCommandIds.has(message.commandId)) {
    sendControlMessage(socket, {
      type: "command.result",
      commandId: message.commandId,
      deviceId: message.deviceId || config.deviceId || args.deviceId,
      status: "succeeded",
      result: { duplicate: true },
    });
    return;
  }

  seenCommandIds.add(message.commandId);
  sendControlMessage(socket, {
    type: "command.accepted",
    commandId: message.commandId,
    deviceId: message.deviceId || config.deviceId || args.deviceId,
  });

  try {
    const snapshot = await collectAgentSkillProbeViaLorumeCli(config, message);
    const serverUrl = resolveServerUrl(config, args);
    if (serverUrl) await postAgentSkillProbeSnapshot(serverUrl, snapshot, resolveDeviceToken(config, args));
    sendControlMessage(socket, {
      type: "command.result",
      commandId: message.commandId,
      deviceId: snapshot.deviceId || message.deviceId || config.deviceId || args.deviceId,
      status: "succeeded",
      result: {
        observedAt: snapshot.observedAt,
        probedAt: snapshot.probedAt,
        status: snapshot.status,
      },
    });
  } catch (error) {
    sendControlMessage(socket, {
      type: "command.result",
      commandId: message.commandId,
      deviceId: message.deviceId || config.deviceId || args.deviceId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function startControlChannel(config, args, refresh) {
  const wsUrl = resolveWsUrl(config, args);
  if (!wsUrl || typeof WebSocket === "undefined") return;

  const serverUrl = resolveServerUrl(config, args);
  if (!serverUrl && !args.printOnly) return;

  const seenCommandIds = new Set();
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

    socket.addEventListener("message", (event) => {
      void handleControlMessage(socket, event.data, config, args, seenCommandIds, refresh);
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
    startControlChannel(config, args, refresh);
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
