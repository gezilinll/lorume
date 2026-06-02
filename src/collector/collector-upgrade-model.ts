export const collectorUpgradeStages = [
  "queued",
  "dispatched",
  "acknowledged",
  "downloading",
  "verifying",
  "installing",
  "restart_pending",
  "reconnected",
  "succeeded",
  "failed",
  "rolled_back",
] as const;

export type CollectorUpgradeStage = typeof collectorUpgradeStages[number];
export type CollectorUpgradeStatus = "running" | "succeeded" | "failed" | "requires_manual_step";

export interface CollectorPackageManifest {
  readonly schemaVersion: "collector-package-v1";
  readonly version: string;
  readonly createdAt: string;
  readonly minUpgradeProtocolVersion: number;
  readonly files: readonly CollectorPackageManifestFile[];
}

export interface CollectorPackageManifestFile {
  readonly fileName: CollectorPackageFileName;
  readonly path: CollectorPackageFileName;
  readonly mode: "0755" | "0644";
  readonly sha256: string;
  readonly bytes: number;
}

export interface CollectorUpgradeProgressPayload {
  readonly operationId: string;
  readonly jobId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly stage: CollectorUpgradeStage;
  readonly status: CollectorUpgradeStatus;
  readonly collectorVersion?: string;
  readonly targetVersion?: string;
  readonly message?: string;
  readonly errorCode?: string;
  readonly observedAt?: string;
}

export interface CollectorUpgradeRequestPayload {
  readonly operationId: string;
  readonly jobId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly targetVersion: string;
  readonly manifestUrl: string;
  readonly requestedAt: string;
}

export const collectorPackageFileNames = [
  "lorume-device-collector.mjs",
  "lorume-runtime-adapters.mjs",
  "local-ip-normalization.mjs",
  "lorume.mjs",
] as const;

export type CollectorPackageFileName = typeof collectorPackageFileNames[number];

const collectorPackageFileNameSet = new Set<string>(collectorPackageFileNames);
const collectorUpgradeStageSet = new Set<string>(collectorUpgradeStages);
const secretKeyPattern = /token|secret|authorization|password|credential|apiKey/i;

export function isAllowedCollectorPackageFile(fileName: string): fileName is CollectorPackageFileName {
  return collectorPackageFileNameSet.has(fileName);
}

export function isCollectorUpgradeStage(stage: string): stage is CollectorUpgradeStage {
  return collectorUpgradeStageSet.has(stage);
}

export function normalizeCollectorPackageManifest(input: unknown): CollectorPackageManifest | null {
  if (!isRecord(input)) return null;
  if (input.schemaVersion !== "collector-package-v1") return null;
  if (typeof input.version !== "string" || input.version.trim() === "") return null;
  if (typeof input.createdAt !== "string" || Number.isNaN(Date.parse(input.createdAt))) return null;
  const minUpgradeProtocolVersion = input.minUpgradeProtocolVersion;
  if (typeof minUpgradeProtocolVersion !== "number" || !Number.isInteger(minUpgradeProtocolVersion) || minUpgradeProtocolVersion < 1) {
    return null;
  }
  if (!Array.isArray(input.files) || input.files.length === 0) return null;

  const files: CollectorPackageManifestFile[] = [];
  const seenFileNames = new Set<string>();
  for (const file of input.files) {
    const normalizedFile = normalizeManifestFile(file);
    if (!normalizedFile || seenFileNames.has(normalizedFile.fileName)) return null;
    seenFileNames.add(normalizedFile.fileName);
    files.push(normalizedFile);
  }

  return {
    schemaVersion: "collector-package-v1",
    version: input.version,
    createdAt: input.createdAt,
    minUpgradeProtocolVersion,
    files,
  };
}

export function compareCollectorVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const partCount = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < partCount; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

export function redactCollectorUpgradeMessage<T>(input: T): T {
  return redactValue(input) as T;
}

function normalizeManifestFile(input: unknown): CollectorPackageManifestFile | null {
  if (!isRecord(input)) return null;
  if (typeof input.fileName !== "string" || typeof input.path !== "string") return null;
  if (!isAllowedCollectorPackageFile(input.fileName)) return null;
  if (input.path !== input.fileName) return null;
  if (input.mode !== "0755" && input.mode !== "0644") return null;
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) return null;
  const bytes = input.bytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) return null;

  return {
    fileName: input.fileName,
    path: input.path,
    mode: input.mode,
    sha256: input.sha256.toLowerCase(),
    bytes,
  };
}

function parseVersionParts(version: string): number[] {
  const numericPrefix = version.trim().split(/[+-]/, 1)[0] ?? "";
  return numericPrefix.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = secretKeyPattern.test(key) ? "[redacted]" : redactValue(item);
  }
  return redacted;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
