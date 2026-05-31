#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { hostname, arch, platform, userInfo, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDeviceStateSnapshot } from "./lorume-runtime-adapters.mjs";
import { normalizeLocalIpsForDisplay } from "./local-ip-normalization.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseFlags(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "json" || key === "help") {
      flags.set(key, true);
      continue;
    }
    index += 1;
    if (index >= argv.length) throw createCliError("missing_argument", `Missing value for --${key}`, 2);
    const value = argv[index];
    if (key === "allow-root" || key === "skill-root") {
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else {
      flags.set(key, value);
    }
  }
  return { flags, positionals };
}

async function main() {
  const { flags, positionals } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || positionals.length === 0) {
    process.stdout.write(helpText());
    return;
  }

  const [group, command] = positionals;
  if (group === "device" && command === "identify") {
    writeJson(identifyDevice(flags));
    return;
  }
  if (group === "runtime" && command === "list") {
    writeJson(listRuntimes(flags));
    return;
  }
  if (group === "collect" && command === "device-state") {
    writeJson(await collectDeviceState(flags));
    return;
  }
  if (group === "agent" && command === "skill-probe") {
    writeJson(probeAgentSkills(flags));
    return;
  }
  if (group === "connector" && command === "status") {
    writeJson(readConnectorStatus(flags));
    return;
  }
  if (group === "collector" && (command === "stop" || command === "uninstall")) {
    writeJson(runCollectorLifecycleCommand(command, flags));
    return;
  }
  if (group === "files" && command === "copy") {
    writeJson(copyExplicitPath(flags));
    return;
  }

  throw createCliError("unsupported_command", `Unsupported lorume command: ${positionals.join(" ")}`, 2);
}

function identifyDevice(flags) {
  const collectedAt = new Date().toISOString();
  const deviceId = stringFlag(flags, "device-id") || process.env.LORUME_DEVICE_ID || sanitizeId(hostname());
  const localIps = collectLocalIps();
  return {
    command: "device.identify",
    collectedAt,
    device: {
      architecture: arch(),
      hostname: hostname(),
      id: deviceId,
      lastSeenAt: collectedAt,
      ...(localIps.length ? { network: { localIps } } : {}),
      user: { username: safeUsername() },
      os: platform(),
    },
  };
}

function listRuntimes(flags) {
  const snapshotPath = requireFlag(flags, "snapshot");
  const snapshot = readDeviceStateSnapshot(snapshotPath);
  return {
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
    command: "runtime.list",
    collectedAt: typeof snapshot.collectedAt === "string" ? snapshot.collectedAt : null,
    device: snapshot.device ?? null,
    runtimes: Array.isArray(snapshot.runtimes) ? snapshot.runtimes : [],
  };
}

async function collectDeviceState(flags) {
  const snapshotPath = stringFlag(flags, "snapshot");
  if (snapshotPath) {
    const snapshot = applyDeviceStateDeviceOverrides(readDeviceStateSnapshot(snapshotPath), flags);
    return {
      ...snapshot,
      command: "collect.device-state",
    };
  }
  return {
    ...collectDeviceStateSnapshot(readCollectorConfig(flags), collectorAdapterArgs(flags)),
    command: "collect.device-state",
  };
}

function probeAgentSkills(flags) {
  const targetAgentId = requireFlag(flags, "agent-id");
  const identity = identifyDevice(flags);
  const runtimeId = stringFlag(flags, "runtime-id") || "unknown-runtime";
  const observedAt = new Date().toISOString();
  const skillRoots = flags.get("skill-root") ?? [];
  const files = skillRoots.flatMap(readSkillRootEntries);
  const skills = createSkillMetadata(files);
  const status = skillRoots.length === 0 ? "unsupported" : "succeeded";
  return {
    command: "agent.skill-probe",
    targetAgentId,
    ...(stringFlag(flags, "agent-name") ? { targetAgentName: stringFlag(flags, "agent-name") } : {}),
    deviceId: identity.device.id,
    runtimeId,
    ...(stringFlag(flags, "runtime-name") ? { runtimeName: stringFlag(flags, "runtime-name") } : {}),
    status,
    observedAt,
    probedAt: observedAt,
    skills,
    ...(status === "unsupported" ? { errorSummary: "未提供可探测的本地 Skill 目录。" } : {}),
  };
}

function readConnectorStatus(flags) {
  const contextPath = requireFlag(flags, "context");
  const target = requireFlag(flags, "target");
  const context = readJson(contextPath);
  const connectors = Array.isArray(context.connectors) ? context.connectors : [];
  const connector = connectors.find((candidate) => candidate && candidate.id === target);
  if (!connector) {
    throw createCliError("not_found", `Connector is not present in authorized context: ${target}`, 3);
  }
  return {
    command: "connector.status",
    connector,
  };
}

function runCollectorLifecycleCommand(command, flags) {
  const installDir = stringFlag(flags, "install-dir");
  const installerPath = process.env.LORUME_COLLECTOR_INSTALLER_PATH || path.join(SCRIPT_DIR, "install-device-collector.sh");
  const installerArgs = [];
  if (installDir) installerArgs.push("--install-dir", installDir);
  installerArgs.push(command === "stop" ? "--stop" : "--uninstall");
  const result = spawnSync("bash", [installerPath, ...installerArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw createCliError(
      "collector_lifecycle_failed",
      result.stderr.trim() || `Collector ${command} failed with exit code ${result.status}`,
      result.status || 1,
    );
  }
  return {
    command: `collector.${command}`,
    ...(installDir ? { installDir } : {}),
    status: "succeeded",
  };
}

function readDeviceStateSnapshot(snapshotPath) {
  const snapshot = readJson(snapshotPath);
  if (!snapshot || typeof snapshot !== "object") {
    throw createCliError("invalid_snapshot", "Device-state snapshot must be a JSON object", 2);
  }
  const device = snapshot.device ?? (Array.isArray(snapshot.devices) ? snapshot.devices[0] : null);
  return {
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
    collectedAt: typeof snapshot.collectedAt === "string" ? snapshot.collectedAt : new Date().toISOString(),
    device,
    diagnostics: snapshot.diagnostics && typeof snapshot.diagnostics === "object" ? snapshot.diagnostics : undefined,
    runtimes: Array.isArray(snapshot.runtimes) ? snapshot.runtimes : [],
    runtimeSkillProbes: Array.isArray(snapshot.runtimeSkillProbes) ? snapshot.runtimeSkillProbes : [],
    runtimeScheduleProbes: Array.isArray(snapshot.runtimeScheduleProbes) ? snapshot.runtimeScheduleProbes : [],
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : [],
  };
}

function applyDeviceStateDeviceOverrides(snapshot, flags) {
  const deviceId = stringFlag(flags, "device-id");
  if (!deviceId) return snapshot;
  const currentDeviceId = snapshot.device?.id;
  const nextDevice = {
    ...snapshot.device,
    id: deviceId,
  };
  if (!currentDeviceId || !deviceId || currentDeviceId === deviceId) return { ...snapshot, device: nextDevice };
  const runtimeIdReplacements = new Map();
  const runtimes = snapshot.runtimes.map((runtime) => {
    const nextRuntime = {
      ...runtime,
      id: String(runtime.id).replace(`${currentDeviceId}:`, `${deviceId}:`),
      deviceId,
    };
    runtimeIdReplacements.set(runtime.id, nextRuntime.id);
    return nextRuntime;
  });
  const agents = snapshot.agents.map((agent) => {
    const runtimeId = runtimeIdReplacements.get(agent.runtimeId) || String(agent.runtimeId).replace(`${currentDeviceId}:`, `${deviceId}:`);
    return {
      ...agent,
      id: String(agent.id).replace(`${currentDeviceId}:`, `${deviceId}:`),
      runtimeId,
    };
  });
  const agentIdReplacements = new Map(snapshot.agents.map((agent, index) => [agent.id, agents[index]?.id ?? agent.id]));
  const tasks = snapshot.tasks.map((task) => ({
    ...task,
    id: String(task.id).replace(`${currentDeviceId}:`, `${deviceId}:`),
    agentId: agentIdReplacements.get(task.agentId) || String(task.agentId).replace(`${currentDeviceId}:`, `${deviceId}:`),
  }));
  const runtimeSkillProbes = (snapshot.runtimeSkillProbes || []).map((probe) => ({
    ...probe,
    deviceId: String(probe.deviceId || currentDeviceId).replace(currentDeviceId, deviceId),
    runtimeId: runtimeIdReplacements.get(probe.runtimeId) || String(probe.runtimeId).replace(`${currentDeviceId}:`, `${deviceId}:`),
    skills: Array.isArray(probe.skills)
      ? probe.skills.map((skill) => ({
        ...skill,
        agentIds: Array.isArray(skill.agentIds)
          ? skill.agentIds.map((agentId) => String(agentId).replace(`${currentDeviceId}:`, `${deviceId}:`))
          : [],
      }))
      : [],
  }));
  const runtimeScheduleProbes = (snapshot.runtimeScheduleProbes || []).map((probe) => ({
    ...probe,
    deviceId: String(probe.deviceId || currentDeviceId).replace(currentDeviceId, deviceId),
    runtimeId: runtimeIdReplacements.get(probe.runtimeId) || String(probe.runtimeId).replace(`${currentDeviceId}:`, `${deviceId}:`),
    schedules: Array.isArray(probe.schedules)
      ? probe.schedules.map((schedule) => ({
        ...schedule,
        key: String(schedule.key || "").replace(`${currentDeviceId}:`, `${deviceId}:`),
        agentIds: Array.isArray(schedule.agentIds)
          ? schedule.agentIds.map((agentId) => String(agentId).replace(`${currentDeviceId}:`, `${deviceId}:`))
          : [],
      }))
      : [],
  }));
  return {
    ...snapshot,
    device: nextDevice,
    runtimes,
    agents,
    tasks,
    ...(runtimeSkillProbes.length ? { runtimeSkillProbes } : {}),
    ...(runtimeScheduleProbes.length ? { runtimeScheduleProbes } : {}),
  };
}

function copyExplicitPath(flags) {
  const from = requireFlag(flags, "from");
  const to = requireFlag(flags, "to");
  const allowRoots = flags.get("allow-root") ?? [];
  if (allowRoots.length === 0) {
    throw createCliError("missing_allow_root", "files copy requires at least one --allow-root", 2);
  }
  const resolvedRoots = allowRoots.map((root) => path.resolve(root));
  const sourcePath = path.resolve(from);
  const destinationPath = path.resolve(to);
  if (!isAllowedPath(sourcePath, resolvedRoots) || !isAllowedPath(destinationPath, resolvedRoots)) {
    throw createCliError("unsafe_path", "Source and destination must stay inside allowed roots", 2);
  }
  if (!existsSync(sourcePath)) {
    throw createCliError("not_found", `Source path does not exist: ${sourcePath}`, 3);
  }
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath, { recursive: statSync(sourcePath).isDirectory() });
  return {
    command: "files.copy",
    destinationPath,
    sourcePath,
    status: "copied",
  };
}

function isAllowedPath(candidate, roots) {
  return roots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw createCliError("invalid_json", error instanceof Error ? error.message : "Invalid JSON", 2);
  }
}

function readCollectorConfig(flags) {
  const configPath = stringFlag(flags, "config");
  if (!configPath) return {};
  if (!existsSync(configPath)) return {};
  return readJson(configPath);
}

function collectorAdapterArgs(flags) {
  return {
    configPath: stringFlag(flags, "config"),
    deviceId: stringFlag(flags, "device-id"),
    fixturePath: stringFlag(flags, "snapshot"),
  };
}

function requireFlag(flags, key) {
  const value = stringFlag(flags, key);
  if (!value) throw createCliError("missing_argument", `Missing --${key}`, 2);
  return value;
}

function stringFlag(flags, key) {
  const value = flags.get(key);
  return typeof value === "string" ? value : "";
}

function readSkillRootEntries(root) {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot)) {
    throw createCliError("not_found", `Skill root does not exist: ${resolvedRoot}`, 3);
  }
  if (!statSync(resolvedRoot).isDirectory()) {
    throw createCliError("invalid_skill_root", `Skill root must be a directory: ${resolvedRoot}`, 2);
  }
  return readDirectoryEntries(resolvedRoot, resolvedRoot);
}

function readDirectoryEntries(currentPath, rootPath) {
  return readdirSync(currentPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) return readDirectoryEntries(entryPath, rootPath);
    if (!entry.isFile()) return [];
    const stats = statSync(entryPath);
    return [{
      lastModifiedAt: stats.mtime.toISOString(),
      name: entry.name,
      path: entryPath,
      relativePath: normalizeRelativePath(path.relative(rootPath, entryPath)),
      sizeBytes: stats.size,
    }];
  });
}

function createSkillMetadata(files) {
  const entries = files.filter((file) => file.name.toLowerCase() === "skill.md");
  return entries.map((entry) => {
    const rootPath = path.dirname(entry.path);
    const groupedFiles = files
      .filter((file) => file.path === entry.path || file.path.startsWith(`${rootPath}${path.sep}`))
      .map((file) => ({
        ...file,
        relativePath: normalizeRelativePath(path.relative(rootPath, file.path)),
      }))
      .sort((left, right) => {
        if (left.path === entry.path) return -1;
        if (right.path === entry.path) return 1;
        return left.relativePath.localeCompare(right.relativePath);
      });
    return {
      name: path.basename(rootPath) || "Skill",
      rootPath,
      entryPath: entry.path,
      markdownFiles: groupedFiles.filter((file) => isMarkdownPath(file.path)),
      nonMarkdownFiles: groupedFiles.filter((file) => !isMarkdownPath(file.path)),
    };
  });
}

function isMarkdownPath(value) {
  const lower = value.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
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

function sanitizeId(value) {
  return String(value || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function createCliError(code, message, exitCode) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  return error;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(error) {
  const code = typeof error.code === "string" ? error.code : "cli_error";
  const message = error instanceof Error && error.message ? error.message : "Lorume CLI failed";
  process.stderr.write(`${JSON.stringify({ code, error: code, message })}\n`);
  process.exitCode = typeof error.exitCode === "number" ? error.exitCode : 1;
}

function helpText() {
  return `Usage: lorume <command> [options]

Commands:
  lorume device identify --json [--device-id <id>]
  lorume collect device-state --json [--snapshot <path>]
  lorume agent skill-probe --json --agent-id <id> [--runtime-id <id>] [--device-id <id>] [--skill-root <path>]
  lorume collector stop --json [--install-dir <path>]
  lorume collector uninstall --json [--install-dir <path>]
  lorume runtime list --json --snapshot <path>
  lorume connector status --json --context <path> --target <id>
  lorume files copy --json --from <path> --to <path> --allow-root <path>
`;
}

try {
  await main();
} catch (error) {
  writeError(error);
}
