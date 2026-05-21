import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeControlChannel } from "./runtime-control-channel";
import type { RuntimeInventoryStore } from "./runtime-inventory-store";
import type { PostgresStore } from "./postgres-store";
import type { RuntimeWorkStateStore } from "./runtime-work-state-store";
import type { CreateNotificationEventInput } from "../notifications/notification-store";
import { createErrorResponse, normalizeErrorCode } from "../errors/error-catalog";
import type { StructuredLogger } from "../logging/structured-logger";
import {
  normalizeAgentSkillProbeSnapshot,
  type AgentSkillProbeSnapshot,
  type AgentSkillProbeStatus,
} from "../runtime/agent-skill-probe";
import { deriveDeviceHealthStatus } from "../runtime/runtime-device-health";
import type { OperationRow, OperationStatus, OperationStore } from "../operations/operation-store";

const maxJsonBodyChars = 10_000_000;

/** Dependencies for the Runtime Fleet local HTTP API. */
export interface RuntimeHttpApiHandlerOptions {
  /** Optional auth guards for user reads and device ingestion. */
  auth?: {
    requireDeviceToken?: (request: IncomingMessage) => Promise<unknown | null>;
    requireUserSession?: (request: IncomingMessage) => Promise<unknown | null>;
  };
  /** Snapshot and connection state store. */
  store: RuntimeInventoryStore;
  /** Device connection channel. */
  controlChannel: RuntimeControlChannel;
  /** Latest runtime work-state snapshot store. */
  workStateStore?: RuntimeWorkStateStore;
  /** Optional Postgres-backed formal repository. */
  postgresStore?: PostgresStore;
  /** Optional notification integration for collector ingestion health events. */
  collectorNotifications?: {
    createNotificationEvent: (input: CreateNotificationEventInput) => Promise<unknown>;
    listRecipientUserIds: (organizationId: string, deviceId: string) => Promise<string[]>;
  };
  /** Optional Operation integration for device-reported Agent Skill probe snapshots. */
  operationStore?: Pick<OperationStore, "updateOperationStatus">;
  /** Optional notification integration for Agent Skill probe lifecycle. */
  skillProbeNotifications?: {
    createNotificationEvent: (input: CreateNotificationEventInput) => Promise<unknown>;
    listRecipientUserIds: (organizationId: string, deviceId: string) => Promise<string[]>;
  };
  /** Optional structured logger. */
  logger?: StructuredLogger;
}

/** Node/Vite middleware-style next callback. */
export type RuntimeHttpNext = () => void;

/** Runtime Fleet local HTTP API handler. */
export type RuntimeHttpApiHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next: RuntimeHttpNext,
) => Promise<void>;

/** Create the local Runtime Fleet HTTP API used by Vite and backend tests. */
export function createRuntimeHttpApiHandler(options: RuntimeHttpApiHandlerOptions): RuntimeHttpApiHandler {
  return async function runtimeHttpApiHandler(request, response, next) {
    const requestUrl = new URL(request.url || "/", "http://lorume.local");

    if (request.method === "GET" && requestUrl.pathname === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/readyz") {
      if (!options.postgresStore) {
        sendJson(response, 503, { ok: false, error: "postgres_store_unavailable" });
        return;
      }
      try {
        await options.postgresStore.checkReady();
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 503, {
          ok: false,
          error: "postgres_unavailable",
          message: error instanceof Error ? error.message : "Postgres is unavailable",
        });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/runtime-fleet") {
      if (!(await authorizeUserRead(options, request, response))) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      sendJson(response, 200, await options.postgresStore.readRuntimeFleet());
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/runtime-work-items") {
      if (!(await authorizeUserRead(options, request, response))) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      sendJson(response, 200, await options.postgresStore.listRuntimeWorkItems({
        channelKind: requestUrl.searchParams.get("channelKind"),
        endAt: requestUrl.searchParams.get("endAt"),
        limit: parseLimit(requestUrl.searchParams.get("limit")),
        cursor: requestUrl.searchParams.get("cursor"),
        search: requestUrl.searchParams.get("search"),
        source: requestUrl.searchParams.get("source"),
        stage: requestUrl.searchParams.get("stage"),
        startAt: requestUrl.searchParams.get("startAt"),
      }));
      return;
    }

    const workItemMatch = requestUrl.pathname.match(/^\/api\/runtime-work-items\/([^/]+)$/);
    if (request.method === "GET" && workItemMatch) {
      if (!(await authorizeUserRead(options, request, response))) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      const workItemId = decodeURIComponent(workItemMatch[1] ?? "");
      const workItem = await options.postgresStore.readWorkItem(workItemId);
      if (!workItem) {
        sendJson(response, 404, { error: "work_item_not_found", id: workItemId });
        return;
      }
      sendJson(response, 200, workItem);
      return;
    }

    const agentSkillProbeMatch = requestUrl.pathname.match(/^\/api\/agents\/([^/]+)\/skill-probe$/);
    if (request.method === "GET" && agentSkillProbeMatch) {
      if (!(await authorizeUserRead(options, request, response))) return;
      const agentId = decodeURIComponent(agentSkillProbeMatch[1] ?? "");
      const snapshot = await readAgentSkillProbeSnapshot(options, agentId);
      sendJson(response, 200, snapshot);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/agent-skill-probe-snapshots") {
      const deviceAuth = await authorizeDeviceWrite(options, request, response);
      if (deviceAuth === null) return;
      try {
        const body = await readJsonBody(request);
        const snapshot = await persistAgentSkillProbeSnapshot(options, body);
        const operation = snapshot.operationId
          ? await updateOperationFromProbeSnapshot(options, snapshot)
          : null;
        await notifyAgentSkillProbeSnapshot(options, snapshot, operation);
        sendJson(response, 201, {
          ok: true,
          deviceId: snapshot.deviceId,
          targetAgentId: snapshot.targetAgentId,
          status: snapshot.status,
        });
      } catch (error) {
        sendJson(response, statusCodeForWriteError(error), {
          error: error instanceof Error ? error.message : "invalid agent skill probe snapshot",
        });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/device-snapshots") {
      const deviceAuth = await authorizeDeviceWrite(options, request, response);
      if (deviceAuth === null) return;
      let body: unknown = undefined;
      try {
        body = await readJsonBody(request);
        const snapshot = options.store.writeLatestSnapshot(enrichInventorySnapshotWithRequestNetwork(body, request));
        await options.postgresStore?.upsertInventorySnapshot(snapshot);
        sendJson(response, 201, {
          ok: true,
          deviceId: snapshot.device.id,
          observedAt: snapshot.observedAt,
        });
      } catch (error) {
        const errorResponse = createErrorResponse(error, "invalid_collector_snapshot");
        await recordFailedCollectorIngestion(options, "inventory", body, error);
        await notifyFailedCollectorIngestion(options, "inventory", body, error, deviceAuth);
        logCollectorIngestionFailure(options, "inventory", body, errorResponse);
        sendJson(response, statusCodeForWriteError(error), errorResponse);
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/runtime-work-state-snapshots") {
      const deviceAuth = await authorizeDeviceWrite(options, request, response);
      if (deviceAuth === null) return;
      if (!options.workStateStore) {
        sendJson(response, 503, { error: "work_state_store_unavailable" });
        return;
      }
      let body: unknown = undefined;
      try {
        body = await readJsonBody(request);
        const snapshot = options.workStateStore.writeLatestSnapshot(body);
        await options.postgresStore?.upsertWorkStateSnapshot(snapshot);
        sendJson(response, 201, {
          ok: true,
          deviceId: snapshot.deviceId,
          observedAt: snapshot.observedAt,
        });
      } catch (error) {
        const errorResponse = createErrorResponse(error, "invalid_work_state_snapshot");
        await recordFailedCollectorIngestion(options, "work_state", body, error);
        await notifyFailedCollectorIngestion(options, "work_state", body, error, deviceAuth);
        logCollectorIngestionFailure(options, "work_state", body, errorResponse);
        sendJson(response, statusCodeForWriteError(error), errorResponse);
      }
      return;
    }

    const ingestionMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/ingestions$/);
    if (request.method === "GET" && ingestionMatch) {
      if (!(await authorizeUserRead(options, request, response))) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      const deviceId = decodeURIComponent(ingestionMatch[1] ?? "");
      sendJson(response, 200, {
        deviceId,
        ingestions: await options.postgresStore.listCollectorIngestions(deviceId),
      });
      return;
    }

    const diagnosticsMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/diagnostics$/);
    if (request.method === "GET" && diagnosticsMatch) {
      if (!(await authorizeUserRead(options, request, response))) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      const deviceId = decodeURIComponent(diagnosticsMatch[1] ?? "");
      const nowParam = requestUrl.searchParams.get("now");
      const now = nowParam ? new Date(nowParam) : new Date();
      sendJson(response, 200, deriveDeviceHealthStatus({
        deviceId,
        now,
        connection: options.store.readDeviceConnection(deviceId, now),
        inventoryIngestions: await options.postgresStore.listCollectorIngestions(deviceId),
      }));
      return;
    }

    const collectionHealthMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/collection-health$/);
    if (request.method === "GET" && collectionHealthMatch) {
      if (!(await authorizeUserRead(options, request, response))) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      const deviceId = decodeURIComponent(collectionHealthMatch[1] ?? "");
      sendJson(response, 200, await options.postgresStore.readDeviceCollectionHealth(deviceId));
      return;
    }

    next();
  };
}

interface AgentSkillProbeRequestContext {
  targetAgentId: string;
  targetAgentName?: string;
  deviceId: string;
  runtimeId: string;
  runtimeName?: string;
}

async function readAgentSkillProbeSnapshot(
  options: RuntimeHttpApiHandlerOptions,
  agentId: string,
): Promise<AgentSkillProbeSnapshot> {
  const postgresSnapshot = await options.postgresStore?.readAgentSkillProbeSnapshot(agentId).catch(() => null);
  const storeSnapshot = options.store.readAgentSkillProbeSnapshot(agentId);
  if (postgresSnapshot) return postgresSnapshot;
  if (storeSnapshot) return storeSnapshot;
  try {
    const context = await resolveAgentSkillProbeRequestContext(options, agentId, {});
    return createAgentSkillProbeSnapshot(context, "unknown");
  } catch {
    return {
      targetAgentId: agentId,
      deviceId: "unknown",
      runtimeId: "unknown",
      status: "unknown",
      observedAt: null,
      skills: [],
    };
  }
}

async function resolveAgentSkillProbeRequestContext(
  options: RuntimeHttpApiHandlerOptions,
  agentId: string,
  body: unknown,
): Promise<AgentSkillProbeRequestContext> {
  const requestedDeviceId = readString(body, "deviceId");
  const requestedRuntimeId = readString(body, "runtimeId");
  const fleet = await readRuntimeFleetForProbe(options);
  const agent = fleet.agents.find((candidate) => candidate.id === agentId);
  const runtime = fleet.runtimes.find((candidate) => candidate.id === (agent?.runtimeId ?? requestedRuntimeId));
  const device = fleet.devices.find((candidate) => candidate.id === (runtime?.deviceId ?? requestedDeviceId));
  const runtimeId = runtime?.id ?? requestedRuntimeId;
  const deviceId = device?.id ?? requestedDeviceId;
  if (!runtimeId) throw new Error("runtimeId is required for skill probe");
  if (!deviceId) throw new Error("deviceId is required for skill probe");
  return {
    targetAgentId: agentId,
    ...(agent?.name ? { targetAgentName: agent.name } : {}),
    deviceId,
    runtimeId,
    ...(runtime?.name ? { runtimeName: runtime.name } : {}),
  };
}

async function readRuntimeFleetForProbe(options: RuntimeHttpApiHandlerOptions): Promise<{
  devices: Array<{ id: string }>;
  runtimes: Array<{ id: string; deviceId: string; name?: string }>;
  agents: Array<{ id: string; name?: string; runtimeId: string }>;
}> {
  const postgresFleet = await options.postgresStore?.readRuntimeFleet().catch(() => null);
  if (postgresFleet) return postgresFleet;
  const snapshot = options.store.readLatestSnapshot();
  if (!snapshot) return { devices: [], runtimes: [], agents: [] };
  return {
    devices: [snapshot.device],
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
  };
}

function createAgentSkillProbeSnapshot(
  context: AgentSkillProbeRequestContext,
  status: AgentSkillProbeStatus,
): AgentSkillProbeSnapshot {
  return {
    targetAgentId: context.targetAgentId,
    ...(context.targetAgentName ? { targetAgentName: context.targetAgentName } : {}),
    deviceId: context.deviceId,
    runtimeId: context.runtimeId,
    ...(context.runtimeName ? { runtimeName: context.runtimeName } : {}),
    status,
    observedAt: status === "unknown" ? null : new Date().toISOString(),
    skills: [],
  };
}

async function persistAgentSkillProbeSnapshot(
  options: RuntimeHttpApiHandlerOptions,
  value: unknown,
): Promise<AgentSkillProbeSnapshot> {
  const snapshot = options.store.writeAgentSkillProbeSnapshot(value);
  await options.postgresStore?.upsertAgentSkillProbeSnapshot(snapshot).catch(() => undefined);
  return snapshot;
}

async function updateAgentSkillProbeOperation(
  options: RuntimeHttpApiHandlerOptions,
  operationId: string,
  status: OperationStatus,
  errorSummary?: string,
): Promise<OperationRow | null> {
  if (!options.operationStore) return null;
  return options.operationStore.updateOperationStatus({
    errorSummary,
    now: new Date(),
    operationId,
    status,
  });
}

async function updateOperationFromProbeSnapshot(
  options: RuntimeHttpApiHandlerOptions,
  snapshot: AgentSkillProbeSnapshot,
): Promise<OperationRow | null> {
  const operationStatus = operationStatusForProbeStatus(snapshot.status);
  if (!operationStatus || !snapshot.operationId) return null;
  return updateAgentSkillProbeOperation(options, snapshot.operationId, operationStatus, snapshot.errorSummary);
}

function operationStatusForProbeStatus(status: AgentSkillProbeStatus): OperationStatus | null {
  if (status === "succeeded") return "succeeded";
  if (status === "unsupported") return "unsupported";
  if (status === "failed" || status === "device_disconnected") return "failed";
  return null;
}

async function notifyAgentSkillProbeSnapshot(
  options: RuntimeHttpApiHandlerOptions,
  snapshot: AgentSkillProbeSnapshot,
  operation: OperationRow | null,
): Promise<void> {
  if (snapshot.status !== "succeeded" && snapshot.status !== "failed" && snapshot.status !== "unsupported") return;
  const title = snapshot.status === "succeeded"
    ? "Skill 探测完成"
    : snapshot.status === "unsupported"
      ? "Skill 探测不支持"
      : "Skill 探测失败";
  const eventType = snapshot.status === "succeeded"
    ? "agent_skill_probe_succeeded"
    : snapshot.status === "unsupported"
      ? "agent_skill_probe_unsupported"
      : "agent_skill_probe_failed";
  await notifyAgentSkillProbe(options, {
    eventType,
    operation,
    requestContext: {
      targetAgentId: snapshot.targetAgentId,
      targetAgentName: snapshot.targetAgentName,
      deviceId: snapshot.deviceId,
      runtimeId: snapshot.runtimeId,
      runtimeName: snapshot.runtimeName,
    },
    severity: snapshot.status === "succeeded" ? "info" : "warning",
    snapshot,
    summary: snapshot.errorSummary
      ? `${snapshot.targetAgentName ?? snapshot.targetAgentId} Skill 探测状态：${snapshot.errorSummary}`
      : `${snapshot.targetAgentName ?? snapshot.targetAgentId} Skill 探测状态：${snapshot.status}`,
    title,
  });
}

async function notifyAgentSkillProbe(
  options: RuntimeHttpApiHandlerOptions,
  input: {
    eventType: string;
    operation: OperationRow | null;
    requestContext: AgentSkillProbeRequestContext;
    severity: "info" | "warning" | "critical";
    snapshot: AgentSkillProbeSnapshot;
    summary: string;
    title: string;
  },
): Promise<void> {
  if (!options.skillProbeNotifications || !input.operation) return;
  const recipients = uniqueNonEmptyStrings([
    input.operation.requestedByUserId ?? "",
    ...await options.skillProbeNotifications.listRecipientUserIds(
      input.operation.organizationId,
      input.requestContext.deviceId,
    ).catch(() => []),
  ]);
  if (recipients.length === 0) return;
  await options.skillProbeNotifications.createNotificationEvent({
    actorUserId: input.operation.requestedByUserId ?? undefined,
    dedupeKey: `agent-skill-probe:${input.snapshot.targetAgentId}:${input.eventType}`,
    eventType: input.eventType,
    operationId: input.operation.id,
    organizationId: input.operation.organizationId,
    recipientUserIds: recipients,
    resourceId: input.snapshot.targetAgentId,
    resourceType: "agent",
    severity: input.severity,
    sourceModule: "runtime",
    summary: input.summary,
    title: input.title,
  }).catch(() => undefined);
}

function readString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const candidate = value[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function enrichInventorySnapshotWithRequestNetwork(value: unknown, request: IncomingMessage): unknown {
  const publicIp = readCollectorPublicIp(request);
  if (!publicIp || !isRecord(value) || !isRecord(value.device)) return value;
  const device = value.device;
  const network = isRecord(device.network) ? device.network : {};
  return {
    ...value,
    device: {
      ...device,
      network: {
        ...network,
        publicIp,
      },
    },
  };
}

function readCollectorPublicIp(request: IncomingMessage): string {
  const forwardedFor = readHeaderValue(request.headers["x-forwarded-for"]);
  const forwardedCandidate = forwardedFor.split(",").map((part) => normalizeIpAddress(part)).find(Boolean);
  if (forwardedCandidate) return forwardedCandidate;
  return normalizeIpAddress(request.socket.remoteAddress ?? "");
}

function readHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(",");
  return value ?? "";
}

function normalizeIpAddress(value: string): string {
  return value.trim().replace(/^::ffff:/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function authorizeUserRead(
  options: RuntimeHttpApiHandlerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (!options.auth?.requireUserSession) return true;
  const session = await options.auth.requireUserSession(request);
  if (session) return true;
  sendJson(response, 401, { error: "unauthorized" });
  return false;
}

async function authorizeDeviceWrite(
  options: RuntimeHttpApiHandlerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | null> {
  if (!options.auth?.requireDeviceToken) return undefined;
  const deviceToken = await options.auth.requireDeviceToken(request);
  if (deviceToken) return deviceToken;
  sendJson(response, 401, { error: "invalid_device_token" });
  return null;
}

async function recordFailedCollectorIngestion(
  options: RuntimeHttpApiHandlerOptions,
  snapshotType: "inventory" | "work_state",
  body: unknown,
  error: unknown,
): Promise<void> {
  if (!options.postgresStore) return;
  const errorResponse = createErrorResponse(error, snapshotType === "inventory"
    ? "invalid_collector_snapshot"
    : "invalid_work_state_snapshot");
  await options.postgresStore.recordFailedCollectorIngestion({
    deviceId: extractDeviceId(snapshotType, body),
    error: `${errorResponse.error}: ${errorResponse.message}`,
    observedAt: extractObservedAt(body),
    snapshotType,
  }).catch(() => undefined);
}

function logCollectorIngestionFailure(
  options: RuntimeHttpApiHandlerOptions,
  snapshotType: "inventory" | "work_state",
  body: unknown,
  errorResponse: { error: string; message: string },
): void {
  options.logger?.warn({
    deviceId: extractDeviceId(snapshotType, body),
    errorCode: normalizeErrorCode(errorResponse.error),
    event: "collector_ingestion_failed",
    snapshotType,
  }, errorResponse.message);
}

async function notifyFailedCollectorIngestion(
  options: RuntimeHttpApiHandlerOptions,
  snapshotType: "inventory" | "work_state",
  body: unknown,
  error: unknown,
  deviceAuth: unknown,
): Promise<void> {
  if (!options.collectorNotifications) return;
  const organizationId = extractOrganizationId(deviceAuth);
  if (!organizationId) return;
  const deviceId = extractDeviceId(snapshotType, body);
  const recipients = uniqueNonEmptyStrings(
    await options.collectorNotifications.listRecipientUserIds(organizationId, deviceId).catch(() => []),
  );
  if (recipients.length === 0) return;
  const label = snapshotType === "inventory" ? "设备资产" : "工作态";
  await options.collectorNotifications.createNotificationEvent({
    dedupeKey: `runtime:collector:${deviceId}:${snapshotType}:failed`,
    emailCooldownMs: 30 * 60 * 1000,
    eventType: `collector_${snapshotType}_failed`,
    organizationId,
    recipientUserIds: recipients,
    resourceId: deviceId,
    resourceType: "device",
    severity: "warning",
    sourceModule: "runtime",
    summary: `${deviceId} ${label}采集失败：${errorSummary(error)}`,
    title: `${label}采集失败`,
  }).catch(() => undefined);
}

function extractOrganizationId(deviceAuth: unknown): string | undefined {
  if (!deviceAuth || typeof deviceAuth !== "object") return undefined;
  const organizationId = (deviceAuth as Record<string, unknown>).organizationId;
  return typeof organizationId === "string" && organizationId.trim() ? organizationId : undefined;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "invalid collector snapshot";
  return message.replace(/\s+/g, " ").trim().slice(0, 200);
}

function extractDeviceId(snapshotType: "inventory" | "work_state", body: unknown): string {
  if (!body || typeof body !== "object") return "unknown";
  const candidate = body as Record<string, unknown>;
  if (snapshotType === "work_state" && typeof candidate.deviceId === "string") return candidate.deviceId;
  if (snapshotType === "inventory") {
    const device = candidate.device;
    if (device && typeof device === "object" && typeof (device as Record<string, unknown>).id === "string") {
      return (device as Record<string, string>).id;
    }
  }
  return "unknown";
}

function extractObservedAt(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const observedAt = (body as Record<string, unknown>).observedAt;
  return typeof observedAt === "string" ? observedAt : undefined;
}

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function statusCodeForWriteError(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("invalid") || message.includes("required") || message.includes("too large")) return 400;
  return 500;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxJsonBodyChars) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
