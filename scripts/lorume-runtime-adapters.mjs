import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, opendirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, arch, platform, networkInterfaces, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { normalizeLocalIpsForDisplay } from "./local-ip-normalization.mjs";

export const COLLECTOR_VERSION = "0.1.0";

const DEFAULT_PROBE_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const DEFAULT_ENABLED_RUNTIME_ADAPTERS = "openclaw,slock,codex";
const FNM_MULTISHELL_SEARCH_LIMIT = 64;
const KNOWN_OPENCLAW_RUNTIME_SCOPE_SKILLS = new Set(["clawhub", "healthcheck", "weather"]);
const SKILL_SCAN_SKIP_DIRS = new Set([
  ".git",
  ".tmp",
  "tmp",
  "temp",
  "node_modules",
  "dist",
  "build",
  "logs",
  "log",
  "sessions",
  "vendor_imports",
]);
const SKILL_DESCRIPTION_MAX_CHARS = 180;
const executableCache = new Map();

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
  const raw = process.env.LORUME_ENABLED_RUNTIME_ADAPTERS || config.enabledRuntimeAdapters || DEFAULT_ENABLED_RUNTIME_ADAPTERS;
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  return new Set(values.map((value) => sanitizeId(value)).filter(Boolean));
}

function adapterEnabled(config, adapter) {
  return enabledRuntimeAdapters(config).has(adapter);
}

function commandSearchDirs({ includeDynamicShimDirs = false } = {}) {
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

  if (includeDynamicShimDirs) dirs.push(...recentFnmMultishellBinDirs());

  dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin");

  return [...new Set(dirs)];
}

function candidateExecutables(command, options) {
  return commandSearchDirs(options).map((dir) => path.join(dir, command));
}

function recentFnmMultishellBinDirs() {
  const root = path.join(homeDir(), ".local", "state", "fnm_multishells");
  const recentSessions = [];
  let directory;
  try {
    directory = opendirSync(root);
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (!entry.isDirectory()) continue;
      pushRecentFnmSession(recentSessions, {
        name: entry.name,
        sortKey: fnmMultishellSortKey(entry.name),
      });
    }
  } catch {
    return [];
  } finally {
    try {
      directory?.closeSync();
    } catch {
      // Ignore close failures for best-effort command discovery.
    }
  }

  return recentSessions
    .sort(compareFnmSessions)
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

function pushRecentFnmSession(recentSessions, entry) {
  recentSessions.push(entry);
  recentSessions.sort(compareFnmSessions);
  if (recentSessions.length > FNM_MULTISHELL_SEARCH_LIMIT) recentSessions.pop();
}

function compareFnmSessions(left, right) {
  const keyDelta = right.sortKey - left.sortKey;
  if (keyDelta !== 0) return keyDelta;
  return right.name.localeCompare(left.name);
}

function probeEnv(executable) {
  const executableDir = path.dirname(executable);
  return {
    ...process.env,
    PATH: [...new Set([
      executableDir,
      path.dirname(process.execPath),
      ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
      path.join(homeDir(), ".local", "bin"),
      path.join(homeDir(), ".npm-global", "bin"),
      path.join(homeDir(), ".volta", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ])].join(path.delimiter),
  };
}

function findExecutable(command) {
  if (executableCache.has(command)) return executableCache.get(command);
  const stableExecutable = findExecutableInCandidates(candidateExecutables(command, { includeDynamicShimDirs: false }));
  if (stableExecutable) {
    executableCache.set(command, stableExecutable);
    return stableExecutable;
  }

  const dynamicExecutable = findExecutableInCandidates(recentFnmMultishellBinDirs().map((dir) => path.join(dir, command)));
  if (dynamicExecutable) {
    executableCache.set(command, dynamicExecutable);
    return dynamicExecutable;
  }

  try {
    const resolved = execFileSync("sh", ["-c", `command -v -- ${shellQuote(command)}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: commandSearchDirs({ includeDynamicShimDirs: false }).join(path.delimiter) },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const executable = resolved || null;
    executableCache.set(command, executable);
    return executable;
  } catch {
    executableCache.set(command, null);
    return null;
  }
}

function findExecutableInCandidates(candidates) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep scanning.
    }
  }
  return null;
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

function runJsonWithFileBackedStdout(command, args, timeoutMs = 10_000) {
  const executable = findExecutable(command);
  if (!executable) return null;
  const tempDir = mkdtempSync(path.join(tmpdir(), "lorume-probe-"));
  const outputPath = path.join(tempDir, "stdout.json");
  let outputFd;
  try {
    outputFd = openSync(outputPath, "w", 0o600);
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      env: probeEnv(executable),
      maxBuffer: DEFAULT_PROBE_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
      stdio: ["ignore", outputFd, "pipe"],
    });
    if (result.error || result.status !== 0) return null;
    return JSON.parse(readFileSync(outputPath, "utf8"));
  } catch {
    return null;
  } finally {
    if (outputFd !== undefined) {
      try {
        closeSync(outputFd);
      } catch {
        // Ignore cleanup failures.
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function createDevice(config, collectedAt) {
  const defaultId = sanitizeId(hostname());
  const localIps = collectLocalIps();
  return {
    id: config.deviceId || defaultId,
    hostname: hostname(),
    os: platform(),
    architecture: arch(),
    lastSeenAt: collectedAt,
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

function createCollectionDiagnosticCollector(defaultSource = "openclaw") {
  const byCode = new Map();
  return {
    add(input, sampleRef) {
      if (!input?.code || !input?.severity) return;
      const existing = byCode.get(input.code) || {
        code: input.code,
        severity: input.severity,
        count: 0,
        message: input.message || input.code,
        source: input.source || defaultSource,
        ...(input.target ? { target: input.target } : {}),
        ...(input.action ? { action: input.action } : {}),
        sampleRefs: [],
      };
      existing.count += 1;
      if (sampleRef && existing.sampleRefs.length < 5 && !existing.sampleRefs.includes(String(sampleRef))) {
        existing.sampleRefs.push(String(sampleRef));
      }
      byCode.set(input.code, existing);
    },
    items() {
      return Array.from(byCode.values())
        .map((item) => ({
          ...item,
          message: formatDiagnosticMessage(item),
          ...(item.sampleRefs.length ? { sampleRefs: item.sampleRefs } : {}),
        }))
        .sort(compareDiagnostics);
    },
  };
}

function formatDiagnosticMessage(item) {
  const count = item.count;
  const messages = {
    openclaw_ambiguous_agent_link: `${count} 条 OpenClaw 任务缺少明确 Agent 归属，已跳过。`,
    openclaw_internal_announce_ignored: `${count} 条 OpenClaw 内部 announce 记录已过滤。`,
    openclaw_internal_command_completion_ignored: `${count} 条 OpenClaw 内部命令完成记录已过滤。`,
    openclaw_internal_heartbeat_ignored: `${count} 条 OpenClaw 内部心跳记录已过滤。`,
    openclaw_internal_subagent_ignored: `${count} 条 OpenClaw 内部 subagent 记录已过滤。`,
    openclaw_internal_system_ignored: `${count} 条 OpenClaw 内部 system 记录已过滤。`,
    openclaw_legacy_dingtalk_context_missing: `${count} 条 OpenClaw DingTalk 历史会话缺少可验证用户上下文，未作为 Task 入库。`,
    openclaw_missing_agent_link: `${count} 条 OpenClaw 任务缺少 Agent 归属，已跳过。`,
    openclaw_missing_prompt_ignored: `${count} 条 OpenClaw 非任务记录缺少 prompt，已过滤。`,
    openclaw_missing_agent_reply: `${count} 条 OpenClaw 会话/定时任务缺少 Agent 回复，已按不完整任务入库。`,
    openclaw_orphan_run_missing_user_turn: `${count} 条 OpenClaw 运行记录缺少用户 turn，未作为 Task 入库。`,
    openclaw_uncollected_agent_link: `${count} 条 OpenClaw 任务归属到未采集 Agent，已跳过。`,
    openclaw_unsupported_task_type_ignored: `${count} 条 OpenClaw 非产品任务类型已过滤。`,
    slock_history_pagination_incomplete: `${count} 次 Slock 历史分页无法证明完整。`,
    slock_inactive_workspace_task_ignored: `${count} 条 Slock 任务只匹配到本机 workspace，缺少 active profile，已跳过。`,
    slock_agent_reply_fetch_failed: `${count} 条 Slock Task 的 Agent 回复读取失败，已保留核心 Task。`,
    slock_agent_reply_thread_empty: `${count} 条已完成 Slock 任务的 thread 为空，无法提取 Agent 回复。`,
    slock_agent_reply_thread_unavailable: `${count} 条已完成 Slock 任务的 thread 不存在或不可读，无法提取 Agent 回复。`,
    slock_missing_agent_reply: `${count} 条已完成 Slock 任务的 thread 中缺少 assigned Agent 回复，已按不完整任务入库。`,
    slock_missing_user_message: `${count} 条 Slock 本机任务缺少用户消息，已跳过。`,
    slock_channel_discovery_failed: `${count} 次 Slock joined channel 自动发现失败。`,
    slock_profile_unreadable: `${count} 次 Slock active profile 读取失败。`,
    slock_reply_cache_write_failed: `${count} 次 Slock Agent 回复缓存写入失败。`,
    slock_remote_agent_task_ignored: `${count} 条 Slock 任务指向远端或未知 Agent，已跳过。`,
    slock_unassigned_task_ignored: `${count} 条 Slock 任务缺少 assignee，已跳过。`,
    slock_unknown_task_status: `${count} 条 Slock 任务状态未知，已映射为 unknown。`,
    slock_unsupported_runtime_ignored: `${count} 个 Slock active profile 使用了尚未支持的 runtime，已跳过。`,
    codex_missing_user_message: `${count} 条 Codex native 会话缺少用户消息，已跳过。`,
    codex_owned_by_multica_ignored: `${count} 条 Multica-owned Codex 会话已过滤。`,
    codex_owned_by_slock_ignored: `${count} 条 Slock-owned Codex 会话已过滤。`,
    codex_session_jsonl_unreadable: `${count} 条 Codex session JSONL 不可读，已跳过。`,
    codex_state_unreadable: `${count} 次 Codex state 不可读或无法解析。`,
    codex_unknown_task_status: `${count} 条 Codex native 会话状态未知，已映射为 unknown。`,
  };
  return messages[item.code] || item.message || item.code;
}

function compareDiagnostics(left, right) {
  const severityRank = { error: 0, warning: 1, info: 2, debug: 3 };
  const severityDelta = severityRank[left.severity] - severityRank[right.severity];
  if (severityDelta !== 0) return severityDelta;
  return String(left.code).localeCompare(String(right.code));
}

function openClawEligibilityDiagnostic(reason) {
  const base = { source: "openclaw", target: "adapter", action: "ignored" };
  if (reason === "missing task prompt") {
    return { ...base, code: "openclaw_orphan_run_missing_user_turn", severity: "warning", target: "task", action: "task_dropped" };
  }
  if (reason === "missing prompt") return { ...base, code: "openclaw_missing_prompt_ignored", severity: "debug" };
  if (reason === "internal heartbeat run") return { ...base, code: "openclaw_internal_heartbeat_ignored", severity: "debug" };
  if (reason === "internal command completion run") return { ...base, code: "openclaw_internal_command_completion_ignored", severity: "debug" };
  if (reason === "internal system run") return { ...base, code: "openclaw_internal_system_ignored", severity: "debug" };
  if (reason === "internal announce run") return { ...base, code: "openclaw_internal_announce_ignored", severity: "debug" };
  if (reason === "internal subagent run") return { ...base, code: "openclaw_internal_subagent_ignored", severity: "debug" };
  if (reason === "unsupported OpenClaw task type") return { ...base, code: "openclaw_unsupported_task_type_ignored", severity: "info" };
  return null;
}

function openClawAgentDiagnostic(reason) {
  const base = { source: "openclaw", target: "task", action: "task_dropped", severity: "warning" };
  if (reason === "ambiguous OpenClaw agent ownership") return { ...base, code: "openclaw_ambiguous_agent_link" };
  if (reason === "missing OpenClaw agent ownership") return { ...base, code: "openclaw_missing_agent_link" };
  if (reason === "uncollected OpenClaw agent") return { ...base, code: "openclaw_uncollected_agent_link" };
  return null;
}

function openClawUserMessageDiagnostic(reason) {
  const base = { source: "openclaw", target: "task", action: "task_dropped", severity: "warning" };
  if (reason === "missing DingTalk inbound message context") return { ...base, code: "openclaw_legacy_dingtalk_context_missing" };
  if (reason === "missing scheduled prompt" || reason === "missing userMessage") return { ...base, code: "openclaw_orphan_run_missing_user_turn" };
  return null;
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

function collectOpenClawDeviceState(deviceId, collectedAt) {
  const openClawRoot = path.join(homeDir(), ".openclaw");
  const config = readOpenClawConfig();
  const health = runJson("openclaw", ["health", "--json", "--timeout", "5000"]);
  const status = runJson("openclaw", ["status", "--json", "--timeout", "5000"]);
  if (!health && !status && !config) return { runtimes: [], agents: [], tasks: [], diagnostics: [] };

  const gateway = status?.gateway;
  const collectionStatus = health?.ok === false || gateway?.reachable === false ? "error" : "online";
  const runtime = createProductRuntime({
    deviceId,
    kind: "openclaw",
    name: "OpenClaw Gateway",
    version: gateway?.self?.version || undefined,
    collectionStatus,
    lastSeenAt: collectedAt,
    diagnostics: {
      paths: rootPath(openClawRoot),
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
      lastSeenAt: collectedAt,
      diagnostics: {
        paths: compactPaths([{ label: "根目录", path: path.join(openClawRoot, "agents", agentId) }]),
      },
    }),
  );
  const runtimeSkillProbe = collectOpenClawRuntimeSkillProbe({
    agents,
    collectedAt,
    deviceId,
    runtime,
    agentExternalIds: agentIds,
  });

  return {
    runtimes: [runtime],
    agents,
    tasks: trajectoryMapping.tasks,
    runtimeSkillProbes: runtimeSkillProbe ? [runtimeSkillProbe] : [],
    diagnostics: trajectoryMapping.diagnostics,
  };
}

function collectOpenClawRuntimeSkillProbe({ agents, collectedAt, deviceId, runtime, agentExternalIds }) {
  const runtimeSkills = openClawSkillListFromOutput(openClawSkillsListJson([]));
  const agentSkillViews = agentExternalIds.map((agentExternalId) => {
    const productAgent = agents.find((agent) => agent.id === makeAgentId(runtime.id, agentExternalId));
    const skills = openClawSkillListFromOutput(
      openClawSkillsListJson(["--agent", agentExternalId]) ||
      openClawSkillsListJson(["--agent-id", agentExternalId]),
    );
    return {
      agentId: productAgent?.id || makeAgentId(runtime.id, agentExternalId),
      skills,
    };
  }).filter((view) => view.skills.length > 0);
  const rows = openClawRuntimeSkillRows({ runtimeSkills, agentSkillViews });
  if (runtimeSkills.length === 0 && agentSkillViews.length === 0) return null;
  return {
    deviceId,
    runtimeId: runtime.id,
    runtimeKind: runtime.kind,
    status: rows.length ? "succeeded" : "unsupported",
    observedAt: collectedAt,
    summary: createRuntimeSkillSummary(rows),
    skills: rows,
    ...(!rows.length ? { errorSummary: "未发现可归一化的 OpenClaw Skill metadata。" } : {}),
  };
}

function openClawSkillsListJson(extraArgs) {
  return runJsonWithFileBackedStdout("openclaw", ["skills", "list", "--json", ...extraArgs]);
}

function openClawSkillListFromOutput(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["skills", "items", "data", "results"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function openClawRuntimeSkillRows({ runtimeSkills, agentSkillViews }) {
  const rowsByName = new Map();
  for (const rawSkill of runtimeSkills) mergeRuntimeSkillRow(rowsByName, openClawSkillToRuntimeSkillRow(rawSkill));
  for (const view of agentSkillViews) {
    for (const rawSkill of view.skills) {
      mergeRuntimeSkillRow(rowsByName, openClawSkillToRuntimeSkillRow(rawSkill, view.agentId));
    }
  }
  return Array.from(rowsByName.values())
    .map((row) => ({ ...row, agentIds: row.scope === "agent" ? uniqueSorted(row.agentIds) : [] }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function openClawSkillToRuntimeSkillRow(rawSkill, visibleAgentId) {
  if (!rawSkill || typeof rawSkill !== "object") return null;
  const name = cleanText(rawSkill.name || rawSkill.id || rawSkill.slug);
  if (!name) return null;
  const scope = openClawSkillScope(rawSkill);
  if (!scope) return null;
  return {
    name,
    description: cleanText(rawSkill.description || rawSkill.summary),
    scope,
    available: openClawSkillAvailable(rawSkill),
    builtIn: rawSkill.bundled === true || cleanText(rawSkill.source) === "openclaw-bundled",
    agentIds: scope === "agent" && visibleAgentId ? [visibleAgentId] : [],
  };
}

function openClawSkillScope(rawSkill) {
  const name = cleanText(rawSkill.name || rawSkill.id || rawSkill.slug);
  if (KNOWN_OPENCLAW_RUNTIME_SCOPE_SKILLS.has(name)) return "runtime";
  const source = cleanText(rawSkill.source);
  if (rawSkill.bundled === true || source === "openclaw-bundled" || source === "openclaw-extra") return "runtime";
  if (source === "openclaw-workspace" || source === "agents-skills-personal" || source === "agents-skills-project") return "agent";
  return null;
}

function openClawSkillAvailable(rawSkill) {
  return rawSkill.eligible === true &&
    rawSkill.disabled !== true &&
    rawSkill.blockedByAllowlist !== true &&
    openClawMissingCount(rawSkill.missing) === 0;
}

function openClawMissingCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    return Object.values(value).reduce((sum, item) => sum + openClawMissingCount(item), 0);
  }
  if (typeof value === "string") return value.trim() ? 1 : 0;
  return 0;
}

function mergeRuntimeSkillRow(rowsByName, row) {
  if (!row) return;
  const existing = rowsByName.get(row.name);
  if (!existing) {
    rowsByName.set(row.name, { ...row, agentIds: uniqueSorted(row.agentIds) });
    return;
  }
  const scope = existing.scope === "runtime" || row.scope === "runtime" ? "runtime" : "agent";
  rowsByName.set(row.name, {
    name: existing.name,
    description: existing.description || row.description,
    scope,
    available: existing.available || row.available,
    builtIn: existing.builtIn || row.builtIn,
    agentIds: scope === "agent" ? uniqueSorted([...existing.agentIds, ...row.agentIds]) : [],
  });
}

function mergeCollectedRuntimeSkillRow(rowsByKey, row) {
  const normalized = normalizeRuntimeSkillRow(row);
  if (!normalized) return;
  const key = runtimeSkillRowMergeKey(normalized);
  const existing = rowsByKey.get(key);
  if (!existing) {
    rowsByKey.set(key, normalized);
    return;
  }
  const scope = existing.scope === "runtime" || normalized.scope === "runtime" ? "runtime" : "agent";
  rowsByKey.set(key, {
    name: existing.name,
    description: existing.description || normalized.description,
    scope,
    available: existing.available || normalized.available,
    builtIn: existing.builtIn || normalized.builtIn,
    agentIds: scope === "agent" ? uniqueSorted([...existing.agentIds, ...normalized.agentIds]) : [],
  });
}

function normalizeRuntimeSkillRow(row) {
  const name = cleanText(row?.name);
  const scope = cleanText(row?.scope);
  if (!name || (scope !== "runtime" && scope !== "agent")) return null;
  return {
    name,
    description: cleanText(row?.description),
    scope,
    available: row?.available === true,
    builtIn: row?.builtIn === true,
    agentIds: scope === "agent" ? uniqueSorted(Array.isArray(row?.agentIds) ? row.agentIds : []) : [],
  };
}

function runtimeSkillRowMergeKey(row) {
  return [row.scope, row.name, row.description].join("\u0000");
}

function sortRuntimeSkillRows(rows) {
  return rows
    .map((row) => ({
      ...row,
      agentIds: row.scope === "agent" ? uniqueSorted(row.agentIds) : [],
    }))
    .sort((left, right) =>
      left.name.localeCompare(right.name) ||
      left.scope.localeCompare(right.scope) ||
      left.description.localeCompare(right.description),
    );
}

function createRuntimeSkillSummary(skills) {
  return {
    total: skills.length,
    runtimeScopeCount: skills.filter((skill) => skill.scope === "runtime").length,
    agentScopeCount: skills.filter((skill) => skill.scope === "agent").length,
    availableCount: skills.filter((skill) => skill.available).length,
    unavailableCount: skills.filter((skill) => !skill.available).length,
    builtInCount: skills.filter((skill) => skill.builtIn).length,
  };
}

function uniqueSorted(values) {
  return Array.from(new Set(values.map((value) => cleanText(value)).filter(Boolean))).sort();
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function listSkillDirectories(skillsRoot) {
  let entries = [];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !SKILL_SCAN_SKIP_DIRS.has(entry.name))
    .map((entry) => path.join(skillsRoot, entry.name))
    .filter((skillDir) => existsSync(path.join(skillDir, "SKILL.md")));
}

function skillRowFromDirectory(skillDir, { scope, builtIn, agentIds = [] }) {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return null;
  const name = cleanText(path.basename(skillDir));
  if (!name) return null;
  return normalizeRuntimeSkillRow({
    name,
    description: readSkillDescription(skillFile),
    scope,
    available: true,
    builtIn,
    agentIds,
  });
}

function readSkillDescription(skillFile) {
  let content = "";
  try {
    content = readFileSync(skillFile, "utf8");
  } catch {
    return "";
  }
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const frontmatterDescription = frontmatter ? parseSkillFrontmatterDescription(frontmatter[1]) : "";
  if (frontmatterDescription) return truncateSkillDescription(frontmatterDescription);

  for (const line of content.split(/\r?\n/).slice(0, 80)) {
    const text = line.trim();
    if (!text || text === "---" || text.startsWith("#") || /^[a-zA-Z_-]+:\s*/.test(text)) continue;
    return truncateSkillDescription(text);
  }
  return "";
}

function parseSkillFrontmatterDescription(frontmatter) {
  const lines = String(frontmatter || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^description\s*:\s*(.*)$/i.exec(lines[index]);
    if (!match) continue;
    const inlineValue = match[1].trim();
    if (inlineValue === "|" || inlineValue === ">") {
      const parts = [];
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        if (!/^\s+/.test(lines[nextIndex])) break;
        parts.push(lines[nextIndex].trim());
      }
      return parts.join(" ").trim();
    }
    return stripYamlString(inlineValue);
  }
  return "";
}

function stripYamlString(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function truncateSkillDescription(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > SKILL_DESCRIPTION_MAX_CHARS
    ? `${text.slice(0, SKILL_DESCRIPTION_MAX_CHARS - 3).trim()}...`
    : text;
}

function walkSkillFiles(root, { maxDepth = 8 } = {}, output = [], depth = 0) {
  if (depth > maxDepth) return output;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (SKILL_SCAN_SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkSkillFiles(fullPath, { maxDepth }, output, depth + 1);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      output.push(fullPath);
    }
  }
  return output;
}

function collectCodexDeviceState(deviceId, collectedAt) {
  const codexRoot = process.env.LORUME_CODEX_HOME || path.join(homeDir(), ".codex");
  const statePath = process.env.LORUME_CODEX_STATE_PATH || path.join(codexRoot, "state_5.sqlite");
  if (!existsSync(statePath)) return { runtimes: [], agents: [], tasks: [], diagnostics: [] };

  const diagnostics = createCollectionDiagnosticCollector("codex");
  let rows = [];
  try {
    rows = readCodexThreadRows(statePath);
  } catch {
    diagnostics.add(codexDiagnostic("codex_state_unreadable", "error", "adapter", "ignored"), statePath);
    const runtime = createProductRuntime({
      deviceId,
      kind: "codex",
      name: "Codex",
      collectionStatus: "error",
      lastSeenAt: collectedAt,
      diagnostics: {
        paths: rootPath(codexRoot),
        lastError: "Codex state is unreadable",
      },
    });
    const runtimeSkillProbe = collectCodexRuntimeSkillProbe({ codexRoot, collectedAt, deviceId, runtime });
    return {
      runtimes: [runtime],
      agents: [],
      tasks: [],
      runtimeSkillProbes: runtimeSkillProbe ? [runtimeSkillProbe] : [],
      diagnostics: diagnostics.items(),
    };
  }

  const runtime = createProductRuntime({
    deviceId,
    kind: "codex",
    name: "Codex",
    collectionStatus: "online",
    lastSeenAt: collectedAt,
    diagnostics: {
      paths: rootPath(codexRoot),
    },
  });
  const runtimeSkillProbe = collectCodexRuntimeSkillProbe({ codexRoot, collectedAt, deviceId, runtime });
  const agent = {
    ...createProductAgent({
      runtimeId: runtime.id,
      externalId: "codex-local",
      name: "Codex",
      collectionStatus: "online",
      lastSeenAt: collectedAt,
      diagnostics: {
        paths: rootPath(codexRoot),
      },
    }),
    id: `${runtime.id}:agent:codex:local`,
  };

  const tasks = [];
  for (const row of rows) {
    const threadId = cleanCodexText(codexThreadValue(row, ["id", "thread_id", "threadId"]));
    if (!threadId) continue;

    const cwd = cleanCodexText(codexThreadValue(row, ["cwd", "current_working_directory", "currentWorkingDirectory"]));
    const cwdKind = classifyCodexThreadCwd(cwd);
    if (cwdKind === "slock-owned") {
      diagnostics.add(codexDiagnostic("codex_owned_by_slock_ignored", "info", "task", "task_dropped"), threadId);
      continue;
    }
    if (cwdKind === "multica-owned") {
      diagnostics.add(codexDiagnostic("codex_owned_by_multica_ignored", "info", "task", "task_dropped"), threadId);
      continue;
    }

    const rolloutPath = cleanCodexText(codexThreadValue(row, ["rollout_path", "rolloutPath", "session_path", "sessionPath"]));
    const sessionPath = resolveCodexSessionPath(codexRoot, rolloutPath);
    const records = readCodexSessionRecords(sessionPath);
    if (!records) {
      diagnostics.add(codexDiagnostic("codex_session_jsonl_unreadable", "error", "task", "task_dropped"), threadId);
      continue;
    }
    if (codexSessionHasSlockOwnership(records)) {
      diagnostics.add(codexDiagnostic("codex_owned_by_slock_ignored", "info", "task", "task_dropped"), threadId);
      continue;
    }

    const userMessage = cleanCodexText(
      codexThreadValue(row, ["first_user_message", "firstUserMessage", "first_user_msg", "firstUserMsg"]) ||
      firstCodexUserMessage(records),
    );
    if (!userMessage) {
      diagnostics.add(codexDiagnostic("codex_missing_user_message", "warning", "task", "task_dropped"), threadId);
      continue;
    }

    const status = codexSessionHasTaskComplete(records) ? "done" : "unknown";
    if (status === "unknown") {
      diagnostics.add(codexDiagnostic("codex_unknown_task_status", "warning", "task", "task_ingested_with_gap"), threadId);
    }
    const agentReply = latestCodexAgentReply(records);
    const createdAt = toIsoTimestamp(codexThreadValue(row, ["created_at", "createdAt", "created"]));
    const updatedAt = latestIsoTimestamp(
      toIsoTimestamp(codexThreadValue(row, ["updated_at", "updatedAt", "modified_at", "modifiedAt"])),
      latestCodexRecordTimestamp(records),
    );
    const rawCodex = codexRawEvidence(row, threadId, rolloutPath);
    tasks.push({
      id: makeProductTaskId(agent.id, threadId),
      agentId: agent.id,
      taskType: "conversation",
      status,
      userMessage,
      ...(agentReply ? { agentReply } : {}),
      adapter: { kind: "codex" },
      raw: { codex: rawCodex },
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }

  return {
    runtimes: [runtime],
    agents: [agent],
    tasks: orderOpenClawProductTasks(tasks),
    runtimeSkillProbes: runtimeSkillProbe ? [runtimeSkillProbe] : [],
    diagnostics: diagnostics.items(),
  };
}

function collectCodexRuntimeSkillProbe({ codexRoot, collectedAt, deviceId, runtime }) {
  const rowsByKey = new Map();
  for (const skillDir of listSkillDirectories(path.join(codexRoot, "skills", ".system"))) {
    mergeCollectedRuntimeSkillRow(rowsByKey, skillRowFromDirectory(skillDir, {
      scope: "runtime",
      builtIn: true,
    }));
  }
  for (const skillDir of listSkillDirectories(path.join(codexRoot, "skills"))) {
    if (path.basename(skillDir) === ".system") continue;
    mergeCollectedRuntimeSkillRow(rowsByKey, skillRowFromDirectory(skillDir, {
      scope: "runtime",
      builtIn: false,
    }));
  }
  for (const skillFile of walkSkillFiles(path.join(codexRoot, "plugins", "cache"), { maxDepth: 8 })) {
    const skillDir = path.dirname(skillFile);
    if (path.basename(path.dirname(skillDir)) !== "skills") continue;
    mergeCollectedRuntimeSkillRow(rowsByKey, skillRowFromDirectory(skillDir, {
      scope: "runtime",
      builtIn: true,
    }));
  }

  const skills = sortRuntimeSkillRows(Array.from(rowsByKey.values()));
  if (!skills.length) return null;
  return {
    deviceId,
    runtimeId: runtime.id,
    runtimeKind: runtime.kind,
    status: "succeeded",
    observedAt: collectedAt,
    summary: createRuntimeSkillSummary(skills),
    skills,
  };
}

function readCodexThreadRows(statePath) {
  const script = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare("SELECT * FROM threads").all();
db.close();
process.stdout.write(JSON.stringify(rows));
`;
  const output = execFileSync(process.execPath, ["--no-warnings", "-e", script, statePath], {
    encoding: "utf8",
    maxBuffer: DEFAULT_PROBE_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rows = JSON.parse(output || "[]");
  return Array.isArray(rows) ? rows : [];
}

function codexThreadValue(row, names) {
  if (!row || typeof row !== "object") return undefined;
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== "") return row[name];
  }
  return undefined;
}

function classifyCodexThreadCwd(cwd) {
  const normalized = String(cwd || "").replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.slock/agents/")) return "slock-owned";
  if (normalized.includes("/multica_workspaces/")) return "multica-owned";
  return "codex-native-or-other";
}

function resolveCodexSessionPath(codexRoot, rolloutPath) {
  if (!rolloutPath) return "";
  if (path.isAbsolute(rolloutPath)) return rolloutPath;
  const resolved = path.resolve(codexRoot, rolloutPath);
  const root = path.resolve(codexRoot);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : "";
}

function readCodexSessionRecords(sessionPath) {
  if (!sessionPath || !existsSync(sessionPath)) return null;
  try {
    return readFileSync(sessionPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

function codexSessionHasSlockOwnership(records) {
  return records.some((record) => JSON.stringify(record).includes("mcp__chat__"));
}

function codexSessionHasTaskComplete(records) {
  return records.some((record) => codexRecordType(record) === "task_complete");
}

function firstCodexUserMessage(records) {
  for (const record of records) {
    if (codexRecordType(record) === "user_message" || codexRecordRole(record) === "user") {
      const text = codexRecordText(record);
      if (text) return text;
    }
  }
  return "";
}

function latestCodexAgentReply(records) {
  let reply = "";
  for (const record of records) {
    const type = codexRecordType(record);
    if (type === "task_complete") {
      const text = codexRecordText(record);
      if (text) reply = text;
      continue;
    }
    if (type === "agent_message" || type === "assistant_message" || codexRecordRole(record) === "assistant") {
      const text = codexRecordText(record);
      if (text) reply = text;
    }
  }
  return reply;
}

function latestCodexRecordTimestamp(records) {
  let latest;
  for (const record of records) {
    latest = latestIsoTimestamp(latest, toIsoTimestamp(record?.timestamp || record?.ts || record?.time));
  }
  return latest;
}

function codexRecordType(record) {
  return cleanCodexText(
    record?.payload?.type ||
    record?.msg?.type ||
    (record?.event && typeof record.event === "object" ? record.event.type : "") ||
    record?.type ||
    record?.event ||
    record?.kind,
  );
}

function codexRecordRole(record) {
  return cleanCodexText(
    record?.payload?.role ||
    record?.msg?.role ||
    (record?.message && typeof record.message === "object" ? record.message.role : "") ||
    record?.role,
  );
}

function codexRecordText(record) {
  const payloads = [
    record,
    record?.payload,
    record?.msg,
    record?.event && typeof record.event === "object" ? record.event : undefined,
  ].filter(Boolean);
  for (const payload of payloads) {
    const direct = cleanCodexText(
      payload?.message ||
      payload?.text ||
      payload?.content ||
      payload?.last_agent_message ||
      payload?.lastAgentMessage ||
      payload?.agentReply,
    );
    if (direct) return direct;
    if (Array.isArray(payload?.content)) {
      return cleanCodexText(payload.content.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.content || "";
        return "";
      }).join(" "));
    }
  }
  return "";
}

function cleanCodexText(value) {
  if (Array.isArray(value)) {
    return cleanCodexText(value.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") return part.text || part.content || "";
      return "";
    }).join(" "));
  }
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function codexRawEvidence(row, threadId, rolloutPath) {
  const git = {
    ...(cleanCodexText(codexThreadValue(row, ["git_branch", "gitBranch", "branch"])) ? { branch: cleanCodexText(codexThreadValue(row, ["git_branch", "gitBranch", "branch"])) } : {}),
    ...(cleanCodexText(codexThreadValue(row, ["git_sha", "gitSha", "sha", "commit"])) ? { sha: cleanCodexText(codexThreadValue(row, ["git_sha", "gitSha", "sha", "commit"])) } : {}),
    ...(cleanCodexText(codexThreadValue(row, ["git_origin", "gitOrigin", "origin"])) ? { origin: cleanCodexText(codexThreadValue(row, ["git_origin", "gitOrigin", "origin"])) } : {}),
  };
  const tokensUsed = Number(codexThreadValue(row, ["tokens_used", "tokensUsed", "token_count", "tokenCount"]));
  return {
    threadId,
    ...(rolloutPath ? { rolloutPath } : {}),
    ...(cleanCodexText(codexThreadValue(row, ["source"])) ? { source: cleanCodexText(codexThreadValue(row, ["source"])) } : {}),
    ...(cleanCodexText(codexThreadValue(row, ["model"])) ? { model: cleanCodexText(codexThreadValue(row, ["model"])) } : {}),
    cwdKind: "codex-native-or-other",
    ...(Number.isFinite(tokensUsed) ? { tokensUsed } : {}),
    ...(Object.keys(git).length ? { git } : {}),
  };
}

function codexDiagnostic(code, severity, target, action) {
  return { source: "codex", code, severity, target, action };
}

const SLOCK_HISTORY_PAGE_LIMIT = 100;
const SLOCK_HISTORY_MAX_PAGES = 100;
const SLOCK_HTTP_MAX_ATTEMPTS = 3;
const SLOCK_HTTP_TIMEOUT_SECONDS = 10;
const SLOCK_SUPPORTED_RUNTIME_KINDS = new Set(["openclaw", "codex"]);
const SLOCK_REPLY_CACHE_SCHEMA_VERSION = "slock-reply-v2";
const DEFAULT_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN = 10;
const DEFAULT_SLOCK_REPLY_ENRICHMENT_BUDGET_MS = 15_000;

function collectSlockDeviceState(device, collectedAt, config = {}) {
  const workspaceAgentIds = readSlockWorkspaceAgentIds();
  const daemonConfig = discoverSlockDaemonConfig(workspaceAgentIds);
  const baseUrl = slockConfiguredBaseUrl(config, daemonConfig);
  const auth = slockConfiguredAuth(config, daemonConfig);
  if (!baseUrl || !auth.token) return { runtimes: [], agents: [], tasks: [], diagnostics: [] };

  const diagnostics = createCollectionDiagnosticCollector("slock");
  const replyCachePath = resolveSlockReplyCachePath(config);
  const replyCacheScope = createSlockReplyCacheScope(baseUrl, device.id);
  const replyCache = readSlockReplyCache(replyCachePath, replyCacheScope);
  const replyThreadReadBudget = {
    budgetMs: slockReplyEnrichmentBudgetMs(config),
    remaining: slockMaxReplyThreadReadsPerRun(config),
    startedAt: Date.now(),
  };
  const runtimesById = new Map();
  const agentsById = new Map();
  const tasksById = new Map();
  const profileCache = new Map();
  const profileClassifications = new Map();
  const localProfiles = [];
  const configuredAgentIds = slockConfiguredAgentIds(config, daemonConfig);
  const requestedAgentIds = uniqueSlockIds(configuredAgentIds.length ? configuredAgentIds : Array.from(workspaceAgentIds));

  for (const agentId of requestedAgentIds) {
    const profileResult = readSlockProfileCached(baseUrl, agentId, profileCache, auth);
    const classification = classifySlockProfileResult({
      device,
      agentId,
      profileResult,
      workspaceAgentIds,
    });
    profileClassifications.set(agentId, classification);
    if (classification.profileId) profileClassifications.set(classification.profileId, classification);
    if (classification.diagnostic) {
      diagnostics.add(classification.diagnostic, agentId);
      continue;
    }
    localProfiles.push(classification);
  }

  for (const localProfile of localProfiles) {
    const runtime = ensureSlockRuntime(runtimesById, {
      deviceId: device.id,
      kind: localProfile.runtimeKind,
      collectedAt,
    });
    localProfile.productAgent = ensureSlockAgent(agentsById, {
      runtimeId: runtime.id,
      profile: localProfile.profile,
      collectedAt,
    });
  }
  const skillProfiles = collectSlockSkillProfiles({
    collectedAt,
    deviceId: device.id,
    localProfiles,
    runtimesById,
    agentsById,
  });

  const discoveredTargets = new Map();
  for (const localProfile of localProfiles) {
    for (const channelTarget of discoverSlockJoinedChannelTargets(baseUrl, localProfile.profileId, auth, diagnostics)) {
      if (!discoveredTargets.has(channelTarget)) discoveredTargets.set(channelTarget, localProfile.profileId);
    }
  }
  for (const [channelTarget, readerAgentId] of discoveredTargets.entries()) {
    collectSlockTasksFromChannel({
      baseUrl,
      channelTarget,
      readerAgentId,
      localProfiles,
      profileClassifications,
      workspaceAgentIds,
      auth,
      diagnostics,
      tasksById,
      replyCache,
      replyThreadReadBudget,
    });
  }

  try {
    writeSlockReplyCache(replyCachePath, replyCache);
  } catch {
    diagnostics.add(
      slockDiagnostic("slock_reply_cache_write_failed", "warning", "adapter", "task_ingested_with_gap"),
      device.id,
    );
  }

  const runtimeSkillProbes = collectSlockRuntimeSkillProbes({
    collectedAt,
    deviceId: device.id,
    skillProfiles,
  });

  return {
    runtimes: Array.from(runtimesById.values()),
    agents: Array.from(agentsById.values()),
    tasks: orderSlockProductTasks(Array.from(tasksById.values())),
    runtimeSkillProbes,
    diagnostics: diagnostics.items(),
  };
}

function collectSlockSkillProfiles({ collectedAt, deviceId, localProfiles, runtimesById, agentsById }) {
  const profiles = [...localProfiles];
  const knownProfileIds = new Set(localProfiles.map((profile) => sanitizeId(profile.profileId)));
  for (const profileId of readSlockWorkspaceAgentDirectoryIds()) {
    if (knownProfileIds.has(sanitizeId(profileId))) continue;
    const agentRoot = path.join(slockRoot(), "agents", sanitizeId(profileId));
    if (!slockAgentRootHasSkillFiles(agentRoot)) continue;
    const runtime = ensureSlockRuntime(runtimesById, {
      deviceId,
      kind: "codex",
      collectedAt,
    });
    profiles.push({
      profileId,
      runtimeKind: "codex",
      productAgent: ensureSlockSkillWorkspaceAgent(agentsById, {
        runtimeId: runtime.id,
        profileId,
        collectedAt,
      }),
    });
  }
  return profiles;
}

function collectSlockRuntimeSkillProbes({ collectedAt, deviceId, skillProfiles }) {
  const probesByRuntimeId = new Map();
  for (const localProfile of skillProfiles) {
    const productAgent = localProfile.productAgent;
    if (!productAgent) continue;
    const agentIds = [productAgent.id];
    const accumulator = ensureSlockRuntimeSkillProbeAccumulator(probesByRuntimeId, {
      collectedAt,
      deviceId,
      productAgent,
      runtimeKind: localProfile.runtimeKind,
    });
    const agentRoot = path.join(slockRoot(), "agents", sanitizeId(localProfile.profileId));
    for (const skillDir of listSkillDirectories(path.join(agentRoot, ".agents", "skills"))) {
      mergeCollectedRuntimeSkillRow(accumulator.rowsByKey, skillRowFromDirectory(skillDir, {
        scope: "agent",
        builtIn: false,
        agentIds,
      }));
    }
    for (const skillFile of walkSkillFiles(path.join(agentRoot, "repos"), { maxDepth: 14 })) {
      if (!isSlockRepoAgentSkillFile(skillFile)) continue;
      mergeCollectedRuntimeSkillRow(accumulator.rowsByKey, skillRowFromDirectory(path.dirname(skillFile), {
        scope: "agent",
        builtIn: false,
        agentIds,
      }));
    }
  }

  return Array.from(probesByRuntimeId.values())
    .map((entry) => {
      const skills = sortRuntimeSkillRows(Array.from(entry.rowsByKey.values()));
      if (!skills.length) return null;
      return {
        deviceId: entry.deviceId,
        runtimeId: entry.runtimeId,
        runtimeKind: entry.runtimeKind,
        status: "succeeded",
        observedAt: entry.observedAt,
        summary: createRuntimeSkillSummary(skills),
        skills,
      };
    })
    .filter(Boolean);
}

function readSlockWorkspaceAgentDirectoryIds() {
  const agentsRoot = path.join(slockRoot(), "agents");
  try {
    return readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function slockAgentRootHasSkillFiles(agentRoot) {
  if (listSkillDirectories(path.join(agentRoot, ".agents", "skills")).length > 0) return true;
  return walkSkillFiles(path.join(agentRoot, "repos"), { maxDepth: 14 }).some(isSlockRepoAgentSkillFile);
}

function ensureSlockRuntimeSkillProbeAccumulator(probesByRuntimeId, { collectedAt, deviceId, productAgent, runtimeKind }) {
  const runtimeId = productAgent.runtimeId;
  if (!probesByRuntimeId.has(runtimeId)) {
    probesByRuntimeId.set(runtimeId, {
      deviceId,
      runtimeId,
      runtimeKind,
      observedAt: collectedAt,
      rowsByKey: new Map(),
    });
  }
  return probesByRuntimeId.get(runtimeId);
}

function ensureSlockSkillWorkspaceAgent(agentsById, { runtimeId, profileId, collectedAt }) {
  const agent = {
    ...createProductAgent({
      runtimeId,
      externalId: profileId,
      name: slockSkillWorkspaceDisplayName(profileId),
      collectionStatus: "offline",
      lastSeenAt: undefined,
      diagnostics: {
        paths: slockAgentRootPaths(profileId),
      },
    }),
    id: `${runtimeId}:agent:slock:${sanitizeId(profileId)}`,
  };
  if (!agentsById.has(agent.id)) agentsById.set(agent.id, agent);
  return agentsById.get(agent.id);
}

function slockSkillWorkspaceDisplayName(profileId) {
  const memoryPath = path.join(slockRoot(), "agents", sanitizeId(profileId), "MEMORY.md");
  try {
    for (const line of readFileSync(memoryPath, "utf8").split(/\r?\n/).slice(0, 20)) {
      const match = /^#\s+(.+)$/.exec(line.trim());
      const name = cleanText(match?.[1]);
      if (name) return name.slice(0, 80);
    }
  } catch {
    // Fall back to the stable local profile id.
  }
  return cleanText(profileId) || "Slock Agent";
}

function isSlockRepoAgentSkillFile(skillFile) {
  if (path.basename(skillFile) !== "SKILL.md") return false;
  const skillDir = path.dirname(skillFile);
  const skillsDir = path.dirname(skillDir);
  if (path.basename(skillsDir) !== "skills") return false;
  const ownerDir = path.basename(path.dirname(skillsDir));
  return ownerDir === ".agents" || ownerDir === ".cursor";
}

function collectSlockTasksFromChannel({
  baseUrl,
  channelTarget,
  readerAgentId,
  localProfiles,
  profileClassifications,
  workspaceAgentIds,
  auth,
  diagnostics,
  tasksById,
  replyCache,
  replyThreadReadBudget,
}) {
  const history = readSlockHistoryPages({
    baseUrl,
    agentId: readerAgentId,
    target: channelTarget,
    auth,
    diagnostics,
  });
  if (history.incomplete) return;

  const conversationTitle = slockConversationTitle(history.channelName, channelTarget);
  for (const message of history.messages) {
    if (!isSlockTaskCandidate(message)) continue;
    const messageId = slockMessageId(message);
    if (!messageId) continue;

    const assigneeId = slockTaskAssigneeId(message);
    if (!assigneeId) {
      diagnostics.add(slockDiagnostic("slock_unassigned_task_ignored", "info", "task", "task_dropped"), messageId);
      continue;
    }

    const assigneeProfile = localProfiles.find((profile) => profile.profileId === assigneeId);
    if (!assigneeProfile) {
      const classification = slockAssigneeClassification(profileClassifications, workspaceAgentIds, assigneeId);
      if (classification) diagnostics.add(classification, messageId);
      continue;
    }

    const userMessage = cleanSlockTaskText(slockMessageContent(message));
    if (!userMessage) {
      diagnostics.add(slockDiagnostic("slock_missing_user_message", "warning", "task", "task_dropped"), messageId);
      continue;
    }

    const agent = assigneeProfile.productAgent;
    const taskId = makeProductTaskId(agent.id, messageId);
    const threadTarget = slockThreadTarget(channelTarget, messageId);
    const fingerprint = slockReplyFingerprint(message);
    const cachedReply = replyCache.tasks[taskId];
    const cachedAgentReply = cachedReply?.agentReply
      ? { text: cleanSlockTaskText(cachedReply.agentReply), updatedAt: toIsoTimestamp(cachedReply.replyUpdatedAt) }
      : { text: "", updatedAt: undefined };
    let agentReply = cachedReply?.fingerprint === fingerprint
      ? cachedAgentReply
      : { text: "", updatedAt: undefined };
    let agentReplyGapCode = cachedReply?.fingerprint === fingerprint && !cachedAgentReply.text
      ? cleanSlockTaskText(cachedReply.missingReason)
      : "";
    let replyDeferred = false;
    let shouldWriteReplyCache = false;
    if (shouldFetchSlockAgentReply({ cachedEntry: cachedReply, fingerprint, message })) {
      if (!canReadSlockReplyThread(replyThreadReadBudget)) {
        replyDeferred = true;
        diagnostics.add(slockDiagnostic("slock_agent_reply_deferred", "info", "task", "task_ingested_with_gap"), messageId);
      } else {
        replyThreadReadBudget.remaining -= 1;
        const thread = readSlockHistoryPages({
          baseUrl,
          agentId: assigneeProfile.profileId,
          target: threadTarget,
          auth,
          diagnostics,
          failureDiagnosticCode: "",
        });
        if (thread.incomplete) {
          if (cachedAgentReply.text) agentReply = cachedAgentReply;
          agentReplyGapCode = Number(thread.statusCode) === 404
            ? "slock_agent_reply_thread_unavailable"
            : "slock_agent_reply_fetch_failed";
        } else if (thread.messages.length === 0) {
          agentReply = { text: "", updatedAt: undefined };
          agentReplyGapCode = "slock_agent_reply_thread_empty";
          shouldWriteReplyCache = true;
        } else {
          agentReply = slockLatestAgentReply(thread.messages, assigneeProfile.profile, message);
          agentReplyGapCode = agentReply.text ? "" : "slock_missing_agent_reply";
          shouldWriteReplyCache = true;
        }
      }
    }
    if (shouldWriteReplyCache) {
      replyCache.tasks[taskId] = {
        fingerprint,
        agentReply: agentReply.text || "",
        ...(agentReply.updatedAt ? { replyUpdatedAt: agentReply.updatedAt } : {}),
        ...(agentReplyGapCode && !agentReply.text ? { missingReason: agentReplyGapCode } : {}),
        lastCheckedAt: new Date().toISOString(),
      };
    }
    const rawStatus = slockRawTaskStatus(message);
    const status = normalizeSlockTaskStatus(rawStatus);
    if (status === "unknown") {
      diagnostics.add(slockDiagnostic("slock_unknown_task_status", "warning", "task", "task_ingested_with_gap"), messageId);
    }
    if (!replyDeferred && status === "done" && !agentReply.text) {
      diagnostics.add(slockDiagnostic(agentReplyGapCode || "slock_missing_agent_reply", "warning", "task", "task_ingested_with_gap"), messageId);
    }

    const messageUpdatedAt = toIsoTimestamp(message.updatedAt || message.updated_at || message.createdAt || message.created_at);
    const lastActivityAt = latestIsoTimestamp(messageUpdatedAt, agentReply.updatedAt);
    const task = {
      id: taskId,
      agentId: agent.id,
      taskType: "conversation",
      status,
      userMessage,
      ...(agentReply.text ? { agentReply: agentReply.text } : {}),
      adapter: { kind: "slock" },
      channel: { kind: "slock", externalId: channelTarget },
      conversation: {
        title: conversationTitle,
        externalId: channelTarget,
        ...(lastActivityAt ? { lastActivityAt } : {}),
      },
      ...(slockCreator(message) ? { creator: slockCreator(message) } : {}),
      assignee: {
        name: slockProfileDisplayName(assigneeProfile.profile),
        externalId: slockProfileId(assigneeProfile.profile),
      },
      raw: {
        slock: {
          ...(rawStatus ? { status: rawStatus } : {}),
          ...(slockTaskNumber(message) ? { taskNumber: slockTaskNumber(message) } : {}),
          messageId,
          channelTarget,
          threadTarget,
          ...(toIsoTimestamp(message.taskClaimedAt || message.claimedAt) ? { taskClaimedAt: toIsoTimestamp(message.taskClaimedAt || message.claimedAt) } : {}),
          ...(toIsoTimestamp(message.taskCompletedAt || message.completedAt) ? { taskCompletedAt: toIsoTimestamp(message.taskCompletedAt || message.completedAt) } : {}),
        },
      },
      ...(toIsoTimestamp(message.createdAt || message.created_at) ? { createdAt: toIsoTimestamp(message.createdAt || message.created_at) } : {}),
      ...(lastActivityAt ? { updatedAt: lastActivityAt } : {}),
    };
    tasksById.set(task.id, task);
  }
}

function slockConfiguredBaseUrl(config = {}, daemonConfig = {}) {
  return process.env.LORUME_SLOCK_BASE_URL ||
    process.env.LORUME_SLOCK_SERVER_URL ||
    config.slockBaseUrl ||
    config.slockServerUrl ||
    config.slock?.baseUrl ||
    config.slock?.serverUrl ||
    daemonConfig.baseUrl ||
    "";
}

function slockConfiguredAuth(config = {}, daemonConfig = {}) {
  return {
    token: process.env.LORUME_SLOCK_AUTH_TOKEN ||
      process.env.LORUME_SLOCK_API_KEY ||
      config.slockAuthToken ||
      config.slockApiKey ||
      config.slockToken ||
      config.slock?.authToken ||
      config.slock?.apiKey ||
      config.slock?.token ||
      daemonConfig.token ||
      "",
    serverId: process.env.LORUME_SLOCK_SERVER_ID ||
      config.slockServerId ||
      config.slock?.serverId ||
      daemonConfig.serverId ||
      "",
  };
}

function slockConfiguredAgentIds(config = {}, daemonConfig = {}) {
  const raw = process.env.LORUME_SLOCK_AGENT_IDS || config.slockAgentIds || config.slock?.agentIds || "";
  const values = raw ? (Array.isArray(raw) ? raw : String(raw).split(",")) : (daemonConfig.agentIds || []);
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function discoverSlockDaemonConfig(workspaceAgentIds = new Set()) {
  if (workspaceAgentIds.size === 0) {
    return { baseUrl: "", token: "", serverId: "", agentIds: [] };
  }

  const candidates = readLocalProcessList()
    .split(/\r?\n/)
    .map(parseSlockDaemonProcessLine)
    .filter(Boolean)
    .filter((candidate) => slockDaemonCandidateMatchesWorkspace(candidate, workspaceAgentIds));
  if (!candidates.length) return { baseUrl: "", token: "", serverId: "", agentIds: [] };

  const credential = candidates.find((candidate) => candidate.baseUrl && candidate.token) || {};
  const agentIds = uniqueSlockIds(
    candidates
      .flatMap((candidate) => candidate.agentIds || [])
      .filter((agentId) => slockWorkspaceHasAgent(workspaceAgentIds, agentId)),
  );

  return {
    baseUrl: credential.baseUrl || "",
    token: credential.token || "",
    serverId: credential.serverId || "",
    agentIds,
  };
}

function readLocalProcessList() {
  try {
    return execFileSync("ps", ["auxww"], {
      encoding: "utf8",
      maxBuffer: DEFAULT_PROBE_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function parseSlockDaemonProcessLine(line) {
  const value = String(line || "");
  if (!isSlockDaemonProcessLine(value)) return null;

  const baseUrl = normalizeDiscoveredSlockBaseUrl(
    processArgValue(value, "server-url") ||
    processArgValue(value, "base-url") ||
    processArgValue(value, "url"),
  );
  const token = normalizeDiscoveredSlockToken(
    processArgValue(value, "auth-token") ||
    processArgValue(value, "api-key") ||
    processArgValue(value, "token"),
  );
  if (!baseUrl || !token) return null;

  const agentId = normalizeDiscoveredSlockAgentId(
    processArgValue(value, "agent-id") ||
    processArgValue(value, "agent"),
  );
  const serverId = normalizeDiscoveredSlockAgentId(processArgValue(value, "server-id"));
  return {
    baseUrl,
    token,
    serverId,
    agentIds: agentId ? [agentId] : [],
  };
}

function isSlockDaemonProcessLine(line) {
  const value = String(line || "");
  if (!value.includes("--server-url") && !value.includes("--base-url") && !value.includes("--url")) return false;
  if (!value.includes("--auth-token") && !value.includes("--api-key") && !value.includes("--token")) return false;
  return value.includes("slock") || value.includes("chat-bridge.js");
}

function processArgValue(line, name) {
  const flag = `--${name}`;
  const escaped = escapeRegExp(flag);
  const patterns = [
    new RegExp(`["']${escaped}["']\\s*,\\s*["']([^"']+)["']`),
    new RegExp(`${escaped}=([^\\s"']+)`),
    new RegExp(`${escaped}\\s+([^\\s"']+)`),
  ];
  for (const pattern of patterns) {
    const match = String(line || "").match(pattern);
    if (!match?.[1]) continue;
    return String(match[1]).trim().replace(/[,\]]+$/g, "");
  }
  return "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDiscoveredSlockBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? normalizeSlockBaseUrl(raw) : "";
  } catch {
    return "";
  }
}

function normalizeDiscoveredSlockToken(value) {
  const raw = String(value || "").trim();
  if (raw.length < 8) return "";
  return /^[A-Za-z0-9._:+=/-]+$/.test(raw) ? raw : "";
}

function normalizeDiscoveredSlockAgentId(value) {
  const raw = String(value || "").trim();
  return raw && /^[A-Za-z0-9._:-]+$/.test(raw) ? raw : "";
}

function slockDaemonCandidateMatchesWorkspace(candidate, workspaceAgentIds) {
  if (!workspaceAgentIds.size) return false;
  if (!candidate.agentIds?.length) return true;
  return candidate.agentIds.some((agentId) => slockWorkspaceHasAgent(workspaceAgentIds, agentId));
}

function slockMaxReplyThreadReadsPerRun(config = {}) {
  const raw = process.env.LORUME_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN ??
    config.slockMaxReplyThreadReadsPerRun ??
    config.slock?.maxReplyThreadReadsPerRun;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SLOCK_MAX_REPLY_THREAD_READS_PER_RUN;
  return Math.floor(value);
}

function slockReplyEnrichmentBudgetMs(config = {}) {
  const raw = process.env.LORUME_SLOCK_REPLY_ENRICHMENT_BUDGET_MS ??
    config.slockReplyEnrichmentBudgetMs ??
    config.slock?.replyEnrichmentBudgetMs;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SLOCK_REPLY_ENRICHMENT_BUDGET_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SLOCK_REPLY_ENRICHMENT_BUDGET_MS;
  return Math.floor(value);
}

function canReadSlockReplyThread(budget) {
  if (budget.remaining <= 0) return false;
  if (budget.budgetMs <= 0) return false;
  return Date.now() - budget.startedAt < budget.budgetMs;
}

function resolveSlockReplyCachePath(config = {}) {
  return process.env.LORUME_SLOCK_REPLY_CACHE_PATH ||
    config.slockReplyCachePath ||
    config.slock?.replyCachePath ||
    path.join(homeDir(), ".lorume", "slock-reply-cache.json");
}

function createSlockReplyCacheScope(baseUrl, deviceId) {
  return {
    baseUrl: normalizeSlockBaseUrl(baseUrl),
    deviceId: String(deviceId || ""),
  };
}

function normalizeSlockBaseUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ""));
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/g, "");
    return url.toString().replace(/\/$/g, "");
  } catch {
    return String(baseUrl || "").replace(/\/+$/g, "");
  }
}

function readSlockReplyCache(cachePath, scope) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schemaVersion === SLOCK_REPLY_CACHE_SCHEMA_VERSION &&
      slockReplyCacheScopesEqual(parsed.scope, scope) &&
      parsed.tasks &&
      typeof parsed.tasks === "object"
    ) {
      return {
        schemaVersion: SLOCK_REPLY_CACHE_SCHEMA_VERSION,
        scope,
        tasks: parsed.tasks,
      };
    }
  } catch {
    // Missing or malformed cache starts empty.
  }
  return { schemaVersion: SLOCK_REPLY_CACHE_SCHEMA_VERSION, scope, tasks: {} };
}

function slockReplyCacheScopesEqual(left, right) {
  return Boolean(left && right) &&
    left.baseUrl === right.baseUrl &&
    left.deviceId === right.deviceId;
}

function writeSlockReplyCache(cachePath, cache) {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(tempPath, cachePath);
}

function uniqueSlockIds(values) {
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function classifySlockProfileResult({ device, agentId, profileResult, workspaceAgentIds }) {
  if (profileResult.notFound) {
    const code = slockWorkspaceHasAgent(workspaceAgentIds, agentId)
      ? "slock_inactive_workspace_task_ignored"
      : "slock_remote_agent_task_ignored";
    const severity = code === "slock_inactive_workspace_task_ignored" ? "warning" : "info";
    return { diagnostic: slockDiagnostic(code, severity, "agent", "ignored") };
  }
  if (profileResult.failed || !profileResult.profile) {
    return { diagnostic: slockDiagnostic("slock_profile_unreadable", "error", "adapter", "ignored") };
  }

  const profile = profileResult.profile;
  const profileId = slockProfileId(profile);
  if (!isSlockActiveProfile(profile)) {
    return { profileId, diagnostic: slockDiagnostic("slock_inactive_workspace_task_ignored", "warning", "agent", "ignored") };
  }
  if (!isSlockProfileForCurrentDevice(profile, device)) {
    return { profileId, diagnostic: slockDiagnostic("slock_remote_agent_task_ignored", "info", "agent", "ignored") };
  }
  const runtimeKind = slockSupportedRuntimeKind(slockProfileRuntime(profile));
  if (!runtimeKind) {
    return { profileId, diagnostic: slockDiagnostic("slock_unsupported_runtime_ignored", "info", "agent", "ignored") };
  }
  return { profile, profileId, runtimeKind };
}

function slockAssigneeClassification(profileClassifications, workspaceAgentIds, assigneeId) {
  const classification = profileClassifications.get(String(assigneeId));
  if (classification) return null;
  const code = slockWorkspaceHasAgent(workspaceAgentIds, assigneeId)
    ? "slock_inactive_workspace_task_ignored"
    : "slock_remote_agent_task_ignored";
  const severity = code === "slock_inactive_workspace_task_ignored" ? "warning" : "info";
  return slockDiagnostic(code, severity, "task", "task_dropped");
}

function slockDiagnostic(code, severity, target, action) {
  return { source: "slock", code, severity, target, action };
}

function readSlockWorkspaceAgentIds() {
  const agentsRoot = path.join(slockRoot(), "agents");
  const ids = new Set();
  try {
    for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      ids.add(entry.name);
      ids.add(sanitizeId(entry.name));
    }
  } catch {
    // Missing local Slock workspace means only active profile can prove ownership.
  }
  return ids;
}

function slockWorkspaceHasAgent(workspaceAgentIds, agentId) {
  return workspaceAgentIds.has(String(agentId)) || workspaceAgentIds.has(sanitizeId(agentId));
}

function readSlockProfileCached(baseUrl, agentId, cache, auth) {
  const key = String(agentId);
  if (cache.has(key)) return cache.get(key);
  const result = readSlockProfile(baseUrl, key, auth);
  cache.set(key, result);
  return result;
}

function readSlockProfile(baseUrl, agentId, auth) {
  const response = readSlockJson(
    baseUrl,
    `/internal/agent/${encodeURIComponent(agentId)}/profile`,
    {},
    slockAuthForAgent(auth, agentId),
  );
  if (response.statusCode === 404) return { profile: null, notFound: true };
  if (!response.ok || !response.value || typeof response.value !== "object") return { profile: null, failed: true };
  return { profile: response.value.profile || response.value.agent || response.value };
}

function discoverSlockJoinedChannelTargets(baseUrl, agentId, auth, diagnostics) {
  const response = readSlockJson(
    baseUrl,
    `/internal/agent/${encodeURIComponent(agentId)}/server`,
    {},
    slockAuthForAgent(auth, agentId),
  );
  if (!response.ok || !response.value || typeof response.value !== "object") {
    diagnostics.add(slockDiagnostic("slock_channel_discovery_failed", "error", "adapter", "ignored"), agentId);
    return [];
  }
  const channels = toRecordArray(response.value.channels);
  return uniqueSlockIds(
    channels
      .filter((channel) => channel.joined === true)
      .map(slockServerChannelTarget),
  );
}

function slockServerChannelTarget(channel) {
  const target = cleanSlockTaskText(channel?.target || channel?.ref);
  if (target) return target;
  const name = cleanSlockTaskText(channel?.name);
  if (name) return name.startsWith("#") ? name : `#${name}`;
  const id = cleanSlockTaskText(channel?.id);
  return id ? `#${id}` : "";
}

function readSlockHistoryPages({ baseUrl, agentId, target, auth, diagnostics, failureDiagnosticCode = "slock_history_pagination_incomplete" }) {
  const messages = [];
  let channelName = "";
  let before = "";

  for (let pageIndex = 0; pageIndex < SLOCK_HISTORY_MAX_PAGES; pageIndex += 1) {
    const response = readSlockJson(baseUrl, `/internal/agent/${encodeURIComponent(agentId)}/history`, {
      channel: target,
      limit: String(SLOCK_HISTORY_PAGE_LIMIT),
      ...(before ? { before } : {}),
    }, slockAuthForAgent(auth, agentId));
    if (!response.ok || !response.value || typeof response.value !== "object") {
      if (failureDiagnosticCode) diagnostics.add(slockDiagnostic(failureDiagnosticCode, "error", "adapter", "ignored"), target);
      return { messages: [], channelName, incomplete: true, statusCode: response.statusCode };
    }

    const page = response.value;
    channelName ||= cleanSlockTaskText(page.channelName || page.channel?.name || page.conversation?.title || page.name);
    const pageMessages = toRecordArray(page.messages || page.items || page.records);
    messages.push(...pageMessages);

    const hasMore = slockPaginationFlag(page.hasMore ?? page.has_more);
    const hasOlder = slockPaginationFlag(page.hasOlder ?? page.has_older);
    const hasExplicitPaginationFlags = hasMore !== undefined || hasOlder !== undefined;
    const shouldContinue = hasExplicitPaginationFlags
      ? Boolean(hasMore || hasOlder)
      : pageMessages.length >= SLOCK_HISTORY_PAGE_LIMIT;
    if (!shouldContinue) return { messages, channelName, incomplete: false, statusCode: response.statusCode };

    const nextBefore = slockNextBeforeCursor(pageMessages);
    if (!nextBefore || nextBefore === before) {
      if (failureDiagnosticCode) diagnostics.add(slockDiagnostic(failureDiagnosticCode, "error", "adapter", "ignored"), target);
      return { messages: [], channelName, incomplete: true, statusCode: response.statusCode };
    }
    before = nextBefore;
  }

  if (failureDiagnosticCode) diagnostics.add(slockDiagnostic(failureDiagnosticCode, "error", "adapter", "ignored"), target);
  return { messages: [], channelName, incomplete: true, statusCode: 0 };
}

function slockAuthForAgent(auth, agentId) {
  return {
    token: auth?.token || "",
    serverId: auth?.serverId || "",
    agentId,
  };
}

function readSlockJson(baseUrl, pathname, params = {}, auth = {}) {
  let lastResponse = { ok: false, statusCode: 0, value: null };
  for (let attempt = 0; attempt < SLOCK_HTTP_MAX_ATTEMPTS; attempt += 1) {
    const response = readSlockJsonOnce(baseUrl, pathname, params, auth);
    if (response.ok || !shouldRetrySlockHttpResponse(response)) return response;
    lastResponse = response;
  }
  return lastResponse;
}

function shouldRetrySlockHttpResponse(response) {
  const statusCode = Number(response?.statusCode);
  if (!Number.isFinite(statusCode) || statusCode === 0) return true;
  if (statusCode === 408 || statusCode === 429) return true;
  return statusCode >= 500;
}

function readSlockJsonOnce(baseUrl, pathname, params = {}, auth = {}) {
  let url;
  try {
    url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    return { ok: false, statusCode: 0, value: null };
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  try {
    const args = [
      "--silent",
      "--show-error",
      "--max-time",
      String(SLOCK_HTTP_TIMEOUT_SECONDS),
      "--write-out",
      "\n%{http_code}",
    ];
    if (auth.token) args.push("--header", `Authorization: Bearer ${auth.token}`);
    if (auth.agentId) args.push("--header", `X-Agent-Id: ${auth.agentId}`);
    args.push("--header", "X-Slock-Client: lorume-collector");
    if (auth.serverId) args.push("--header", `X-Server-Id: ${auth.serverId}`);
    args.push(url.toString());

    const output = execFileSync("curl", args, {
      encoding: "utf8",
      maxBuffer: DEFAULT_PROBE_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const marker = output.lastIndexOf("\n");
    const body = marker >= 0 ? output.slice(0, marker) : output;
    const statusCode = Number(marker >= 0 ? output.slice(marker + 1).trim() : "0");
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      return { ok: false, statusCode, value: null };
    }
    return { ok: true, statusCode, value: JSON.parse(body || "null") };
  } catch {
    return { ok: false, statusCode: 0, value: null };
  }
}

function slockNextBeforeCursor(messages) {
  const seqs = messages
    .map((message) => Number(message?.seq ?? message?.sequence ?? message?.cursor))
    .filter((value) => Number.isFinite(value));
  if (!seqs.length) return "";
  return String(Math.min(...seqs));
}

function slockPaginationFlag(value) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function isSlockTaskCandidate(message) {
  return Boolean(message && typeof message === "object" && (
    slockTaskAssigneeId(message) ||
    slockTaskNumber(message) ||
    slockRawTaskStatus(message)
  ));
}

function slockMessageId(message) {
  const id = message?.id || message?.messageId || message?.msgId || message?.taskMessageId || message?.task?.messageId || message?.taskNumber;
  return id ? String(id) : "";
}

function slockTaskAssigneeId(message) {
  const id = message?.taskAssigneeId ||
    message?.assigneeId ||
    message?.assignedAgentId ||
    message?.agentId ||
    message?.task?.assigneeId ||
    message?.task?.agentId ||
    message?.task?.assignee?.id;
  return id ? String(id) : "";
}

function slockTaskNumber(message) {
  const value = message?.taskNumber || message?.task?.number || message?.task?.taskNumber;
  return value ? String(value) : "";
}

function slockRawTaskStatus(message) {
  const value = message?.taskStatus || message?.status || message?.task?.status;
  return value ? String(value) : "";
}

function slockReplyFingerprint(message) {
  return hashStableJson({
    messageId: slockMessageId(message),
    taskAssigneeId: slockTaskAssigneeId(message),
    taskStatus: slockRawTaskStatus(message),
    replyCount: slockReplyCount(message),
    threadId: message?.threadId || null,
    updatedAt: toIsoTimestamp(message?.updatedAt || message?.updated_at) || null,
    taskClaimedAt: toIsoTimestamp(message?.taskClaimedAt || message?.claimedAt) || null,
    taskCompletedAt: toIsoTimestamp(message?.taskCompletedAt || message?.completedAt) || null,
  });
}

function slockReplyCount(message) {
  const value = Number(message?.replyCount ?? message?.reply_count);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function shouldFetchSlockAgentReply({ cachedEntry, fingerprint, message }) {
  if (cachedEntry?.fingerprint === fingerprint) return false;
  const replyCount = slockReplyCount(message);
  if (!cachedEntry && replyCount === 0) return false;
  return true;
}

function slockMessageContent(message) {
  return message?.content ?? message?.text ?? message?.message ?? message?.body?.content ?? message?.task?.content ?? "";
}

function slockMessageSenderId(message) {
  const id = message?.senderId || message?.sender?.id || message?.userId || message?.user?.id;
  return id ? String(id) : "";
}

function slockMessageSenderName(message) {
  const name = message?.senderName || message?.sender?.name || message?.sender?.displayName || message?.userName || message?.user?.name;
  return name ? String(name) : "";
}

function slockCreator(message) {
  const name = slockMessageSenderName(message);
  const externalId = slockMessageSenderId(message);
  if (!name && !externalId) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(externalId ? { externalId } : {}),
  };
}

function slockProfileId(profile) {
  const id = profile?.id || profile?.agentId || profile?.profileId;
  return id ? String(id) : "unknown";
}

function slockProfileRuntime(profile) {
  const value = profile?.runtime || profile?.runtimeKind || profile?.executor?.runtime || profile?.model?.runtime;
  return value ? String(value) : "";
}

function slockProfileDisplayName(profile) {
  return String(profile?.displayName || profile?.name || slockProfileId(profile));
}

function isSlockActiveProfile(profile) {
  return String(profile?.status || profile?.state || "").trim().toLowerCase() === "active";
}

function isSlockProfileForCurrentDevice(profile, device) {
  const profileHosts = slockProfileHostnames(profile);
  if (!profileHosts.length) return true;
  const expectedHosts = [
    process.env.LORUME_SLOCK_COMPUTER_HOSTNAME,
    device.hostname,
    device.id,
  ].map(normalizeSlockHostname).filter(Boolean);
  if (!expectedHosts.length) return false;
  return profileHosts.some((hostnameValue) => expectedHosts.includes(hostnameValue));
}

function slockProfileHostnames(profile) {
  return [
    profile?.computerHostname,
    profile?.deviceHostname,
    profile?.hostname,
    profile?.computer?.hostname,
    profile?.device?.hostname,
  ].map(normalizeSlockHostname).filter(Boolean);
}

function normalizeSlockHostname(value) {
  return String(value || "").trim().toLowerCase();
}

function slockSupportedRuntimeKind(value) {
  const kind = sanitizeId(value);
  return SLOCK_SUPPORTED_RUNTIME_KINDS.has(kind) ? kind : "";
}

function slockRuntimeName(kind) {
  if (kind === "openclaw") return "OpenClaw";
  if (kind === "codex") return "Codex";
  return kind;
}

function ensureSlockRuntime(runtimesById, { deviceId, kind, collectedAt }) {
  const id = makeProductRuntimeId(deviceId, kind);
  if (!runtimesById.has(id)) {
    runtimesById.set(id, createProductRuntime({
      deviceId,
      kind,
      name: slockRuntimeName(kind),
      collectionStatus: "online",
      lastSeenAt: collectedAt,
    }));
  }
  return runtimesById.get(id);
}

function ensureSlockAgent(agentsById, { runtimeId, profile, collectedAt }) {
  const profileId = slockProfileId(profile);
  const agent = {
    ...createProductAgent({
      runtimeId,
      externalId: profileId,
      name: slockProfileDisplayName(profile),
      collectionStatus: "online",
      lastSeenAt: collectedAt,
      diagnostics: {
        paths: slockAgentRootPaths(profileId),
      },
    }),
    id: `${runtimeId}:agent:slock:${sanitizeId(profileId)}`,
  };
  if (!agentsById.has(agent.id)) agentsById.set(agent.id, agent);
  return agentsById.get(agent.id);
}

function slockThreadTarget(channelTarget, messageId) {
  return `${channelTarget}:${String(messageId).slice(0, 8)}`;
}

function slockConversationTitle(channelName, channelTarget) {
  const name = cleanSlockTaskText(channelName);
  if (name) return name;
  const target = String(channelTarget || "").trim();
  if (target.startsWith("#") && target.length > 1) return target.slice(1);
  return target || "Slock";
}

function normalizeSlockTaskStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "todo" || normalized === "pending" || normalized === "queued") return "todo";
  if (normalized === "in_progress" || normalized === "running" || normalized === "active") return "in_progress";
  if (normalized === "in_review" || normalized === "review") return "review";
  if (normalized === "done" || normalized === "completed" || normalized === "success" || normalized === "succeeded") return "done";
  if (normalized === "closed" || normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "unknown";
}

function slockLatestAgentReply(messages, profile, taskMessage) {
  const profileId = slockProfileId(profile);
  const taskCreatedAt = Date.parse(toIsoTimestamp(taskMessage.createdAt || taskMessage.created_at) || "");
  const replies = messages
    .map((message) => {
      const senderId = slockMessageSenderId(message);
      const text = cleanSlockTaskText(slockMessageContent(message));
      const updatedAt = toIsoTimestamp(message.updatedAt || message.updated_at || message.createdAt || message.created_at);
      return { senderId, text, updatedAt };
    })
    .filter((message) => message.senderId === profileId && message.text)
    .filter((message) => {
      if (!Number.isFinite(taskCreatedAt) || !message.updatedAt) return true;
      return Date.parse(message.updatedAt) >= taskCreatedAt;
    })
    .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
  return replies[0] || { text: "", updatedAt: undefined };
}

function orderSlockProductTasks(tasks) {
  return [...tasks].sort(compareOpenClawTasksByRecency);
}

function cleanSlockTaskText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
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

function collectOpenClawProductTrajectoryTasks({ runs, knownAgentIds, runtimeId }) {
  const dingtalkState = readOpenClawDingTalkState();
  const tasks = [];
  const diagnostics = createCollectionDiagnosticCollector();
  const agentExternalIds = new Set();
  const taskAgentExternalIds = new Map();

  for (const run of runs) {
    const taskType = inferOpenClawTaskType(run);
    const runId = String(run.runId || "run");
    const eligibility = openClawTrajectoryTaskEligibility(run, taskType);
    if (!eligibility.create) {
      diagnostics.add(openClawEligibilityDiagnostic(eligibility.reason), runId);
      continue;
    }
    const agentResolution = resolveOpenClawTrajectoryAgentExternalId(run, knownAgentIds);
    if (!agentResolution.agentExternalId) {
      diagnostics.add(openClawAgentDiagnostic(agentResolution.reason), runId);
      continue;
    }
    if (knownAgentIds.length && !knownAgentIds.includes(agentResolution.agentExternalId)) {
      diagnostics.add(openClawAgentDiagnostic("uncollected OpenClaw agent"), runId);
      continue;
    }

    const agentId = makeAgentId(runtimeId, agentResolution.agentExternalId);
    const trajectoryChannel = openClawChannelFromTrajectoryRun(run, dingtalkState.targetsByConversationId);
    const channel = trajectoryChannel ? openClawProductChannel(trajectoryChannel) : undefined;
    const lastActivityAt = run.lastEventAt || run.endedAt || run.startedAt;
    const userMessageResult = openClawProductUserMessage(run, taskType, channel, dingtalkState);
    if (!userMessageResult.userMessage) {
      diagnostics.add(openClawUserMessageDiagnostic(userMessageResult.reason), runId);
      continue;
    }
    if (isOpenClawInternalRuntimeContextText(userMessageResult.userMessage)) {
      diagnostics.add(
        openClawEligibilityDiagnostic(
          isOpenClawInternalSubagentContextText(userMessageResult.userMessage)
            ? "internal subagent run"
            : "internal system run",
        ),
        runId,
      );
      continue;
    }
    const status = normalizeOpenClawTrajectoryProductTaskStatus(run);
    const toolError = firstOpenClawFailedToolCallError(run.toolCalls);
    const error = openClawTrajectoryError(run) || toolError;
    const agentReply = openClawProductAgentReply(run);
    if (shouldWarnOpenClawMissingAgentReply({ agentReply, error, run, status, taskType })) {
      diagnostics.add({
        action: "task_ingested_with_gap",
        code: "openclaw_missing_agent_reply",
        severity: "warning",
        source: "openclaw",
        target: "task",
      }, runId);
    }
    const creator = openClawProductCreatorFromTrajectoryRun(run) || openClawProductCreatorFromDingTalkMessage(userMessageResult.message);

    const task = {
      id: makeProductTaskId(agentId, runId),
      agentId,
      taskType,
      userMessage: userMessageResult.userMessage,
      ...(agentReply ? { agentReply } : {}),
      status,
      adapter: { kind: "openclaw" },
      ...(channel ? { channel } : {}),
      ...(channel ? { conversation: {
        title: trajectoryChannel?.conversationTitle || trajectoryChannel?.label || channel.kind,
        ...(trajectoryChannel?.externalId || openClawProductConversationExternalId(run.sessionKey, run.conversationId) ? {
          externalId: trajectoryChannel?.externalId || openClawProductConversationExternalId(run.sessionKey, run.conversationId),
        } : {}),
        ...(lastActivityAt ? { lastActivityAt } : {}),
      } } : {}),
      ...(creator ? { creator } : {}),
      assignee: {
        name: agentResolution.agentExternalId || "main",
        externalId: agentResolution.agentExternalId || "main",
      },
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
      ...(lastActivityAt ? { updatedAt: lastActivityAt } : {}),
      ...(status === "failed" && error ? { error } : {}),
    };
    tasks.push(task);
    taskAgentExternalIds.set(task.id, agentResolution.agentExternalId);
  }

  const orderedTasks = orderOpenClawProductTasks(tasks);
  const visibleAgentExternalIds = new Set(
    orderedTasks
      .map((task) => taskAgentExternalIds.get(task.id))
      .filter(Boolean),
  );
  for (const agentExternalId of visibleAgentExternalIds) agentExternalIds.add(agentExternalId);

  return { tasks: orderedTasks, diagnostics: diagnostics.items(), agentExternalIds: Array.from(agentExternalIds) };
}

function shouldWarnOpenClawMissingAgentReply({ agentReply, error, run, status, taskType }) {
  const expectsReply = taskType === "conversation" || taskType === "scheduled";
  return status === "done" &&
    expectsReply &&
    !agentReply &&
    !error &&
    !run.didSendViaMessagingTool;
}

function orderOpenClawProductTasks(tasks) {
  return [...tasks].sort(compareOpenClawTasksByRecency);
}

function compareOpenClawTasksByRecency(left, right) {
  const rightTime = taskTimestampMillis(right);
  const leftTime = taskTimestampMillis(left);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return String(left.id).localeCompare(String(right.id));
}

function taskTimestampMillis(task) {
  for (const value of [task.updatedAt, task.createdAt]) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
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
  if (channel?.kind !== "dingtalk" && channel?.kind !== "webchat") return undefined;
  return {
    kind: channel.kind,
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

function openClawProductCreatorFromDingTalkMessage(message) {
  if (!message?.senderName && !message?.senderId) return undefined;
  return {
    name: String(message.senderName || message.senderId),
    ...(message.senderId ? { externalId: String(message.senderId) } : {}),
  };
}

function openClawProductUserMessage(run, taskType, channel, dingtalkState) {
  const prompt = cleanOpenClawPromptText(run.prompt);
  if (taskType === "scheduled") {
    return prompt
      ? { userMessage: prompt }
      : { reason: "missing scheduled prompt" };
  }

  if (channel?.kind === "dingtalk") {
    const message = openClawDingTalkMessageForRun(run, dingtalkState);
    const text = cleanOpenClawTaskText(message?.text);
    if (text) return { userMessage: text, message };
    const snapshotText = cleanOpenClawTaskText(run.snapshotUserMessage);
    const conversationId = openClawProductConversationExternalId(run.sessionKey, run.conversationId);
    return snapshotText && run.messageId && conversationId
      ? { userMessage: snapshotText }
      : { reason: "missing DingTalk inbound message context" };
  }

  return prompt
    ? { userMessage: prompt }
    : { reason: "missing userMessage" };
}

function openClawDingTalkMessageForRun(run, dingtalkState) {
  const inboundMessages = dingtalkState.messages.filter((message) => message.direction === "inbound");
  if (run.messageId) {
    const messageId = String(run.messageId);
    const exact = inboundMessages.find((message) => message.msgId === messageId);
    if (exact) return exact;
  }
  const conversationId = run.conversationId || parseOpenClawSessionKey(run.sessionKey)?.conversationId;
  if (!conversationId) return undefined;
  for (const candidateId of openClawDingTalkConversationIdCandidates(conversationId, dingtalkState.targetsByConversationId)) {
    const candidates = inboundMessages.filter((message) => message.conversationId === candidateId);
    if (candidates.length === 1) return candidates[0];
  }
  return undefined;
}

function openClawDingTalkConversationIdCandidates(conversationId, targetsByConversationId) {
  const ids = [String(conversationId)];
  const target = targetsByConversationId.get(String(conversationId)) || targetsByConversationId.get(String(conversationId).toLowerCase());
  if (target?.conversationId) ids.push(String(target.conversationId));
  return Array.from(new Set(ids));
}

function openClawProductAgentReply(run) {
  if (!Array.isArray(run.assistantTexts)) return "";
  return cleanOpenClawTaskText(run.assistantTexts.join("\n"));
}

function cleanOpenClawTaskText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function compactPaths(paths) {
  return paths.filter((entry) => entry?.path && existsSync(entry.path));
}

function rootPath(root) {
  return root ? [{ label: "根目录", path: root }] : [];
}

function slockRoot() {
  return process.env.LORUME_SLOCK_HOME || path.join(homeDir(), ".slock");
}

function slockAgentRootPaths(profileId) {
  return compactPaths(rootPath(path.join(slockRoot(), "agents", sanitizeId(profileId))));
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
  const runtimeSkillProbes = Array.isArray(snapshot.runtimeSkillProbes)
    ? snapshot.runtimeSkillProbes.map((probe) => {
      const nextRuntimeId = idReplacements.get(probe.runtimeId) || String(probe.runtimeId || "").replace(`${snapshot.device.id}:`, `${nextDevice.id}:`);
      return {
        ...probe,
        deviceId: String(probe.deviceId || snapshot.device.id).replace(snapshot.device.id, nextDevice.id),
        runtimeId: nextRuntimeId,
        skills: Array.isArray(probe.skills)
          ? probe.skills.map((skill) => ({
            ...skill,
            agentIds: Array.isArray(skill.agentIds)
              ? skill.agentIds.map((agentId) => String(agentId).replace(`${snapshot.device.id}:`, `${nextDevice.id}:`))
              : [],
          }))
          : [],
      };
    })
    : undefined;
  return {
    ...snapshot,
    device: nextDevice,
    runtimes,
    agents,
    ...(runtimeSkillProbes ? { runtimeSkillProbes } : {}),
  };
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
  if (["cancelled", "canceled", "interrupted", "aborted"].includes(run.finalStatus) || ["cancelled", "canceled", "interrupted", "aborted"].includes(run.endedStatus)) return "cancelled";
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
          for (const [conversationId, user] of Object.entries({ ...(directory.users || {}), ...(directory.directs || {}) })) {
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
      const snapshotUserTurn = extractOpenClawMessagesSnapshotUserTurn(data.messagesSnapshot || data.messages_snapshot);
      if (snapshotUserTurn?.text) current.snapshotUserMessageCandidate ||= snapshotUserTurn.text;
      const snapshotRuntimeContext = snapshotUserTurn?.runtimeContext || extractOpenClawRuntimeContext(data.messagesSnapshot || data.messages_snapshot);
      if (snapshotRuntimeContext) {
        applyOpenClawRuntimeContext(current, snapshotRuntimeContext);
        if (snapshotUserTurn?.text) current.snapshotUserMessage ||= snapshotUserTurn.text;
      }
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

function extractOpenClawMessagesSnapshotUserTurn(messagesSnapshot) {
  if (!Array.isArray(messagesSnapshot)) return null;
  for (let index = messagesSnapshot.length - 1; index >= 0; index -= 1) {
    const message = messagesSnapshot[index];
    if ((message?.role || message?.message?.role || message?.data?.role) !== "user") continue;
    const content = message.content ?? message.message?.content ?? message.data?.content ?? message.text;
    const text = cleanOpenClawTaskText(cleanOpenClawPromptText(openClawTextFromContent(content)));
    if (!text) continue;
    const runtimeContext = extractOpenClawRuntimeContext(
      message.runtimeContext ||
      message.runtime_context ||
      message.context ||
      message.metadata ||
      content ||
      message,
    );
    return { text, runtimeContext };
  }
  return null;
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
  return extractOpenClawRuntimeContext(data.runtimeContext || data.runtime_context || data.context || data.prompt || data.messages || data.messagesSnapshot || data.messages_snapshot || event.content);
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
  return openClawTrajectoryTaskEligibility(run, taskType).create;
}

function openClawTrajectoryTaskEligibility(run, taskType = inferOpenClawTaskType(run)) {
  const runId = String(run?.runId || "");
  if (/^announce[:/-]v\d+/i.test(runId)) return { create: false, reason: "internal announce run" };
  if (/^subagent(?::|-|\/|$)/i.test(runId)) return { create: false, reason: "internal subagent run" };
  const prompt = cleanOpenClawPromptText(run?.prompt);
  const userTurnText = prompt || cleanOpenClawTaskText(run?.snapshotUserMessage || run?.snapshotUserMessageCandidate);
  if (!userTurnText) {
    return taskType === "conversation" || taskType === "scheduled"
      ? { create: false, reason: "missing task prompt" }
      : { create: false, reason: "missing prompt" };
  }
  const internalRuntimeContextText = [prompt, userTurnText].find(isOpenClawInternalRuntimeContextText);
  if (internalRuntimeContextText) {
    if (isOpenClawInternalSubagentContextText(internalRuntimeContextText)) {
      return { create: false, reason: "internal subagent run" };
    }
    return { create: false, reason: "internal system run" };
  }
  if (prompt === "HEARTBEAT_OK" || /^\[OpenClaw heartbeat poll\]/i.test(prompt)) {
    return { create: false, reason: "internal heartbeat run" };
  }
  if (/^\[[^\]]+\]\s+An async command the user already approved has completed/i.test(prompt)) {
    return { create: false, reason: "internal command completion run" };
  }
  if (/^\[[^\]]+\]\s+\[System\]/i.test(prompt)) {
    return { create: false, reason: "internal system run" };
  }
  if (/^\[announce:v\d+\]/i.test(prompt)) return { create: false, reason: "internal announce run" };
  if (/^\[subagent(?::[^\]]+)?\]/i.test(prompt)) return { create: false, reason: "internal subagent run" };
  if (taskType !== "conversation" && taskType !== "scheduled") return { create: false, reason: "unsupported OpenClaw task type" };
  return { create: true };
}

function isOpenClawInternalRuntimeContextText(value) {
  return /^(?:\[[^\]]+\]\s*)?<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i.test(String(value || ""));
}

function isOpenClawInternalSubagentContextText(value) {
  const text = String(value || "");
  return /\bsource:\s*subagent\b/i.test(text) || /\bsession_key:\s*agent:[^:\s]+:subagent:/i.test(text);
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
  const canonicalConversationId = target?.conversationId || conversationId;
  return {
    kind: "dingtalk",
    label: formatOpenClawDingTalkLabel(conversationId, target, fallbackKind),
    ...(canonicalConversationId ? { externalId: canonicalConversationId } : {}),
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
      return { ...channel, label: metadataLabel };
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
  if (session?.channelKind === "cron") {
    return undefined;
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

  const collectedAt = isoNow();
  const baseDevice = createDevice(mergedConfig, collectedAt);
  const collections = [];
  if (adapterEnabled(mergedConfig, "openclaw")) {
    collections.push(collectOpenClawDeviceState(baseDevice.id, collectedAt));
  }
  if (adapterEnabled(mergedConfig, "slock")) {
    collections.push(collectSlockDeviceState(baseDevice, collectedAt, mergedConfig));
  }
  if (adapterEnabled(mergedConfig, "codex")) {
    collections.push(collectCodexDeviceState(baseDevice.id, collectedAt));
  }
  const collected = mergeRuntimeCollections(collections);

  return {
    collectedAt,
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
    ...(collected.runtimeSkillProbes.length ? { runtimeSkillProbes: collected.runtimeSkillProbes } : {}),
    ...(collected.diagnostics.length ? { diagnostics: { items: collected.diagnostics } } : {}),
  };
}

function mergeRuntimeCollections(collections) {
  const runtimesById = new Map();
  const agentsById = new Map();
  const tasksById = new Map();
  const runtimeSkillProbesById = new Map();
  const diagnostics = [];
  for (const collection of collections) {
    for (const runtime of collection.runtimes || []) runtimesById.set(runtime.id, runtime);
    for (const agent of collection.agents || []) agentsById.set(agent.id, agent);
    for (const task of collection.tasks || []) tasksById.set(task.id, task);
    for (const probe of collection.runtimeSkillProbes || []) mergeRuntimeSkillProbe(runtimeSkillProbesById, probe);
    diagnostics.push(...(collection.diagnostics || []));
  }
  return {
    runtimes: Array.from(runtimesById.values()),
    agents: Array.from(agentsById.values()),
    tasks: Array.from(tasksById.values()).sort(compareOpenClawTasksByRecency),
    runtimeSkillProbes: Array.from(runtimeSkillProbesById.values()).sort((left, right) =>
      String(left.runtimeId).localeCompare(String(right.runtimeId)),
    ),
    diagnostics: diagnostics.sort(compareDiagnostics),
  };
}

function mergeRuntimeSkillProbe(runtimeSkillProbesById, probe) {
  const runtimeId = cleanText(probe?.runtimeId);
  if (!runtimeId) return;
  const incoming = normalizeRuntimeSkillProbeForMerge(probe);
  const existing = runtimeSkillProbesById.get(runtimeId);
  if (!existing) {
    runtimeSkillProbesById.set(runtimeId, incoming);
    return;
  }

  const rowsByKey = new Map();
  for (const row of existing.skills || []) mergeCollectedRuntimeSkillRow(rowsByKey, row);
  for (const row of incoming.skills || []) mergeCollectedRuntimeSkillRow(rowsByKey, row);
  const skills = sortRuntimeSkillRows(Array.from(rowsByKey.values()));
  const errorSummary = mergeRuntimeSkillProbeErrorSummary(existing.errorSummary, incoming.errorSummary);
  runtimeSkillProbesById.set(runtimeId, {
    ...existing,
    ...incoming,
    status: mergeRuntimeSkillProbeStatus(existing.status, incoming.status, skills),
    observedAt: latestIsoTimestamp(existing.observedAt, incoming.observedAt),
    skills,
    summary: createRuntimeSkillSummary(skills),
    ...(errorSummary ? { errorSummary } : {}),
  });
}

function normalizeRuntimeSkillProbeForMerge(probe) {
  const rowsByKey = new Map();
  for (const row of Array.isArray(probe?.skills) ? probe.skills : []) {
    mergeCollectedRuntimeSkillRow(rowsByKey, row);
  }
  const skills = sortRuntimeSkillRows(Array.from(rowsByKey.values()));
  return {
    deviceId: cleanText(probe?.deviceId),
    runtimeId: cleanText(probe?.runtimeId),
    runtimeKind: cleanText(probe?.runtimeKind),
    status: cleanText(probe?.status) || (skills.length ? "succeeded" : "unknown"),
    observedAt: cleanText(probe?.observedAt),
    skills,
    summary: createRuntimeSkillSummary(skills),
    ...(cleanText(probe?.errorSummary) ? { errorSummary: cleanText(probe.errorSummary) } : {}),
  };
}

function mergeRuntimeSkillProbeStatus(leftStatus, rightStatus, skills) {
  if (skills.length) return "succeeded";
  const statuses = new Set([leftStatus, rightStatus].map(cleanText).filter(Boolean));
  if (statuses.has("failed")) return "failed";
  if (statuses.has("unsupported")) return "unsupported";
  if (statuses.has("unknown")) return "unknown";
  return cleanText(rightStatus) || cleanText(leftStatus) || "unknown";
}

function mergeRuntimeSkillProbeErrorSummary(left, right) {
  return uniqueSorted([left, right]).join("；");
}
