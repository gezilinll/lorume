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
  const trajectoryMapping = collectOpenClawProductTrajectoryTasks({
    runs: readOpenClawTrajectoryRuns(),
    knownAgentIds,
    runtimeId: runtime.id,
    observedAt,
  });
  const agentIds = Array.from(new Set([
    ...knownAgentIds,
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

  const warnings = [...trajectoryMapping.warnings];

  return { runtimes: [runtime], agents, tasks: trajectoryMapping.tasks, warnings };
}

function collectOpenClawProductTrajectoryTasks({ runs, knownAgentIds, runtimeId, observedAt }) {
  const dingtalkState = readOpenClawDingTalkState();
  const tasks = [];
  const warnings = [];
  const agentExternalIds = new Set();

  for (const run of runs) {
    const taskType = inferOpenClawTaskType(run);
    if (!shouldCreateOpenClawTrajectoryTask(run, taskType)) continue;
    const runId = String(run.runId || "run");
    const agentResolution = resolveOpenClawTrajectoryAgentExternalId(run, knownAgentIds);
    if (!agentResolution.agentExternalId) {
      warnings.push(`Skipped OpenClaw trajectory run ${runId}: ${agentResolution.reason}.`);
      continue;
    }
    if (knownAgentIds.length && !knownAgentIds.includes(agentResolution.agentExternalId)) {
      warnings.push(`Skipped OpenClaw trajectory run ${runId}: agent ${agentResolution.agentExternalId} is not in collected OpenClaw agents.`);
      continue;
    }

    const agentId = makeAgentId(runtimeId, agentResolution.agentExternalId);
    agentExternalIds.add(agentResolution.agentExternalId);
    const legacyChannel = openClawChannelFromTrajectoryRun(run, dingtalkState.targetsByConversationId);
    const channel = legacyChannel ? openClawProductChannel(legacyChannel) : undefined;
    const lastActivityAt = run.lastEventAt || run.endedAt || run.startedAt;
    const prompt = cleanOpenClawPromptText(run.prompt);
    const status = normalizeOpenClawTrajectoryProductTaskStatus(run);
    const toolError = firstOpenClawFailedToolCallError(run.toolCalls);
    const error = openClawTrajectoryError(run) || toolError;
    const sourceExternalId = run.messageId || runId;

    tasks.push({
      id: makeProductTaskId(agentId, runId),
      agentId,
      taskType,
      title: messageTitle(prompt),
      description: prompt,
      status,
      source: { kind: "openclaw", externalId: String(sourceExternalId) },
      ...(channel ? { channel } : {}),
      ...(channel ? { conversation: {
        title: channel.name || channel.kind,
        ...(openClawProductConversationExternalId(run.sessionKey, run.conversationId) ? { externalId: openClawProductConversationExternalId(run.sessionKey, run.conversationId) } : {}),
        ...(lastActivityAt ? { lastActivityAt } : {}),
      } } : {}),
      ...(openClawProductCreatorFromTrajectoryRun(run) ? { creator: openClawProductCreatorFromTrajectoryRun(run) } : {}),
      ...(run.toolCalls?.length ? { toolCalls: run.toolCalls } : {}),
      raw: {
        openclaw: {
          status: openClawRawTrajectoryStatus(run),
          statusSource: "trajectory",
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
          ...(run.messageId ? { messageId: run.messageId } : {}),
          trajectoryRunId: runId,
        },
      },
      ...(run.startedAt ? { createdAt: run.startedAt } : {}),
      ...(lastActivityAt ? { updatedAt: lastActivityAt, lastSeenAt: lastActivityAt } : { lastSeenAt: observedAt }),
      ...(status === "failed" && error ? { error } : {}),
    });
  }

  return { tasks, warnings, agentExternalIds: Array.from(agentExternalIds) };
}

function resolveOpenClawTrajectoryAgentExternalId(run, knownAgentIds) {
  const sessionAgentId = openClawAgentIdFromSessionKey(run.sessionKey);
  if (sessionAgentId) return { agentExternalId: sessionAgentId };
  if (run.agentExternalId) return { agentExternalId: String(run.agentExternalId) };
  if (knownAgentIds.length === 1) return { agentExternalId: String(knownAgentIds[0]) };
  if (knownAgentIds.length > 1) return { reason: "ambiguous OpenClaw agent ownership" };
  if (run.fileAgentExternalId) return { agentExternalId: String(run.fileAgentExternalId) };
  return { reason: "missing OpenClaw agent ownership" };
}

function openClawAgentIdFromSessionKey(sessionKey) {
  return parseOpenClawSessionKey(sessionKey)?.agentExternalId || "";
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

function openClawTrajectoryError(run) {
  return run.error ? String(run.error).slice(0, 240) : "";
}

function openClawRawTrajectoryStatus(run) {
  if (run.finalStatus) return String(run.finalStatus);
  if (run.endedStatus) return String(run.endedStatus);
  if (run.aborted) return "aborted";
  if (run.timedOut || run.idleTimedOut) return "timed_out";
  return "running";
}

function openClawProductChannel(channel) {
  return {
    kind: channel?.kind || "other",
    ...(channel?.label ? { name: channel.label } : {}),
    ...(channel?.externalId ? { externalId: channel.externalId } : {}),
  };
}

function openClawProductConversationExternalId(sessionKey, conversationId) {
  return conversationId || parseOpenClawSessionKey(sessionKey)?.conversationId;
}

function openClawProductCreatorFromTrajectoryRun(run) {
  if (!run.senderName && !run.senderId) return undefined;
  return {
    name: String(run.senderName || run.senderId),
    ...(run.senderId ? { externalId: String(run.senderId) } : {}),
  };
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
        runs.push(run);
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
      agentExternalId: event.data?.agentId || event.agentId || "",
      fileAgentExternalId: fallbackAgentId || "",
    };
    current.sessionKey ||= event.sessionKey || event.session_key || event.data?.sessionKey || event.data?.session_key || "";
    current.agentExternalId ||= event.data?.agentId || event.agentId || "";
    current.fileAgentExternalId ||= fallbackAgentId || "";
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
      run.toolCalls = sessionDetails.toolCalls;
      run.sessionId ||= sessionDetails.sessionId;
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
    return { prompt: "", runtimeContext: null, sessionId: openClawSessionIdFromFile(sessionFile), toolCalls: [] };
  }

  let prompt = "";
  let runtimeContext = null;
  const toolCalls = collectOpenClawToolCalls(records);
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
  return { prompt, runtimeContext, sessionId: openClawSessionIdFromFile(sessionFile), toolCalls };
}

function collectOpenClawToolCalls(records) {
  const calls = new Map();
  for (const record of records) {
    for (const call of extractOpenClawToolCalls(record)) {
      calls.set(call.id, {
        ...(calls.get(call.id) || {}),
        ...call,
        status: calls.get(call.id)?.status || "unknown",
      });
    }
    for (const result of extractOpenClawToolResults(record)) {
      const existing = calls.get(result.id);
      if (!existing) continue;
      calls.set(result.id, {
        ...existing,
        status: result.isError ? "failed" : "done",
        ...(result.resultPreview ? { resultPreview: result.resultPreview } : {}),
        ...(result.isError && result.error ? { error: result.error } : {}),
      });
    }
  }
  return Array.from(calls.values()).filter((call) => call.id && call.name);
}

function extractOpenClawToolCalls(record) {
  const candidates = [];
  if (record?.toolCall) candidates.push(record.toolCall);
  if (record?.data?.toolCall) candidates.push(record.data.toolCall);
  if (record?.type === "toolCall" || record?.type === "tool_call") candidates.push(record.data || record);
  const toolCalls = record?.tool_calls || record?.message?.tool_calls || record?.data?.tool_calls;
  if (Array.isArray(toolCalls)) candidates.push(...toolCalls);
  for (const part of openClawContentParts(record)) {
    if (part?.type === "tool_call" || part?.type === "toolCall" || part?.type === "tool_use") candidates.push(part);
    if (part?.toolCall) candidates.push(part.toolCall);
  }

  return candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") return null;
      const fn = candidate.function || {};
      const id = candidate.id || candidate.toolCallId || candidate.tool_call_id || candidate.callId || candidate.call_id;
      const name = candidate.name || candidate.toolName || candidate.tool_name || fn.name;
      if (!id || !name) return null;
      const args = candidate.arguments ?? candidate.args ?? candidate.input ?? fn.arguments;
      return {
        id: String(id),
        name: String(name),
        status: "unknown",
        ...(args !== undefined ? { arguments: parseOpenClawToolArguments(args) } : {}),
      };
    })
    .filter(Boolean);
}

function extractOpenClawToolResults(record) {
  const candidates = [];
  if (record?.toolResult) candidates.push(record.toolResult);
  if (record?.data?.toolResult) candidates.push(record.data.toolResult);
  if (record?.type === "toolResult" || record?.type === "tool_result") candidates.push(record.data || record);
  if (record?.role === "tool" || record?.message?.role === "tool") candidates.push(record);
  for (const part of openClawContentParts(record)) {
    if (part?.type === "tool_result" || part?.type === "toolResult") candidates.push(part);
    if (part?.toolResult) candidates.push(part.toolResult);
  }

  return candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") return null;
      const id = candidate.toolCallId || candidate.tool_call_id || candidate.id || candidate.callId || candidate.call_id;
      if (!id) return null;
      const content = candidate.content ?? candidate.output ?? candidate.result ?? candidate.error;
      const resultPreview = previewOpenClawToolResult(content);
      const isError = Boolean(candidate.isError || candidate.is_error || candidate.error);
      return {
        id: String(id),
        isError,
        ...(resultPreview ? { resultPreview } : {}),
        ...(isError && resultPreview ? { error: resultPreview } : {}),
      };
    })
    .filter(Boolean);
}

function openClawContentParts(record) {
  const content = record?.content ?? record?.message?.content ?? record?.data?.content;
  return Array.isArray(content) ? content : [];
}

function parseOpenClawToolArguments(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const parsed = parseJsonMaybe(trimmed);
  return parsed ?? value;
}

function previewOpenClawToolResult(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function firstOpenClawFailedToolCallError(toolCalls = []) {
  return toolCalls.find((toolCall) => toolCall.status === "failed")?.error || "";
}

function openClawSessionIdFromFile(sessionFile) {
  const name = path.basename(String(sessionFile || ""));
  return name.replace(/\.session\.jsonl$/i, "").replace(/\.jsonl$/i, "") || undefined;
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

function inferOpenClawTaskType(run) {
  const prompt = cleanOpenClawPromptText(run?.prompt);
  const session = parseOpenClawSessionKey(run?.sessionKey);
  if (session?.taskType) return session.taskType;
  if (/^\[cron:/i.test(prompt)) return "scheduled";
  return null;
}

function shouldCreateOpenClawTrajectoryTask(run, taskType = inferOpenClawTaskType(run)) {
  const prompt = cleanOpenClawPromptText(run?.prompt);
  if (!prompt) return false;
  if (prompt === "HEARTBEAT_OK" || /^\[OpenClaw heartbeat poll\]/i.test(prompt)) return false;
  if (/^\[[^\]]+\]\s+An async command the user already approved has completed/i.test(prompt)) return false;
  if (/^\[[^\]]+\]\s+\[System\]/i.test(prompt)) return false;
  return taskType === "conversation" || taskType === "scheduled";
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

function parseOpenClawSessionKey(sessionKey) {
  const raw = String(sessionKey || "");
  const agentMatch = /^agent:([^:]+):([^:]+)(?::(.+))?$/.exec(raw);
  const body = agentMatch ? `${agentMatch[2]}${agentMatch[3] ? `:${agentMatch[3]}` : ""}` : raw;

  const dingtalkMatch = /^dingtalk:(group|direct):(.+)$/.exec(body);
  if (dingtalkMatch?.[2]) {
    return {
      agentExternalId: agentMatch?.[1] || "",
      channelKind: "dingtalk",
      conversationId: dingtalkMatch[2],
      conversationKind: dingtalkMatch[1],
      taskType: "conversation",
    };
  }

  const webchatMatch = /^webchat:(.+)$/.exec(body);
  if (webchatMatch?.[1]) {
    return {
      agentExternalId: agentMatch?.[1] || "",
      channelKind: "webchat",
      conversationId: webchatMatch[1],
      taskType: "conversation",
    };
  }

  const cronMatch = /^cron(?::(.+))?$/.exec(body);
  if (cronMatch) {
    return {
      agentExternalId: agentMatch?.[1] || "",
      channelKind: "cron",
      conversationId: cronMatch[1] || "",
      taskType: "scheduled",
    };
  }

  return agentMatch?.[1] ? { agentExternalId: agentMatch[1] } : null;
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
  const session = parseOpenClawSessionKey(run.sessionKey);
  if (session?.channelKind === "dingtalk") {
    const conversationId = run.conversationId || session.conversationId;
    const channel = openClawDingTalkChannel(conversationId, targetsByConversationId, session.conversationKind || "group");
    const metadataLabel = run.groupSubject || run.conversationLabel;
    if (metadataLabel && String(channel.label || "").startsWith("DingTalk ")) {
      return { ...channel, label: metadataLabel, ...(run.conversationId ? { externalId: run.conversationId } : {}) };
    }
    return channel;
  }
  if (session?.channelKind === "webchat") {
    const conversationId = run.conversationId || session.conversationId;
    return {
      kind: "webchat",
      label: run.conversationLabel || "OpenClaw Web Chat",
      ...(conversationId ? { externalId: conversationId } : {}),
    };
  }
  return undefined;
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
