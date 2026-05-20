#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { hostname, arch, platform, userInfo, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR_SCRIPT = path.join(SCRIPT_DIR, "lorume-device-collector.mjs");

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

function main() {
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
  if (group === "collect" && command === "inventory") {
    writeJson(collectInventory(flags));
    return;
  }
  if (group === "collect" && command === "work-state") {
    writeJson(collectWorkState(flags));
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
  if (group === "files" && command === "copy") {
    writeJson(copyExplicitPath(flags));
    return;
  }

  throw createCliError("unsupported_command", `Unsupported lorume command: ${positionals.join(" ")}`, 2);
}

function identifyDevice(flags) {
  const observedAt = new Date().toISOString();
  const deviceId = stringFlag(flags, "device-id") || process.env.LORUME_DEVICE_ID || sanitizeId(hostname());
  const deviceName = stringFlag(flags, "device-name") || process.env.LORUME_DEVICE_NAME || deviceId;
  const localIps = collectLocalIps();
  return {
    command: "device.identify",
    observedAt,
    device: {
      architecture: arch(),
      connectionMode: "collector",
      hostname: hostname(),
      id: deviceId,
      name: deviceName,
      ...(localIps.length ? { network: { localIps } } : {}),
      user: { username: safeUsername() },
      os: platform(),
    },
  };
}

function listRuntimes(flags) {
  const snapshotPath = requireFlag(flags, "snapshot");
  const snapshot = readJson(snapshotPath);
  if (!snapshot || typeof snapshot !== "object") {
    throw createCliError("invalid_snapshot", "Runtime snapshot must be a JSON object", 2);
  }
  return {
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
    command: "runtime.list",
    device: snapshot.device ?? null,
    observedAt: typeof snapshot.observedAt === "string" ? snapshot.observedAt : null,
    runtimes: Array.isArray(snapshot.runtimes) ? snapshot.runtimes : [],
  };
}

function collectInventory(flags) {
  const snapshotPath = stringFlag(flags, "snapshot");
  if (snapshotPath) {
    const snapshot = applyInventoryDeviceOverrides(readRuntimeInventorySnapshot(snapshotPath), flags);
    return {
      ...snapshot,
      command: "collect.inventory",
    };
  }
  if (process.env.LORUME_CLI_USE_COLLECTOR_ADAPTERS === "1") {
    return { ...runInternalCollectorJson(["--once", "--print-only"], flags), command: "collect.inventory" };
  }
  const identity = identifyDevice(flags);
  return {
    agents: [],
    collector: { version: "0.1.0", status: "online" },
    command: "collect.inventory",
    device: { ...identity.device, status: "unknown" },
    observedAt: identity.observedAt,
    reports: [],
    runtimes: [],
  };
}

function collectWorkState(flags) {
  const snapshotPath = stringFlag(flags, "snapshot");
  if (snapshotPath) {
    const snapshot = readJson(snapshotPath);
    if (!snapshot || typeof snapshot !== "object") {
      throw createCliError("invalid_snapshot", "Work-state snapshot must be a JSON object", 2);
    }
    return { ...snapshot, command: "collect.work-state" };
  }
  if (process.env.LORUME_CLI_USE_COLLECTOR_ADAPTERS === "1") {
    return { ...runInternalCollectorJson(["--work-state-once", "--print-only"], flags), command: "collect.work-state" };
  }
  const identity = identifyDevice(flags);
  return {
    command: "collect.work-state",
    observedAt: identity.observedAt,
    deviceId: identity.device.id,
    workItems: [],
    conversations: [],
    executions: [],
    capabilities: [],
  };
}

function runInternalCollectorJson(baseArgs, flags) {
  const collectorArgs = [...baseArgs];
  if (stringFlag(flags, "config")) collectorArgs.push("--config", stringFlag(flags, "config"));
  if (stringFlag(flags, "device-id")) collectorArgs.push("--device-id", stringFlag(flags, "device-id"));
  if (stringFlag(flags, "device-name")) collectorArgs.push("--device-name", stringFlag(flags, "device-name"));
  const result = spawnSync(process.execPath, [COLLECTOR_SCRIPT, ...collectorArgs], {
    encoding: "utf8",
    env: { ...process.env, LORUME_COLLECTOR_INTERNAL_LEGACY: "1" },
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw createCliError("collector_adapter_failed", result.stderr.trim() || "Collector adapter failed", 1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw createCliError("invalid_json", "Collector adapter returned non-JSON output", 1);
  }
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
    ...(identity.device.name ? { deviceName: identity.device.name } : {}),
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

function readRuntimeInventorySnapshot(snapshotPath) {
  const snapshot = readJson(snapshotPath);
  if (!snapshot || typeof snapshot !== "object") {
    throw createCliError("invalid_snapshot", "Runtime snapshot must be a JSON object", 2);
  }
  return {
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
    collector: snapshot.collector && typeof snapshot.collector === "object" ? snapshot.collector : { status: "unknown" },
    device: snapshot.device ?? null,
    observedAt: typeof snapshot.observedAt === "string" ? snapshot.observedAt : new Date().toISOString(),
    reports: Array.isArray(snapshot.reports) ? snapshot.reports : [],
    runtimes: Array.isArray(snapshot.runtimes) ? snapshot.runtimes : [],
  };
}

function applyInventoryDeviceOverrides(snapshot, flags) {
  const deviceId = stringFlag(flags, "device-id");
  const deviceName = stringFlag(flags, "device-name");
  if (!deviceId && !deviceName) return snapshot;
  const currentDeviceId = snapshot.device?.id;
  const nextDevice = {
    ...snapshot.device,
    ...(deviceId ? { id: deviceId } : {}),
    ...(deviceName ? { name: deviceName } : {}),
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
  return { ...snapshot, device: nextDevice, runtimes, agents };
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
  const values = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.address) values.push(entry.address);
    }
  }
  return Array.from(new Set(values)).sort();
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
  lorume device identify --json [--device-id <id>] [--device-name <name>]
  lorume collect inventory --json [--snapshot <path>]
  lorume collect work-state --json [--snapshot <path>]
  lorume agent skill-probe --json --agent-id <id> [--runtime-id <id>] [--device-id <id>] [--skill-root <path>]
  lorume runtime list --json --snapshot <path>
  lorume connector status --json --context <path> --target <id>
  lorume files copy --json --from <path> --to <path> --allow-root <path>
`;
}

try {
  main();
} catch (error) {
  writeError(error);
}
