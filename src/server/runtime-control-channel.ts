import {
  collectorUpgradeStages,
  type CollectorUpgradeProgressPayload,
  type CollectorUpgradeStage,
  type CollectorUpgradeStatus,
} from "../collector/collector-upgrade-model";
import type {
  RuntimeAgentAnalysisCapability,
  RuntimeCollectorUpgradeCapability,
  RuntimeDeviceStateStore,
} from "./runtime-device-state-store";

/** Minimal socket interface shared by tests and the Vite WebSocket adapter. */
export interface RuntimeControlSocket {
  /** Send a serialized JSON control message. */
  send: (data: string) => void;
}

/** Runtime control channel construction options. */
export interface RuntimeControlChannelOptions {
  /** Store used for connection state. */
  store: RuntimeDeviceStateStore;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
  /** Callback invoked after a collector upgrade progress message passes validation. */
  onCollectorUpgradeProgress?: (message: CollectorUpgradeProgressMessage) => void | Promise<void>;
  /** Callback invoked after an Agent analysis progress message passes validation. */
  onAgentAnalysisProgress?: (message: AgentAnalysisProgressMessage) => void | Promise<void>;
  /** Callback invoked after an Agent analysis result message passes validation. */
  onAgentAnalysisResult?: (message: AgentAnalysisResultMessage) => void | Promise<void>;
}

/** Runtime control channel API used by the dev backend. */
export interface RuntimeControlChannel {
  /** Attach a socket before it sends hello. */
  attach: (socket: RuntimeControlSocket) => void;
  /** Detach a socket and mark its device offline when registered. */
  detach: (socket: RuntimeControlSocket, reason?: string) => void;
  /** Receive one serialized JSON message from a socket. */
  receive: (socket: RuntimeControlSocket, rawMessage: string) => void;
  /** Send the only supported server-to-device upgrade control message. */
  sendCollectorUpgradeRequest: (message: CollectorUpgradeRequestMessage) => boolean;
  /** Send a restricted server-to-device Agent analysis request. */
  sendAgentAnalysisRequest: (message: AgentAnalysisRequestMessage) => boolean;
  /** Return whether the channel currently has a live socket for a device. */
  isDeviceConnected: (deviceId: string) => boolean;
}

export interface CollectorUpgradeRequestMessage {
  readonly protocolVersion: 1;
  readonly operationId: string;
  readonly jobId: string;
  readonly deviceId: string;
  readonly currentVersion?: string;
  readonly targetVersion: string;
  readonly manifestUrl: string;
  readonly packageBaseUrl: string;
  readonly deadlineAt: string;
  readonly nonce: string;
}

export type CollectorUpgradeProgressMessage = CollectorUpgradeProgressPayload & {
  readonly protocolVersion: 1;
  readonly currentVersion?: string;
};

export interface AgentAnalysisRequestMessage {
  readonly type?: "agent.analysis.request";
  readonly protocolVersion: 1;
  readonly operationId: string;
  readonly jobId: string;
  readonly deviceId: string;
  readonly runtimeId: string;
  readonly agentId: string;
  readonly openclawAgentId: "main";
  readonly promptKind: "daily_operation_review";
  readonly promptVersion: "openclaw-agent-analysis-v1";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly prompt: string;
  readonly deadlineAt: string;
  readonly timeoutSeconds: number;
  readonly nonce: string;
}

export interface AgentAnalysisProgressMessage {
  readonly protocolVersion: 1;
  readonly operationId: string;
  readonly jobId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly stage: "accepted" | "executing" | "result_received" | "failed";
  readonly status: "running" | "failed";
  readonly message?: string;
  readonly observedAt?: string;
}

export interface AgentAnalysisResultMessage {
  readonly protocolVersion: 1;
  readonly operationId: string;
  readonly jobId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly status: "succeeded" | "failed" | "unsupported";
  readonly runtimeRunId?: string;
  readonly durationMs?: number;
  readonly modelMetadata?: Record<string, unknown>;
  readonly analysis?: unknown;
  readonly errorCode?: string;
  readonly message?: string;
  readonly observedAt?: string;
}

type ControlMessage = {
  type?: string;
  deviceId?: string;
  collectorVersion?: string;
  hostname?: string;
  upgrade?: unknown;
  analysis?: unknown;
  summary?: Record<string, unknown>;
  error?: string;
  protocolVersion?: unknown;
  operationId?: unknown;
  jobId?: unknown;
  nonce?: unknown;
  stage?: unknown;
  status?: unknown;
  currentVersion?: unknown;
  targetVersion?: unknown;
  runtimeRunId?: unknown;
  durationMs?: unknown;
  modelMetadata?: unknown;
  message?: unknown;
  errorCode?: unknown;
  observedAt?: unknown;
};

const collectorUpgradeStageSet = new Set<string>(collectorUpgradeStages);

/** Create the in-memory Runtime Fleet device control channel. */
export function createRuntimeControlChannel(options: RuntimeControlChannelOptions): RuntimeControlChannel {
  const now = options.now ?? (() => new Date());
  const socketDeviceIds = new WeakMap<RuntimeControlSocket, string>();
  const socketsByDeviceId = new Map<string, RuntimeControlSocket>();

  function send(socket: RuntimeControlSocket, message: Record<string, unknown>): void {
    socket.send(JSON.stringify({ sentAt: now().toISOString(), ...message }));
  }

  return {
    attach() {
      // The socket becomes addressable after it sends hello with a device id.
    },
    detach(socket, reason = "socket disconnected") {
      const deviceId = socketDeviceIds.get(socket);
      if (!deviceId) return;
      socketDeviceIds.delete(socket);
      if (socketsByDeviceId.get(deviceId) === socket) socketsByDeviceId.delete(deviceId);
      options.store.markDeviceDisconnected(deviceId, now().toISOString(), reason);
    },
    receive(socket, rawMessage) {
      const message = parseControlMessage(rawMessage);
      if (message.type === "hello") {
        const deviceId = requireDeviceId(message);
        socketDeviceIds.set(socket, deviceId);
        socketsByDeviceId.set(deviceId, socket);
        options.store.writeDeviceConnection({
          deviceId,
          status: "online",
          connectedAt: now().toISOString(),
          lastHeartbeatAt: now().toISOString(),
          collectorVersion: message.collectorVersion,
          hostname: message.hostname,
          collectorUpgrade: normalizeCollectorUpgradeCapability(message.upgrade),
          agentAnalysis: normalizeAgentAnalysisCapability(message.analysis),
        });
        send(socket, { type: "hello.ack", deviceId });
        return;
      }

      if (message.type === "collector.upgrade.progress") {
        const progress = normalizeCollectorUpgradeProgress(message, socketDeviceIds.get(socket));
        if (!progress) {
          send(socket, { type: "error", error: "invalid collector upgrade progress" });
          return;
        }
        void options.onCollectorUpgradeProgress?.(progress);
        return;
      }

      if (message.type === "agent.analysis.progress") {
        const progress = normalizeAgentAnalysisProgress(message, socketDeviceIds.get(socket));
        if (!progress) {
          send(socket, { type: "error", error: "invalid agent analysis progress" });
          return;
        }
        void options.onAgentAnalysisProgress?.(progress);
        return;
      }

      if (message.type === "agent.analysis.result") {
        const result = normalizeAgentAnalysisResult(message, socketDeviceIds.get(socket));
        if (!result) {
          send(socket, { type: "error", error: "invalid agent analysis result" });
          return;
        }
        void options.onAgentAnalysisResult?.(result);
        return;
      }

      if (message.type === "heartbeat") {
        const deviceId = requireDeviceId(message, socketDeviceIds.get(socket));
        const current = options.store.readDeviceConnection(deviceId) ?? {
          deviceId,
          status: "online" as const,
        };
        options.store.writeDeviceConnection({
          ...current,
          deviceId,
          status: "online",
          lastHeartbeatAt: now().toISOString(),
          collectorVersion: message.collectorVersion ?? current.collectorVersion,
          hostname: message.hostname ?? current.hostname,
          collectorUpgrade: normalizeCollectorUpgradeCapability(message.upgrade) ?? current.collectorUpgrade,
          agentAnalysis: normalizeAgentAnalysisCapability(message.analysis) ?? current.agentAnalysis,
          summary: message.summary ?? current.summary,
          lastError: message.error || undefined,
        });
        return;
      }

      send(socket, { type: "error", error: `unsupported message type: ${message.type ?? "unknown"}` });
    },
    sendCollectorUpgradeRequest(message) {
      const socket = socketsByDeviceId.get(message.deviceId);
      if (!socket) return false;
      const connection = options.store.readDeviceConnection(message.deviceId, now());
      if (!connection?.collectorUpgrade?.supported) return false;
      if (connection.collectorUpgrade.protocolVersion < message.protocolVersion) return false;
      send(socket, {
        type: "collector.upgrade.request",
        ...message,
      });
      return true;
    },
    sendAgentAnalysisRequest(message) {
      const socket = socketsByDeviceId.get(message.deviceId);
      if (!socket) return false;
      const connection = options.store.readDeviceConnection(message.deviceId, now());
      if (!connection?.agentAnalysis?.supported) return false;
      if (connection.agentAnalysis.protocolVersion < message.protocolVersion) return false;
      if (!connection.agentAnalysis.runtimes.includes("openclaw")) return false;
      if (!connection.agentAnalysis.promptKinds.includes(message.promptKind)) return false;
      send(socket, {
        type: "agent.analysis.request",
        ...message,
      });
      return true;
    },
    isDeviceConnected(deviceId) {
      return socketsByDeviceId.has(deviceId);
    },
  };
}

function parseControlMessage(rawMessage: string): ControlMessage {
  const parsed = JSON.parse(rawMessage) as unknown;
  if (!isRecord(parsed)) throw new Error("control message must be an object");
  return parsed;
}

function requireDeviceId(message: ControlMessage, fallback?: string): string {
  const deviceId = message.deviceId ?? fallback;
  if (!deviceId) throw new Error("control message missing deviceId");
  return deviceId;
}

function normalizeCollectorUpgradeCapability(input: unknown): RuntimeCollectorUpgradeCapability | undefined {
  if (!isRecord(input)) return undefined;
  if (input.supported !== true) return undefined;
  const protocolVersion = input.protocolVersion;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion) || protocolVersion < 1) {
    return undefined;
  }
  return {
    protocolVersion,
    supported: true,
    ...(typeof input.installPath === "string" ? { installPath: input.installPath } : {}),
    ...(typeof input.lastUpgradeJobId === "string" ? { lastUpgradeJobId: input.lastUpgradeJobId } : {}),
    ...(
      input.lastUpgradeStatus === "succeeded" ||
        input.lastUpgradeStatus === "failed" ||
        input.lastUpgradeStatus === "rolled_back"
        ? { lastUpgradeStatus: input.lastUpgradeStatus }
        : {}
    ),
  };
}

function normalizeAgentAnalysisCapability(input: unknown): RuntimeAgentAnalysisCapability | undefined {
  if (!isRecord(input)) return undefined;
  if (input.supported !== true) return undefined;
  const protocolVersion = input.protocolVersion;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion) || protocolVersion < 1) {
    return undefined;
  }
  const runtimes = normalizeStringList(input.runtimes);
  const promptKinds = normalizeStringList(input.promptKinds);
  if (!runtimes.length || !promptKinds.length) return undefined;
  return {
    promptKinds,
    protocolVersion,
    runtimes,
    supported: true,
  };
}

function normalizeCollectorUpgradeProgress(
  message: ControlMessage,
  socketDeviceId?: string,
): CollectorUpgradeProgressMessage | null {
  if (message.protocolVersion !== 1) return null;
  if (!socketDeviceId || message.deviceId !== socketDeviceId) return null;
  if (!isNonEmptyString(message.operationId)) return null;
  if (!isNonEmptyString(message.jobId)) return null;
  if (!isNonEmptyString(message.nonce)) return null;
  if (!isNonEmptyString(message.deviceId)) return null;
  if (!isCollectorUpgradeStageValue(message.stage)) return null;
  if (!isCollectorUpgradeStatus(message.status)) return null;

  return {
    deviceId: message.deviceId,
    jobId: message.jobId,
    nonce: message.nonce,
    operationId: message.operationId,
    protocolVersion: 1,
    stage: message.stage,
    status: message.status,
    ...(typeof message.collectorVersion === "string" ? { collectorVersion: message.collectorVersion } : {}),
    ...(typeof message.currentVersion === "string" ? { currentVersion: message.currentVersion } : {}),
    ...(typeof message.targetVersion === "string" ? { targetVersion: message.targetVersion } : {}),
    ...(typeof message.message === "string" ? { message: message.message } : {}),
    ...(typeof message.errorCode === "string" ? { errorCode: message.errorCode } : {}),
    ...(typeof message.observedAt === "string" ? { observedAt: message.observedAt } : {}),
  };
}

function normalizeAgentAnalysisProgress(
  message: ControlMessage,
  socketDeviceId?: string,
): AgentAnalysisProgressMessage | null {
  if (message.protocolVersion !== 1) return null;
  if (!socketDeviceId || message.deviceId !== socketDeviceId) return null;
  if (!isNonEmptyString(message.operationId)) return null;
  if (!isNonEmptyString(message.jobId)) return null;
  if (!isNonEmptyString(message.nonce)) return null;
  if (!isNonEmptyString(message.deviceId)) return null;
  if (!isAgentAnalysisProgressStage(message.stage)) return null;
  if (!isAgentAnalysisProgressStatus(message.status)) return null;

  return {
    deviceId: message.deviceId,
    jobId: message.jobId,
    nonce: message.nonce,
    operationId: message.operationId,
    protocolVersion: 1,
    stage: message.stage,
    status: message.status,
    ...(typeof message.message === "string" ? { message: message.message } : {}),
    ...(typeof message.observedAt === "string" ? { observedAt: message.observedAt } : {}),
  };
}

function normalizeAgentAnalysisResult(
  message: ControlMessage,
  socketDeviceId?: string,
): AgentAnalysisResultMessage | null {
  if (message.protocolVersion !== 1) return null;
  if (!socketDeviceId || message.deviceId !== socketDeviceId) return null;
  if (!isNonEmptyString(message.operationId)) return null;
  if (!isNonEmptyString(message.jobId)) return null;
  if (!isNonEmptyString(message.nonce)) return null;
  if (!isNonEmptyString(message.deviceId)) return null;
  if (!isAgentAnalysisResultStatus(message.status)) return null;

  return {
    deviceId: message.deviceId,
    jobId: message.jobId,
    nonce: message.nonce,
    operationId: message.operationId,
    protocolVersion: 1,
    status: message.status,
    ...(typeof message.runtimeRunId === "string" ? { runtimeRunId: message.runtimeRunId } : {}),
    ...(typeof message.durationMs === "number" && Number.isFinite(message.durationMs) ? { durationMs: message.durationMs } : {}),
    ...(isRecord(message.modelMetadata) ? { modelMetadata: message.modelMetadata } : {}),
    ...(message.analysis !== undefined ? { analysis: message.analysis } : {}),
    ...(typeof message.errorCode === "string" ? { errorCode: message.errorCode } : {}),
    ...(typeof message.message === "string" ? { message: message.message } : {}),
    ...(typeof message.observedAt === "string" ? { observedAt: message.observedAt } : {}),
  };
}

function isCollectorUpgradeStageValue(value: unknown): value is CollectorUpgradeStage {
  return typeof value === "string" && collectorUpgradeStageSet.has(value);
}

function isCollectorUpgradeStatus(value: unknown): value is CollectorUpgradeStatus {
  return (
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "requires_manual_step"
  );
}

function isAgentAnalysisProgressStage(value: unknown): value is AgentAnalysisProgressMessage["stage"] {
  return value === "accepted" ||
    value === "executing" ||
    value === "result_received" ||
    value === "failed";
}

function isAgentAnalysisProgressStatus(value: unknown): value is AgentAnalysisProgressMessage["status"] {
  return value === "running" || value === "failed";
}

function isAgentAnalysisResultStatus(value: unknown): value is AgentAnalysisResultMessage["status"] {
  return value === "succeeded" || value === "failed" || value === "unsupported";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => isNonEmptyString(item)).map((item) => item.trim()))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
