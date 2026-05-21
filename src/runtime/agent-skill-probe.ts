/** Status values for read-only target-local Agent Skill probing. */
export type AgentSkillProbeStatus =
  | "unknown"
  | "succeeded"
  | "unsupported"
  | "failed";

/** File metadata displayed for a discovered Skill file. Contents are intentionally excluded. */
export interface AgentSkillProbeFileMetadata {
  name: string;
  path: string;
  relativePath: string;
  sizeBytes?: number;
  lastModifiedAt?: string;
}

/** One target-local Skill directory discovered by a probe. */
export interface AgentSkillProbeSkill {
  name: string;
  rootPath: string;
  entryPath: string;
  markdownFiles: AgentSkillProbeFileMetadata[];
  nonMarkdownFiles: AgentSkillProbeFileMetadata[];
}

/** Latest read-only Skill probe snapshot for one target Agent. */
export interface AgentSkillProbeSnapshot {
  targetAgentId: string;
  targetAgentName?: string;
  deviceId: string;
  runtimeId: string;
  runtimeName?: string;
  status: AgentSkillProbeStatus;
  observedAt?: string | null;
  probedAt?: string | null;
  skills: AgentSkillProbeSkill[];
  errorSummary?: string;
}

/** File-like input reported by a local target probe. */
export interface AgentSkillProbeEntry {
  path: string;
  kind?: "file" | "directory";
  sizeBytes?: number;
  lastModifiedAt?: string;
  modifiedAt?: string;
}

/** Input for converting raw file entries into Lorume's read-only Skill metadata. */
export interface AgentSkillProbeParseInput {
  targetAgentId: string;
  targetAgentName?: string;
  deviceId: string;
  runtimeId: string;
  runtimeName?: string;
  observedAt: string;
  probedAt?: string;
  files: AgentSkillProbeEntry[];
}

export const agentSkillProbeStatuses: AgentSkillProbeStatus[] = [
  "unknown",
  "succeeded",
  "unsupported",
  "failed",
];

/** Convert local probe file entries into Skill-root metadata without reading file contents. */
export function parseAgentSkillProbeEntries(input: AgentSkillProbeParseInput): AgentSkillProbeSnapshot {
  const files = input.files
    .filter((file) => file.kind !== "directory")
    .map(normalizeEntry)
    .filter((file): file is AgentSkillProbeFileMetadata => Boolean(file));
  const entries = files.filter((file) => file.name.toLowerCase() === "skill.md");
  const skills = entries
    .map((entry) => createSkillMetadata(entry, files))
    .sort((left, right) => {
      const nameCompare = left.name.localeCompare(right.name);
      return nameCompare === 0 ? left.rootPath.localeCompare(right.rootPath) : nameCompare;
    });

  return {
    targetAgentId: input.targetAgentId,
    ...(input.targetAgentName ? { targetAgentName: input.targetAgentName } : {}),
    deviceId: input.deviceId,
    runtimeId: input.runtimeId,
    ...(input.runtimeName ? { runtimeName: input.runtimeName } : {}),
    status: "succeeded",
    observedAt: input.observedAt,
    ...(input.probedAt ? { probedAt: input.probedAt } : {}),
    skills,
  };
}

/** Validate and normalize a probe snapshot, dropping any accidental file contents. */
export function normalizeAgentSkillProbeSnapshot(value: unknown): AgentSkillProbeSnapshot | null {
  if (!isRecord(value)) return null;
  const targetAgentId = readString(value.targetAgentId);
  const deviceId = readString(value.deviceId);
  const runtimeId = readString(value.runtimeId);
  const status = readString(value.status);
  if (!targetAgentId || !deviceId || !runtimeId || !isAgentSkillProbeStatus(status)) return null;
  const skills = Array.isArray(value.skills)
    ? value.skills.map(normalizeSkill).filter((skill): skill is AgentSkillProbeSkill => Boolean(skill))
    : [];

  return {
    targetAgentId,
    ...(readString(value.targetAgentName) ? { targetAgentName: readString(value.targetAgentName) } : {}),
    deviceId,
    runtimeId,
    ...(readString(value.runtimeName) ? { runtimeName: readString(value.runtimeName) } : {}),
    status,
    ...(readNullableString(value.observedAt) !== undefined ? { observedAt: readNullableString(value.observedAt) } : {}),
    ...(readNullableString(value.probedAt) !== undefined ? { probedAt: readNullableString(value.probedAt) } : {}),
    skills,
    ...(readString(value.errorSummary) ? { errorSummary: readString(value.errorSummary) } : {}),
  };
}

export function isAgentSkillProbeStatus(value: string): value is AgentSkillProbeStatus {
  return agentSkillProbeStatuses.includes(value as AgentSkillProbeStatus);
}

function createSkillMetadata(
  entry: AgentSkillProbeFileMetadata,
  files: AgentSkillProbeFileMetadata[],
): AgentSkillProbeSkill {
  const rootPath = dirname(entry.path);
  const groupedFiles = files
    .filter((file) => file.path === entry.path || file.path.startsWith(`${rootPath}/`))
    .map((file) => ({
      ...file,
      relativePath: file.path === rootPath ? basename(file.path) : file.path.slice(rootPath.length + 1),
    }))
    .sort((left, right) => {
      if (left.path === entry.path) return -1;
      if (right.path === entry.path) return 1;
      return left.relativePath.localeCompare(right.relativePath);
    });
  return {
    name: basename(rootPath) || "Skill",
    rootPath,
    entryPath: entry.path,
    markdownFiles: groupedFiles.filter((file) => isMarkdownPath(file.path)),
    nonMarkdownFiles: groupedFiles.filter((file) => !isMarkdownPath(file.path)),
  };
}

function normalizeSkill(value: unknown): AgentSkillProbeSkill | null {
  if (!isRecord(value)) return null;
  const name = readString(value.name);
  const rootPath = readString(value.rootPath);
  const entryPath = readString(value.entryPath);
  if (!name || !rootPath || !entryPath) return null;
  return {
    name,
    rootPath,
    entryPath,
    markdownFiles: normalizeFileList(value.markdownFiles),
    nonMarkdownFiles: normalizeFileList(value.nonMarkdownFiles),
  };
}

function normalizeFileList(value: unknown): AgentSkillProbeFileMetadata[] {
  return Array.isArray(value)
    ? value.map(normalizeFileMetadata).filter((file): file is AgentSkillProbeFileMetadata => Boolean(file))
    : [];
}

function normalizeEntry(value: AgentSkillProbeEntry): AgentSkillProbeFileMetadata | null {
  const filePath = normalizeDisplayPath(value.path);
  if (!filePath) return null;
  const lastModifiedAt = readString(value.lastModifiedAt) || readString(value.modifiedAt);
  return {
    name: basename(filePath),
    path: filePath,
    relativePath: basename(filePath),
    ...(typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes) ? { sizeBytes: value.sizeBytes } : {}),
    ...(lastModifiedAt ? { lastModifiedAt } : {}),
  };
}

function normalizeFileMetadata(value: unknown): AgentSkillProbeFileMetadata | null {
  if (!isRecord(value)) return null;
  const filePath = normalizeDisplayPath(readString(value.path));
  const relativePath = normalizeRelativePath(readString(value.relativePath));
  const name = readString(value.name) || basename(filePath || relativePath);
  if (!filePath || !relativePath || !name) return null;
  return {
    name,
    path: filePath,
    relativePath,
    ...(typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes) ? { sizeBytes: value.sizeBytes } : {}),
    ...(readString(value.lastModifiedAt) ? { lastModifiedAt: readString(value.lastModifiedAt) } : {}),
  };
}

function isMarkdownPath(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function normalizeDisplayPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function normalizeRelativePath(value: string): string {
  return normalizeDisplayPath(value).replace(/^\/+/, "");
}

function dirname(value: string): string {
  const normalized = normalizeDisplayPath(value);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

function basename(value: string): string {
  const normalized = normalizeDisplayPath(value);
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  const stringValue = readString(value);
  return stringValue ? stringValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
