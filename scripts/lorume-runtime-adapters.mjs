import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, arch, platform, networkInterfaces, userInfo } from "node:os";
import path from "node:path";

export const COLLECTOR_VERSION = "0.1.0";

const DEFAULT_PROBE_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function homeDir() {
  return process.env.LORUME_COLLECTOR_HOME || homedir();
}

function isoNow() {
  return new Date().toISOString();
}

function sanitizeId(value) {
  return String(value || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function makeAgentId(runtimeId, externalId) {
  return `${runtimeId}:agent:${sanitizeId(externalId)}`;
}

function makeProductRuntimeId(deviceId, kind) {
  return `${sanitizeId(deviceId)}:runtime:${sanitizeId(kind)}`;
}

function enabledRuntimeAdapters(config = {}) {
  const raw = process.env.LORUME_ENABLED_RUNTIME_ADAPTERS || config.enabledRuntimeAdapters || "openclaw";
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  return new Set(values.map((value) => sanitizeId(value)).filter(Boolean));
}

function adapterEnabled(config, adapter) {
  return enabledRuntimeAdapters(config).has(adapter);
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

function createProductRuntime({ deviceId, kind, name, version, collectionStatus, lastSeenAt, diagnostics }) {
  return {
    id: makeProductRuntimeId(deviceId, kind),
    deviceId,
    kind,
    name,
    ...(version ? { version } : {}),
    collectionStatus,
    lastSeenAt,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function createProductAgent({ runtimeId, externalId, name, collectionStatus, lastSeenAt, diagnostics }) {
  return {
    id: makeAgentId(runtimeId, externalId),
    runtimeId,
    name,
    collectionStatus,
    lastSeenAt,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function makeProductTaskId(agentId, externalId) {
  return `${agentId}:task:${sanitizeId(externalId)}`;
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

function collectOpenClawDeviceState(deviceId, observedAt) {
  const config = readOpenClawConfig();
  const health = runJson("openclaw", ["health", "--json", "--timeout", "5000"]);
  const status = runJson("openclaw", ["status", "--json", "--timeout", "5000"]);
  const taskReport = runJson("openclaw", ["tasks", "list", "--json"], 20_000);
  if (!health && !status && !config) return { runtimes: [], agents: [], tasks: [], warnings: [] };

  const gateway = status?.gateway;
  const collectionStatus = health?.ok === false || gateway?.reachable === false ? "error" : "online";
  const runtime = createProductRuntime({
    deviceId,
    kind: "openclaw",
    name: "OpenClaw Gateway",
    version: gateway?.self?.version || undefined,
    collectionStatus,
    lastSeenAt: observedAt,
    diagnostics: {
      paths: compactPaths([
        { label: "Config", path: path.join(homeDir(), ".openclaw", "openclaw.json") },
        { label: "Agents", path: path.join(homeDir(), ".openclaw", "agents") },
      ]),
      ...(health?.ok === false ? { lastError: "openclaw health returned ok=false" } : {}),
    },
  });

  const openclawAgents = health?.agents || status?.agents?.agents || [];
  const knownAgentIds = Array.from(new Set([
    ...openclawAgents.map((agent) => agent.agentId || agent.id || "main"),
    ...listOpenClawConfigAgentIds(config),
  ])).filter(Boolean);
  const rawTasks = toArray(taskReport, ["tasks"]);
  const taskMapping = collectOpenClawProductTasks({
    rawTasks,
    knownAgentIds,
    runtimeId: runtime.id,
    observedAt,
  });
  const trajectoryMapping = collectOpenClawProductTrajectoryTasks({
    runs: readOpenClawTrajectoryRuns(),
    knownAgentIds,
    runtimeId: runtime.id,
    observedAt,
    coveredRunIds: new Set(rawTasks.map(openClawTaskRunId).filter(Boolean)),
  });
  const agentIds = Array.from(new Set([
    ...knownAgentIds,
    ...taskMapping.agentExternalIds,
    ...trajectoryMapping.agentExternalIds,
  ])).filter(Boolean);
  const agents = agentIds.map((agentId) =>
    createProductAgent({
      runtimeId: runtime.id,
      externalId: agentId,
      name: agentId,
      collectionStatus: collectionStatus === "error" ? "error" : "online",
      lastSeenAt: observedAt,
      diagnostics: {
        paths: compactPaths([{ label: "Agent", path: path.join(homeDir(), ".openclaw", "agents", agentId) }]),
      },
    }),
  );

  const warnings = [...taskMapping.warnings, ...trajectoryMapping.warnings];
  if (!taskReport) warnings.push("OpenClaw task probe unavailable: openclaw tasks list --json failed or returned non-JSON.");

  return { runtimes: [runtime], agents, tasks: [...taskMapping.tasks, ...trajectoryMapping.tasks], warnings };
}

function collectOpenClawProductTasks({ rawTasks, knownAgentIds, runtimeId, observedAt }) {
  const dingtalkState = readOpenClawDingTalkState();
  const tasks = [];
  const warnings = [];
  const agentExternalIds = new Set();

  for (const rawTask of rawTasks) {
    const taskExternalId = openClawTaskExternalId(rawTask);
    const agentResolution = resolveOpenClawTaskAgentExternalId(rawTask, knownAgentIds);
    if (!agentResolution.agentExternalId) {
      warnings.push(`Skipped OpenClaw task ${taskExternalId}: ${agentResolution.reason}.`);
      continue;
    }

    const agentId = makeAgentId(runtimeId, agentResolution.agentExternalId);
    agentExternalIds.add(agentResolution.agentExternalId);
    const origin = extractOpenClawOrigin(rawTask);
    const sessionKey = rawTask.requesterSessionKey || rawTask.requester_session_key || rawTask.childSessionKey || rawTask.child_session_key || rawTask.sessionKey || rawTask.session_key;
    const legacyChannel = openClawChannelFromOrigin(origin, dingtalkState.targetsByConversationId) ||
      openClawChannelFromDingTalkSession(sessionKey, dingtalkState.targetsByConversationId) ||
      { kind: "openclaw", label: "OpenClaw" };
    const channel = openClawProductChannel(legacyChannel);
    const lastActivityAt = toIsoTimestamp(rawTask.lastEventAt || rawTask.last_event_at || rawTask.endedAt || rawTask.ended_at || rawTask.completedAt || rawTask.completed_at || rawTask.startedAt || rawTask.started_at);
    const titleSource = rawTask.task || rawTask.label || rawTask.title || taskExternalId;

    tasks.push({
      id: makeProductTaskId(agentId, taskExternalId),
      agentId,
      title: messageTitle(titleSource),
      ...(typeof rawTask.task === "string" ? { description: rawTask.task.slice(0, 500) } : {}),
      status: normalizeOpenClawProductTaskStatus(rawTask.status),
      source: { externalId: String(taskExternalId) },
      channel,
      conversation: {
        title: channel.name || channel.kind,
        ...(openClawProductConversationExternalId(origin, sessionKey) ? { externalId: openClawProductConversationExternalId(origin, sessionKey) } : {}),
        ...(lastActivityAt ? { lastActivityAt } : {}),
      },
      ...(openClawProductCreator(origin) ? { creator: openClawProductCreator(origin) } : {}),
      ...(toIsoTimestamp(rawTask.createdAt || rawTask.created_at) ? { createdAt: toIsoTimestamp(rawTask.createdAt || rawTask.created_at) } : {}),
      ...(lastActivityAt ? { updatedAt: lastActivityAt, lastSeenAt: lastActivityAt } : { lastSeenAt: observedAt }),
      ...(rawTask.error || rawTask.lastError || rawTask.last_error ? { error: String(rawTask.error || rawTask.lastError || rawTask.last_error).slice(0, 240) } : {}),
    });
  }

  return { tasks, warnings, agentExternalIds: Array.from(agentExternalIds) };
}

function openClawTaskExternalId(task) {
  return String(task.taskId || task.task_id || task.id || task.runId || task.run_id || "task");
}

function openClawTaskRunId(task) {
  return task.runId || task.run_id || task.taskId || task.task_id || task.id;
}

function collectOpenClawProductTrajectoryTasks({ runs, knownAgentIds, runtimeId, observedAt, coveredRunIds }) {
  const dingtalkState = readOpenClawDingTalkState();
  const tasks = [];
  const warnings = [];
  const agentExternalIds = new Set();

  for (const run of runs) {
    if (!shouldCreateOpenClawTrajectoryTask(run)) continue;
    const runId = String(run.runId || "run");
    if (coveredRunIds.has(runId)) continue;
    const agentResolution = resolveOpenClawTrajectoryAgentExternalId(run, knownAgentIds);
    if (!agentResolution.agentExternalId) {
      warnings.push(`Skipped OpenClaw trajectory run ${runId}: ${agentResolution.reason}.`);
      continue;
    }

    const agentId = makeAgentId(runtimeId, agentResolution.agentExternalId);
    agentExternalIds.add(agentResolution.agentExternalId);
    const legacyChannel = openClawChannelFromTrajectoryRun(run, dingtalkState.targetsByConversationId);
    const channel = openClawProductChannel(legacyChannel);
    const lastActivityAt = run.lastEventAt || run.endedAt || run.startedAt;
    const prompt = cleanOpenClawPromptText(run.prompt);

    tasks.push({
      id: makeProductTaskId(agentId, runId),
      agentId,
      title: messageTitle(prompt),
      description: prompt,
      status: normalizeOpenClawTrajectoryProductTaskStatus(run),
      source: { externalId: runId },
      channel,
      conversation: {
        title: channel.name || channel.kind,
        ...(openClawProductConversationExternalId(null, run.sessionKey) ? { externalId: openClawProductConversationExternalId(null, run.sessionKey) } : {}),
        ...(lastActivityAt ? { lastActivityAt } : {}),
      },
      ...(openClawProductCreatorFromTrajectoryRun(run) ? { creator: openClawProductCreatorFromTrajectoryRun(run) } : {}),
      ...(run.startedAt ? { createdAt: run.startedAt } : {}),
      ...(lastActivityAt ? { updatedAt: lastActivityAt, lastSeenAt: lastActivityAt } : { lastSeenAt: observedAt }),
      ...(run.error ? { error: String(run.error).slice(0, 240) } : {}),
    });
  }

  return { tasks, warnings, agentExternalIds: Array.from(agentExternalIds) };
}

function resolveOpenClawTrajectoryAgentExternalId(run, knownAgentIds) {
  if (run.agentExternalId) return { agentExternalId: String(run.agentExternalId) };
  const sessionAgentId = openClawAgentIdFromSessionKey(run.sessionKey);
  if (sessionAgentId) return { agentExternalId: sessionAgentId };
  if (knownAgentIds.length === 1) return { agentExternalId: String(knownAgentIds[0]) };
  if (knownAgentIds.length > 1) return { reason: "ambiguous OpenClaw agent ownership" };
  return { reason: "missing OpenClaw agent ownership" };
}

function resolveOpenClawTaskAgentExternalId(task, knownAgentIds) {
  const explicitAgentId = task.agentId || task.agent_id || task.assigneeAgentId || task.assignee_agent_id;
  if (explicitAgentId) return { agentExternalId: String(explicitAgentId) };

  const sessionAgentId = openClawAgentIdFromSessionKey(task.requesterSessionKey || task.requester_session_key || task.childSessionKey || task.child_session_key || task.sessionKey || task.session_key);
  if (sessionAgentId) return { agentExternalId: sessionAgentId };

  if (knownAgentIds.length === 1) return { agentExternalId: String(knownAgentIds[0]) };
  if (knownAgentIds.length > 1) return { reason: "ambiguous OpenClaw agent ownership" };
  return { reason: "missing OpenClaw agent ownership" };
}

function openClawAgentIdFromSessionKey(sessionKey) {
  const match = /^agent:([^:]+):/.exec(String(sessionKey || ""));
  return match?.[1] ? String(match[1]) : "";
}

function normalizeOpenClawProductTaskStatus(status) {
  const executionStatus = normalizeOpenClawExecutionStatus(status);
  return normalizeOpenClawExecutionProductTaskStatus(executionStatus);
}

function normalizeOpenClawTrajectoryProductTaskStatus(run) {
  return normalizeOpenClawExecutionProductTaskStatus(normalizeOpenClawTrajectoryExecutionStatus(run));
}

function normalizeOpenClawExecutionProductTaskStatus(executionStatus) {
  if (executionStatus === "queued") return "todo";
  if (executionStatus === "running") return "in_progress";
  if (executionStatus === "succeeded") return "done";
  if (executionStatus === "failed") return "failed";
  if (executionStatus === "cancelled") return "cancelled";
  return "unknown";
}

function openClawProductChannel(channel) {
  return {
    kind: channel?.kind || "other",
    ...(channel?.label ? { name: channel.label } : {}),
    ...(channel?.externalId ? { externalId: channel.externalId } : {}),
  };
}

function openClawProductConversationExternalId(origin, sessionKey) {
  return normalizeOpenClawOriginConversationId(origin) || parseOpenClawDingTalkSession(sessionKey)?.conversationId;
}

function openClawProductCreator(origin) {
  const name = origin?.senderName || origin?.sender_name || origin?.sender || origin?.userName || origin?.user_name;
  const id = origin?.senderId || origin?.sender_id || origin?.userId || origin?.user_id;
  if (!name && !id) return undefined;
  return { name: String(name || id) };
}

function openClawProductCreatorFromTrajectoryRun(run) {
  if (!run.senderName && !run.senderId) return undefined;
  return { name: String(run.senderName || run.senderId) };
}

function compactPaths(paths) {
  return paths.filter((entry) => entry?.path && existsSync(entry.path));
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

function shouldCreateOpenClawTrajectoryTask(run) {
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

function extractOpenClawOrigin(task) {
  return parseJsonMaybe(task.requesterOriginJson || task.requester_origin_json || task.requester_origin);
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

export function collectDeviceStateSnapshot(config = {}, args = {}) {
  const mergedConfig = {
    ...config,
    ...(args.serverUrl ? { serverUrl: args.serverUrl } : {}),
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
  };

  if (args.fixturePath) {
    return applyDeviceOverrides(readJsonFile(args.fixturePath), {
      deviceId: mergedConfig.deviceId,
    });
  }

  const observedAt = isoNow();
  const baseDevice = createDevice(mergedConfig, observedAt);
  const collected = adapterEnabled(mergedConfig, "openclaw")
    ? collectOpenClawDeviceState(baseDevice.id, observedAt)
    : { runtimes: [], agents: [], tasks: [], warnings: [] };

  return {
    observedAt,
    device: {
      ...baseDevice,
      collectionStatus: "online",
      collector: {
        version: COLLECTOR_VERSION,
        ...(config.installDir ? { installPath: config.installDir } : {}),
      },
    },
    runtimes: collected.runtimes,
    agents: collected.agents,
    tasks: collected.tasks,
    ...(collected.warnings.length ? { diagnostics: { warnings: collected.warnings } } : {}),
  };
}
