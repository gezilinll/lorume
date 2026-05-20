import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeAgentSkillProbeSnapshot,
  type AgentSkillProbeSnapshot,
} from "../runtime/agent-skill-probe";
import type { RuntimeInventorySnapshot } from "../runtime";

/** Device connection state tracked by the local control plane. */
export type RuntimeDeviceConnectionStatus = "online" | "stale" | "offline";

/** Latest known connection metadata for one registered device. */
export interface RuntimeDeviceConnection {
  /** Stable Lorume device id. */
  deviceId: string;
  /** Connection status computed independently from runtime health. */
  status: RuntimeDeviceConnectionStatus;
  /** ISO timestamp when the current socket was connected. */
  connectedAt?: string;
  /** ISO timestamp for the latest heartbeat. */
  lastHeartbeatAt?: string;
  /** ISO timestamp when the socket last disconnected. */
  lastDisconnectedAt?: string;
  /** Collector version reported by the device agent. */
  collectorVersion?: string;
  /** Hostname reported by the device agent. */
  hostname?: string;
  /** Human-readable device name reported by the device agent. */
  deviceName?: string;
  /** Small load/status summary reported by heartbeat. */
  summary?: Record<string, unknown>;
  /** Latest control-plane error for this device. */
  lastError?: string;
}

/** Runtime inventory persistence options for the local Lorume backend. */
export interface RuntimeInventoryStoreOptions {
  /** Absolute or repository-relative path for the latest snapshot JSON file. */
  snapshotPath?: string;
  /** Milliseconds after which an online connection is considered stale without heartbeat. */
  staleAfterMs?: number;
}

/** Minimal persistence surface used by the dev backend and tests. */
export interface RuntimeInventoryStore {
  /** Absolute path where the latest snapshot is stored. */
  snapshotPath: string;
  /** Read the latest snapshot, or null when no device has posted yet. */
  readLatestSnapshot: () => RuntimeInventorySnapshot | null;
  /** Validate and persist the latest snapshot. */
  writeLatestSnapshot: (snapshot: unknown) => RuntimeInventorySnapshot;
  /** Read device control connection state, or null when the device has never connected. */
  readDeviceConnection: (deviceId: string, now?: Date) => RuntimeDeviceConnection | null;
  /** Upsert device control connection state. */
  writeDeviceConnection: (connection: RuntimeDeviceConnection) => RuntimeDeviceConnection;
  /** Mark a previously connected device as disconnected. */
  markDeviceDisconnected: (deviceId: string, disconnectedAt: string, reason?: string) => RuntimeDeviceConnection | null;
  /** Read the latest read-only Skill probe snapshot for one Agent. */
  readAgentSkillProbeSnapshot: (agentId: string) => AgentSkillProbeSnapshot | null;
  /** Validate and store the latest read-only Skill probe snapshot for one Agent. */
  writeAgentSkillProbeSnapshot: (snapshot: unknown) => AgentSkillProbeSnapshot;
}

const defaultSnapshotPath = path.resolve(".lorume", "runtime-inventory", "latest.json");
const defaultStaleAfterMs = 90_000;

/** Create a file-backed store for the latest runtime inventory snapshot. */
export function createRuntimeInventoryStore(
  options: RuntimeInventoryStoreOptions = {},
): RuntimeInventoryStore {
  const snapshotPath = path.resolve(
    options.snapshotPath || process.env.LORUME_RUNTIME_INVENTORY_PATH || defaultSnapshotPath,
  );
  const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
  const deviceConnections = new Map<string, RuntimeDeviceConnection>();
  const skillProbeSnapshots = new Map<string, AgentSkillProbeSnapshot>();

  return {
    snapshotPath,
    readLatestSnapshot() {
      if (!existsSync(snapshotPath)) return null;
      const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
      if (!validateRuntimeInventorySnapshot(parsed)) {
        throw new Error(`invalid runtime inventory snapshot at ${snapshotPath}`);
      }
      return parsed;
    },
    writeLatestSnapshot(snapshot) {
      if (!validateRuntimeInventorySnapshot(snapshot)) {
        throw new Error("invalid runtime inventory snapshot");
      }

      mkdirSync(path.dirname(snapshotPath), { recursive: true });
      const tempPath = `${snapshotPath}.${process.pid}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      renameSync(tempPath, snapshotPath);
      return snapshot;
    },
    readDeviceConnection(deviceId, now = new Date()) {
      const connection = deviceConnections.get(deviceId);
      if (!connection) return null;
      return applyConnectionFreshness(connection, now, staleAfterMs);
    },
    writeDeviceConnection(connection) {
      const nextConnection = { ...connection };
      deviceConnections.set(connection.deviceId, nextConnection);
      return { ...nextConnection };
    },
    markDeviceDisconnected(deviceId, disconnectedAt, reason) {
      const current = deviceConnections.get(deviceId);
      if (!current) return null;
      const nextConnection = {
        ...current,
        status: "offline" as const,
        lastDisconnectedAt: disconnectedAt,
        ...(reason ? { lastError: reason } : {}),
      };
      deviceConnections.set(deviceId, nextConnection);
      return { ...nextConnection };
    },
    readAgentSkillProbeSnapshot(agentId) {
      const snapshot = skillProbeSnapshots.get(agentId);
      return snapshot ? cloneJson(snapshot) : null;
    },
    writeAgentSkillProbeSnapshot(snapshot) {
      const normalized = normalizeAgentSkillProbeSnapshot(snapshot);
      if (!normalized) throw new Error("invalid agent skill probe snapshot");
      skillProbeSnapshots.set(normalized.targetAgentId, cloneJson(normalized));
      return cloneJson(normalized);
    },
  };
}

/** Validate the small contract Lorume needs before accepting a collector snapshot. */
export function validateRuntimeInventorySnapshot(value: unknown): value is RuntimeInventorySnapshot {
  if (!isRecord(value)) return false;
  if (typeof value.observedAt !== "string") return false;
  if (!isRecord(value.collector) || typeof value.collector.version !== "string") return false;
  if (!isRecord(value.device) || typeof value.device.id !== "string" || typeof value.device.name !== "string") {
    return false;
  }
  if (
    !Array.isArray(value.runtimes) ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.reports)
  ) {
    return false;
  }

  return value.runtimes.every(isRuntimeLike) && value.agents.every(isAgentLike);
}

function isRuntimeLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.deviceId === "string" &&
    typeof value.kind === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.capabilities) &&
    Array.isArray(value.sourceRefs)
  );
}

function isAgentLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runtimeId === "string" &&
    typeof value.name === "string" &&
    typeof value.origin === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.channelBindings) &&
    Array.isArray(value.sourceRefs)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyConnectionFreshness(
  connection: RuntimeDeviceConnection,
  now: Date,
  staleAfterMs: number,
): RuntimeDeviceConnection {
  if (connection.status !== "online") return { ...connection };
  const latestSeenAt = connection.lastHeartbeatAt ?? connection.connectedAt;
  if (!latestSeenAt) return { ...connection };
  const latestSeenTime = Date.parse(latestSeenAt);
  if (!Number.isFinite(latestSeenTime)) return { ...connection };
  if (now.getTime() - latestSeenTime <= staleAfterMs) return { ...connection };
  return { ...connection, status: "stale" };
}
