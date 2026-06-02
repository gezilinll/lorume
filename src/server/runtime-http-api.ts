import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { compareCollectorVersions } from "../collector/collector-upgrade-model";
import type { RuntimeControlChannel } from "./runtime-control-channel";
import type { RuntimeDeviceStateStore } from "./runtime-device-state-store";
import type { PostgresStore } from "./postgres-store";
import { createCollectorPackageManifest } from "../backend/device-installer-manifest";
import type { CreateNotificationEventInput } from "../notifications/notification-store";
import type { OperationStore, OperationStatus } from "../operations/operation-store";
import { createErrorResponse, normalizeErrorCode } from "../errors/error-catalog";
import type { StructuredLogger } from "../logging/structured-logger";
import {
  normalizeAgentSkillProbeSnapshot,
  type AgentSkillProbeSnapshot,
  type AgentSkillProbeStatus,
} from "../runtime/agent-skill-probe";
import {
  type RuntimeSkillProbeStatus,
  type RuntimeSkillSnapshot,
} from "../runtime/runtime-skill-probe";
import {
  type RuntimeScheduleProbeSnapshot,
} from "../runtime/runtime-schedule-probe";
import { normalizeDeviceStateSnapshot } from "../runtime/runtime-model";
import { normalizeRuntimeTaskBatch } from "../runtime/runtime-task-sync";
import { deriveDeviceHealthStatus } from "../runtime/runtime-device-health";
import type { CollectionHealthIngestion } from "../runtime/runtime-collection-health";

const maxJsonBodyChars = 10_000_000;
type CollectorSnapshotType = "device_state" | "task_batch";
type RuntimeOrganizationId = string | undefined;

interface RuntimeUserSessionLike {
  organizations?: Array<{ organizationId?: unknown; role?: unknown }>;
  user?: { id?: unknown };
}

/** Dependencies for the Runtime Fleet local HTTP API. */
export interface RuntimeHttpApiHandlerOptions {
  /** Optional auth guards for user reads and device ingestion. */
  auth?: {
    requireDeviceToken?: (request: IncomingMessage) => Promise<unknown | null>;
    requireUserSession?: (request: IncomingMessage) => Promise<unknown | null>;
    verifyDeviceTokenValue?: (token: string, deviceId?: string | null) => Promise<unknown | null>;
  };
  /** Snapshot and connection state store. */
  store: RuntimeDeviceStateStore;
  /** Device connection channel. */
  controlChannel: RuntimeControlChannel;
  /** Optional Postgres-backed formal repository. */
  postgresStore?: PostgresStore;
  /** Optional Operation repository for platform Operations created by Runtime APIs. */
  operationStore?: OperationStore;
  /** Optional notification integration for collector ingestion health events. */
  collectorNotifications?: {
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
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      sendJson(response, 200, await options.postgresStore.readRuntimeFleet({ organizationId }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/runtime-tasks") {
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      const channelKinds = parseChannelKindFilters(requestUrl.searchParams);
      sendJson(response, 200, await options.postgresStore.listRuntimeTasks({
        channelKind: channelKinds[0] ?? null,
        channelKinds,
        endAt: requestUrl.searchParams.get("endAt"),
        limit: parseLimit(requestUrl.searchParams.get("limit")),
        cursor: requestUrl.searchParams.get("cursor"),
        organizationId,
        search: requestUrl.searchParams.get("search"),
        status: requestUrl.searchParams.get("status"),
        statusScope: requestUrl.searchParams.get("statusScope"),
        startAt: requestUrl.searchParams.get("startAt"),
        taskType: requestUrl.searchParams.get("taskType"),
      }));
      return;
    }

    const agentSkillProbeMatch = requestUrl.pathname.match(/^\/api\/agents\/([^/]+)\/skill-probe$/);
    if (request.method === "GET" && agentSkillProbeMatch) {
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
      const agentId = decodeURIComponent(agentSkillProbeMatch[1] ?? "");
      const snapshot = await readAgentSkillProbeSnapshot(options, agentId, organizationId);
      sendJson(response, 200, snapshot);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/agent-skill-probe-snapshots") {
      try {
        const body = await readJsonBody(request);
        const deviceAuth = await authorizeDeviceWrite(options, request, response, extractDeviceId("device_state", body));
        if (deviceAuth === null) return;
        const snapshot = await persistAgentSkillProbeSnapshot(options, body);
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

    const runtimeSkillProbeMatch = requestUrl.pathname.match(/^\/api\/runtimes\/([^/]+)\/skill-probe$/);
    if (request.method === "GET" && runtimeSkillProbeMatch) {
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
      const runtimeId = decodeURIComponent(runtimeSkillProbeMatch[1] ?? "");
      const snapshot = await readRuntimeSkillProbeSnapshot(options, runtimeId, organizationId);
      sendJson(response, 200, snapshot);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/runtime-skill-probe-snapshots") {
      try {
        const body = await readJsonBody(request);
        const deviceAuth = await authorizeDeviceWrite(options, request, response, extractDeviceId("device_state", body));
        if (deviceAuth === null) return;
        const snapshot = await persistRuntimeSkillProbeSnapshot(options, body);
        sendJson(response, 201, {
          ok: true,
          deviceId: snapshot.deviceId,
          runtimeId: snapshot.runtimeId,
          status: snapshot.status,
        });
      } catch (error) {
        sendJson(response, statusCodeForWriteError(error), {
          error: error instanceof Error ? error.message : "invalid runtime skill probe snapshot",
        });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/runtime-schedule-probe-snapshots") {
      try {
        const body = await readJsonBody(request);
        const deviceAuth = await authorizeDeviceWrite(options, request, response, extractDeviceId("device_state", body));
        if (deviceAuth === null) return;
        const snapshot = await persistRuntimeScheduleProbeSnapshot(options, body);
        sendJson(response, 201, {
          ok: true,
          deviceId: snapshot.deviceId,
          runtimeId: snapshot.runtimeId,
          status: snapshot.status,
        });
      } catch (error) {
        sendJson(response, statusCodeForWriteError(error), {
          error: error instanceof Error ? error.message : "invalid runtime schedule probe snapshot",
        });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/runtime-scheduled-tasks") {
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      sendJson(response, 200, await options.postgresStore.listRuntimeScheduledTasks({ organizationId }));
      return;
    }

    const scheduledTaskExecutionsMatch = requestUrl.pathname.match(/^\/api\/runtime-scheduled-tasks\/([^/]+)\/executions$/);
    if (request.method === "GET" && scheduledTaskExecutionsMatch) {
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      const scheduleKey = decodeURIComponent(scheduledTaskExecutionsMatch[1] ?? "");
      sendJson(response, 200, await options.postgresStore.listRuntimeScheduledTaskExecutions(scheduleKey, {
        organizationId,
        limit: parseLimit(requestUrl.searchParams.get("limit")),
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/device-state-snapshots") {
      let body: unknown = undefined;
      let deviceAuth: unknown = undefined;
      try {
        body = await readJsonBody(request);
        deviceAuth = await authorizeDeviceWrite(options, request, response, extractDeviceId("device_state", body));
        if (deviceAuth === null) return;
        const snapshot = normalizeDeviceStateSnapshot(enrichDeviceStateSnapshotWithRequestNetwork(body, request));
        if (!snapshot) throw new Error("invalid device state snapshot");
        if (snapshot.tasks.length > 0) throw new Error("device state snapshots must not include tasks; use task batches");
        if (!options.postgresStore) {
          sendJson(response, 503, { error: "postgres_store_unavailable" });
          return;
        }
        await options.postgresStore.upsertDeviceStateSnapshot(snapshot, { organizationId: extractOrganizationId(deviceAuth) });
        sendJson(response, 201, {
          ok: true,
          deviceId: snapshot.device.id,
          collectedAt: snapshot.collectedAt,
        });
      } catch (error) {
        const errorResponse = createErrorResponse(error, "invalid_device_state_snapshot");
        await recordFailedCollectorIngestion(options, "device_state", body, error, extractOrganizationId(deviceAuth));
        await notifyFailedCollectorIngestion(options, "device_state", body, error, deviceAuth);
        logCollectorIngestionFailure(options, "device_state", body, errorResponse);
        sendJson(response, statusCodeForWriteError(error), errorResponse);
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/device-task-batches") {
      let body: unknown = undefined;
      let deviceAuth: unknown = undefined;
      try {
        body = await readJsonBody(request);
        deviceAuth = await authorizeDeviceWrite(options, request, response, extractDeviceId("task_batch", body));
        if (deviceAuth === null) return;
        const batch = normalizeRuntimeTaskBatch(body);
        if (!batch) throw new Error("invalid runtime task batch");
        if (!options.postgresStore) {
          sendJson(response, 503, { error: "postgres_store_unavailable" });
          return;
        }
        const result = await options.postgresStore.upsertRuntimeTaskBatch(batch, { organizationId: extractOrganizationId(deviceAuth) });
        sendJson(response, 201, { ok: true, ...result });
      } catch (error) {
        const errorResponse = createErrorResponse(error, "invalid_runtime_task_batch");
        await recordFailedCollectorIngestion(options, "task_batch", body, error, extractOrganizationId(deviceAuth));
        logCollectorIngestionFailure(options, "task_batch", body, errorResponse);
        sendJson(response, statusCodeForWriteError(error), errorResponse);
      }
      return;
    }

    const ingestionMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/ingestions$/);
    if (request.method === "GET" && ingestionMatch) {
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      const deviceId = decodeURIComponent(ingestionMatch[1] ?? "");
      sendJson(response, 200, {
        deviceId,
        ingestions: await options.postgresStore.listCollectorIngestions(deviceId, { organizationId }),
      });
      return;
    }

    const collectorUpgradeMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/collector-upgrade$/);
    if (request.method === "POST" && collectorUpgradeMatch) {
      await createCollectorUpgradeOperation(
        options,
        request,
        response,
        decodeURIComponent(collectorUpgradeMatch[1] ?? ""),
        requestUrl.searchParams,
      );
      return;
    }

    const diagnosticsMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/diagnostics$/);
    if (request.method === "GET" && diagnosticsMatch) {
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
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
        deviceStateIngestions: toCollectionHealthIngestions(await options.postgresStore.listCollectorIngestions(deviceId, { organizationId })),
      }));
      return;
    }

    const collectionHealthMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/collection-health$/);
    if (request.method === "GET" && collectionHealthMatch) {
      const organizationId = await authorizeOrganizationRead(options, request, response, requestUrl.searchParams);
      if (organizationId === null) return;
      if (!options.postgresStore) {
        sendJson(response, 503, { error: "postgres_store_unavailable" });
        return;
      }
      const deviceId = decodeURIComponent(collectionHealthMatch[1] ?? "");
      sendJson(response, 200, await options.postgresStore.readDeviceCollectionHealth(deviceId, { organizationId }));
      return;
    }

    next();
  };
}

function parseChannelKindFilters(searchParams: URLSearchParams): string[] {
  const values = [
    ...searchParams.getAll("channelKind"),
    ...(searchParams.get("channelKinds")?.split(",") ?? []),
  ].map((value) => value.trim()).filter(Boolean);
  return Array.from(new Set(values));
}

async function createCollectorUpgradeOperation(
  options: RuntimeHttpApiHandlerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  deviceId: string,
  searchParams: URLSearchParams,
): Promise<void> {
  const session = await authorizeUserRead(options, request, response);
  if (session === null) return;
  if (!session) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (!options.postgresStore || !options.operationStore) {
    sendJson(response, 503, { error: "operation_store_unavailable" });
    return;
  }

  const organizationId = resolveRequestedOrganizationId(searchParams, session);
  if (!organizationId || organizationId === null) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  if (!canManageCollectorUpgrade(session, organizationId)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  const fleet = await options.postgresStore.readRuntimeFleet({ organizationId });
  const device = fleet.devices.find((candidate) => candidate.id === deviceId);
  if (!device) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  const manifest = await createCollectorPackageManifest();
  const connection = options.store.readDeviceConnection(deviceId);
  const currentVersion = connection?.collectorVersion ?? readDeviceCollectorVersion(device);
  const targetVersion = manifest.version;
  const operation = await options.operationStore.createOperation({
    metadata: {
      currentVersion,
      deviceId,
      requestedManifestVersion: manifest.version,
      targetVersion,
    },
    organizationId,
    requestedByUserId: readSessionUserId(session),
    resourceId: deviceId,
    resourceType: "device",
    summary: `Upgrade collector on ${deviceId} to ${targetVersion}`,
    targetId: targetVersion,
    targetType: "collector",
    type: "collector_upgrade",
  });
  const deadlineAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const job = await options.operationStore.enqueueJob({
    maxAttempts: 3,
    operationId: operation.id,
    organizationId,
    payload: {
      currentVersion,
      deadlineAt,
      deviceId,
      nonce: `upgrade_${randomUUID()}`,
      requestedManifestVersion: manifest.version,
      stage: "queued",
      status: "running",
      targetVersion,
    },
    type: "collector_upgrade_device",
  });

  const currentVersionIsLatest = currentVersion
    ? compareCollectorVersions(currentVersion, targetVersion) >= 0
    : false;
  if (currentVersionIsLatest) {
    await options.operationStore.completeExternalJob({
      jobId: job.id,
      now: new Date(),
      payloadPatch: {
        collectorVersion: currentVersion,
        message: "Collector already at target version",
        stage: "succeeded",
        status: "succeeded",
      },
      status: "succeeded",
    });
    sendJson(response, 200, {
      jobId: job.id,
      operationId: operation.id,
      status: "succeeded",
      targetVersion,
    });
    return;
  }

  const manualInstruction = manualCollectorUpgradeInstruction(connection, manifest.minUpgradeProtocolVersion);
  if (manualInstruction) {
    await options.operationStore.completeExternalJob({
      jobId: job.id,
      manualInstruction,
      now: new Date(),
      payloadPatch: {
        message: manualInstruction,
        stage: "failed",
        status: "requires_manual_step",
      },
      status: "requires_manual_step",
    });
    sendJson(response, 202, {
      jobId: job.id,
      operationId: operation.id,
      status: "requires_manual_step",
      targetVersion,
    });
    return;
  }

  sendJson(response, 202, {
    jobId: job.id,
    operationId: operation.id,
    status: "queued" satisfies OperationStatus,
    targetVersion,
  });
}

interface AgentSkillProbeSnapshotContext {
  targetAgentId: string;
  targetAgentName?: string;
  deviceId: string;
  runtimeId: string;
  runtimeName?: string;
}

interface RuntimeSkillProbeSnapshotContext {
  deviceId: string;
  runtimeId: string;
  runtimeKind: string;
}

async function readAgentSkillProbeSnapshot(
  options: RuntimeHttpApiHandlerOptions,
  agentId: string,
  organizationId?: string,
): Promise<AgentSkillProbeSnapshot> {
  const postgresSnapshot = await options.postgresStore?.readAgentSkillProbeSnapshot(agentId, { organizationId }).catch(() => null);
  const storeSnapshot = options.store.readAgentSkillProbeSnapshot(agentId);
  if (postgresSnapshot) return postgresSnapshot;
  if (storeSnapshot && (!organizationId || !options.postgresStore)) return storeSnapshot;
  try {
    const context = await resolveAgentSkillProbeSnapshotContext(options, agentId, organizationId);
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

async function readRuntimeSkillProbeSnapshot(
  options: RuntimeHttpApiHandlerOptions,
  runtimeId: string,
  organizationId?: string,
): Promise<RuntimeSkillSnapshot> {
  const postgresSnapshot = await options.postgresStore?.readRuntimeSkillProbeSnapshot(runtimeId, { organizationId }).catch(() => null);
  const storeSnapshot = options.store.readRuntimeSkillProbeSnapshot(runtimeId);
  if (postgresSnapshot) return postgresSnapshot;
  if (storeSnapshot && (!organizationId || !options.postgresStore)) return storeSnapshot;
  try {
    const context = await resolveRuntimeSkillProbeSnapshotContext(options, runtimeId, organizationId);
    return createRuntimeSkillProbeSnapshot(context, "unknown");
  } catch {
    return {
      deviceId: "unknown",
      runtimeId,
      runtimeKind: "unknown",
      status: "unknown",
      observedAt: null,
      summary: {
        total: 0,
        runtimeScopeCount: 0,
        agentScopeCount: 0,
        availableCount: 0,
        unavailableCount: 0,
        builtInCount: 0,
      },
      skills: [],
    };
  }
}

async function resolveAgentSkillProbeSnapshotContext(
  options: RuntimeHttpApiHandlerOptions,
  agentId: string,
  organizationId?: string,
): Promise<AgentSkillProbeSnapshotContext> {
  const fleet = await readRuntimeFleetForProbe(options, organizationId);
  const agent = fleet.agents.find((candidate) => candidate.id === agentId);
  const runtime = fleet.runtimes.find((candidate) => candidate.id === agent?.runtimeId);
  const device = fleet.devices.find((candidate) => candidate.id === runtime?.deviceId);
  const runtimeId = runtime?.id;
  const deviceId = device?.id;
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

async function resolveRuntimeSkillProbeSnapshotContext(
  options: RuntimeHttpApiHandlerOptions,
  runtimeId: string,
  organizationId?: string,
): Promise<RuntimeSkillProbeSnapshotContext> {
  const fleet = await readRuntimeFleetForProbe(options, organizationId);
  const runtime = fleet.runtimes.find((candidate) => candidate.id === runtimeId);
  const device = fleet.devices.find((candidate) => candidate.id === runtime?.deviceId);
  if (!runtime) throw new Error("runtime is required for skill probe");
  if (!device) throw new Error("device is required for skill probe");
  return {
    deviceId: device.id,
    runtimeId,
    runtimeKind: runtime.kind,
  };
}

async function readRuntimeFleetForProbe(options: RuntimeHttpApiHandlerOptions, organizationId?: string): Promise<{
  devices: Array<{ id: string }>;
  runtimes: Array<{ id: string; deviceId: string; kind: string; name?: string }>;
  agents: Array<{ id: string; name?: string; runtimeId: string }>;
}> {
  const postgresFleet = await options.postgresStore?.readRuntimeFleet({ organizationId }).catch(() => null);
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
  context: AgentSkillProbeSnapshotContext,
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

function createRuntimeSkillProbeSnapshot(
  context: RuntimeSkillProbeSnapshotContext,
  status: RuntimeSkillProbeStatus,
): RuntimeSkillSnapshot {
  return {
    deviceId: context.deviceId,
    runtimeId: context.runtimeId,
    runtimeKind: context.runtimeKind,
    status,
    observedAt: status === "unknown" ? null : new Date().toISOString(),
    summary: {
      total: 0,
      runtimeScopeCount: 0,
      agentScopeCount: 0,
      availableCount: 0,
      unavailableCount: 0,
      builtInCount: 0,
    },
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

async function persistRuntimeSkillProbeSnapshot(
  options: RuntimeHttpApiHandlerOptions,
  value: unknown,
): Promise<RuntimeSkillSnapshot> {
  const snapshot = options.store.writeRuntimeSkillProbeSnapshot(value);
  await options.postgresStore?.upsertRuntimeSkillProbeSnapshot(snapshot).catch(() => undefined);
  return snapshot;
}

async function persistRuntimeScheduleProbeSnapshot(
  options: RuntimeHttpApiHandlerOptions,
  value: unknown,
): Promise<RuntimeScheduleProbeSnapshot> {
  const snapshot = options.store.writeRuntimeScheduleProbeSnapshot(value);
  await options.postgresStore?.upsertRuntimeScheduleProbeSnapshot(snapshot).catch(() => undefined);
  return snapshot;
}

function readString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const candidate = value[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function enrichDeviceStateSnapshotWithRequestNetwork(value: unknown, request: IncomingMessage): unknown {
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

function toCollectionHealthIngestions(
  rows: Array<{ snapshotType: CollectorSnapshotType } & Omit<CollectionHealthIngestion, "snapshotType">>,
): CollectionHealthIngestion[] {
  return rows
    .filter((row) => row.snapshotType === "device_state")
    .map((row) => ({
      ...row,
      snapshotType: row.snapshotType as CollectionHealthIngestion["snapshotType"],
    }));
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
): Promise<unknown | null> {
  if (!options.auth?.requireUserSession) return undefined;
  const session = await options.auth.requireUserSession(request);
  if (session) return session;
  sendJson(response, 401, { error: "unauthorized" });
  return null;
}

async function authorizeOrganizationRead(
  options: RuntimeHttpApiHandlerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  searchParams: URLSearchParams,
): Promise<RuntimeOrganizationId | null> {
  const session = await authorizeUserRead(options, request, response);
  if (session === null) return null;
  const organizationId = resolveRequestedOrganizationId(searchParams, session);
  if (organizationId === null) {
    sendJson(response, 403, { error: "forbidden" });
    return null;
  }
  return organizationId;
}

function resolveRequestedOrganizationId(searchParams: URLSearchParams, session: unknown): RuntimeOrganizationId | null {
  const requestedOrganizationId = searchParams.get("organizationId")?.trim() || undefined;
  const memberships = listSessionOrganizationIds(session);
  if (!memberships.length) return requestedOrganizationId;
  if (!requestedOrganizationId) return memberships[0];
  return memberships.includes(requestedOrganizationId) ? requestedOrganizationId : null;
}

function listSessionOrganizationIds(session: unknown): string[] {
  if (!session || typeof session !== "object") return [];
  const organizations = (session as RuntimeUserSessionLike).organizations;
  if (!Array.isArray(organizations)) return [];
  return organizations
    .map((organization) => organization.organizationId)
    .filter((organizationId): organizationId is string => typeof organizationId === "string" && Boolean(organizationId.trim()))
    .map((organizationId) => organizationId.trim());
}

function canManageCollectorUpgrade(session: unknown, organizationId: string): boolean {
  const membership = readSessionOrganizationMembership(session, organizationId);
  return membership?.role === "owner" || membership?.role === "admin";
}

function readSessionOrganizationMembership(
  session: unknown,
  organizationId: string,
): { organizationId: string; role?: string } | null {
  if (!session || typeof session !== "object") return null;
  const organizations = (session as RuntimeUserSessionLike).organizations;
  if (!Array.isArray(organizations)) return null;
  const membership = organizations.find((candidate) => candidate.organizationId === organizationId);
  if (!membership || typeof membership.organizationId !== "string") return null;
  return {
    organizationId: membership.organizationId,
    ...(typeof membership.role === "string" ? { role: membership.role } : {}),
  };
}

function readSessionUserId(session: unknown): string | null {
  if (!session || typeof session !== "object") return null;
  const user = (session as RuntimeUserSessionLike).user;
  return typeof user?.id === "string" && user.id.trim() ? user.id : null;
}

function readDeviceCollectorVersion(device: unknown): string | undefined {
  if (!isRecord(device)) return undefined;
  const collector = device.collector;
  if (!isRecord(collector)) return undefined;
  return typeof collector.version === "string" && collector.version.trim() ? collector.version : undefined;
}

function manualCollectorUpgradeInstruction(
  connection: ReturnType<RuntimeDeviceStateStore["readDeviceConnection"]>,
  minUpgradeProtocolVersion: number,
): string | null {
  if (!connection || connection.status !== "online") {
    return "设备当前不在线，请先让 collector 连接服务端，或手动重装支持升级协议的 collector。";
  }
  if (!connection.collectorUpgrade?.supported) {
    return "当前 collector 未声明自升级能力，请先手动重装支持升级协议的 collector。";
  }
  if (connection.collectorUpgrade.protocolVersion < minUpgradeProtocolVersion) {
    return "当前 collector 升级协议版本过旧，请先手动重装最新版 collector。";
  }
  return null;
}

async function authorizeDeviceWrite(
  options: RuntimeHttpApiHandlerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  deviceId?: string | null,
): Promise<unknown | null> {
  if (!options.auth?.requireDeviceToken && !options.auth?.verifyDeviceTokenValue) return undefined;
  const bearerToken = readBearerToken(request);
  const deviceToken = options.auth.verifyDeviceTokenValue && bearerToken
    ? await options.auth.verifyDeviceTokenValue(bearerToken, deviceId)
    : await options.auth.requireDeviceToken?.(request);
  if (deviceToken) return deviceToken;
  sendJson(response, 401, { error: "invalid_device_token" });
  return null;
}

function readBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || null;
  }
  return null;
}

async function recordFailedCollectorIngestion(
  options: RuntimeHttpApiHandlerOptions,
  snapshotType: CollectorSnapshotType,
  body: unknown,
  error: unknown,
  organizationId?: string,
): Promise<void> {
  if (!options.postgresStore) return;
  const errorResponse = createErrorResponse(error, fallbackErrorCodeForSnapshotType(snapshotType));
  await options.postgresStore.recordFailedCollectorIngestion({
    deviceId: extractDeviceId(snapshotType, body),
    error: `${errorResponse.error}: ${errorResponse.message}`,
    collectedAt: extractCollectedAt(body),
    organizationId,
    snapshotType,
  }).catch(() => undefined);
}

function logCollectorIngestionFailure(
  options: RuntimeHttpApiHandlerOptions,
  snapshotType: CollectorSnapshotType,
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
  snapshotType: CollectorSnapshotType,
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
  const label = labelForSnapshotType(snapshotType);
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

function extractDeviceId(snapshotType: CollectorSnapshotType, body: unknown): string {
  void snapshotType;
  if (!body || typeof body !== "object") return "unknown";
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.deviceId === "string" && candidate.deviceId.trim()) return candidate.deviceId;
  const device = candidate.device;
  if (device && typeof device === "object" && typeof (device as Record<string, unknown>).id === "string") {
    return (device as Record<string, string>).id;
  }
  return "unknown";
}

function fallbackErrorCodeForSnapshotType(snapshotType: CollectorSnapshotType): string {
  void snapshotType;
  if (snapshotType === "device_state") return "invalid_device_state_snapshot";
  if (snapshotType === "task_batch") return "invalid_runtime_task_batch";
  return "invalid_device_state_snapshot";
}

function labelForSnapshotType(snapshotType: CollectorSnapshotType): string {
  void snapshotType;
  if (snapshotType === "device_state") return "设备状态";
  if (snapshotType === "task_batch") return "任务批量";
  return "设备状态";
}

function extractCollectedAt(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const collectedAt = (body as Record<string, unknown>).collectedAt;
  return typeof collectedAt === "string" ? collectedAt : undefined;
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
