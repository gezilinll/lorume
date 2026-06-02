import type { CollectorUpgradeProgressMessage, CollectorUpgradeRequestMessage } from "../server/runtime-control-channel";
import type { OperationJobHandler, OperationJobHandlerResult } from "./job-runner";
import type { OperationJobRow, OperationStore } from "./operation-store";

export interface CollectorUpgradeDispatchOptions {
  readonly backendBaseUrl: string | (() => string);
  readonly controlChannel: Pick<{
    sendCollectorUpgradeRequest: (message: CollectorUpgradeRequestMessage) => boolean;
  }, "sendCollectorUpgradeRequest">;
  readonly operationStore: Pick<OperationStore, "completeExternalJob" | "updateJobPayload">;
  readonly now?: () => Date;
}

export interface CollectorUpgradeProgressOptions {
  readonly operationStore: Pick<OperationStore, "completeExternalJob" | "listJobs" | "updateJobPayload">;
  readonly now?: () => Date;
}

export interface CollectorUpgradeCompletionOptions {
  readonly operationStore: Pick<OperationStore, "completeExternalJob" | "listJobs">;
  readonly now?: () => Date;
}

export type CollectorUpgradeProgressResult =
  | { readonly status: "updated" }
  | { readonly status: "completed" }
  | { readonly status: "ignored" };

export function createCollectorUpgradeJobHandler(options: CollectorUpgradeDispatchOptions): OperationJobHandler {
  return (job) => dispatchCollectorUpgradeJob(options, job);
}

export async function dispatchCollectorUpgradeJob(
  options: CollectorUpgradeDispatchOptions,
  job: OperationJobRow,
): Promise<OperationJobHandlerResult> {
  const payload = requireUpgradeJobPayload(job);
  const now = options.now ?? (() => new Date());
  const currentTime = now();
  if (Date.parse(payload.deadlineAt) <= currentTime.getTime()) {
    await options.operationStore.completeExternalJob({
      errorSummary: "Collector upgrade deadline elapsed",
      jobId: job.id,
      now: currentTime,
      payloadPatch: {
        deadlineAt: payload.deadlineAt,
        failedAt: currentTime.toISOString(),
        message: "Collector upgrade deadline elapsed",
        stage: "failed",
        status: "failed",
      },
      status: "failed",
    });
    return { status: "external_running" };
  }
  const origin = new URL(typeof options.backendBaseUrl === "function" ? options.backendBaseUrl() : options.backendBaseUrl).origin;
  const request: CollectorUpgradeRequestMessage = {
    currentVersion: payload.currentVersion,
    deadlineAt: payload.deadlineAt,
    deviceId: payload.deviceId,
    jobId: job.id,
    manifestUrl: `${origin}/api/device-collector/manifest.json`,
    nonce: payload.nonce,
    operationId: job.operationId,
    packageBaseUrl: `${origin}/api/device-collector/files`,
    protocolVersion: 1,
    targetVersion: payload.targetVersion,
  };

  if (!options.controlChannel.sendCollectorUpgradeRequest(request)) {
    throw new Error("collector upgrade request was not accepted by the device socket");
  }

  await options.operationStore.updateJobPayload({
    jobId: job.id,
    now: currentTime,
    payloadPatch: {
      dispatchedAt: currentTime.toISOString(),
      message: "Collector upgrade request dispatched",
      stage: "dispatched",
      status: "running",
    },
  });
  return { status: "external_running" };
}

export async function applyCollectorUpgradeProgress(
  options: CollectorUpgradeProgressOptions,
  progress: CollectorUpgradeProgressMessage,
): Promise<CollectorUpgradeProgressResult> {
  const now = options.now ?? (() => new Date());
  const job = await readMatchingUpgradeJob(options.operationStore, progress);
  if (!job) return { status: "ignored" };

  const patch = progressPayloadPatch(progress, now().toISOString());
  if (progress.status === "running") {
    await options.operationStore.updateJobPayload({
      jobId: job.id,
      now: now(),
      payloadPatch: patch,
    });
    return { status: "updated" };
  }

  if (progress.status === "failed" || progress.status === "requires_manual_step") {
    await options.operationStore.completeExternalJob({
      errorSummary: progress.message ?? "Collector upgrade failed",
      jobId: job.id,
      manualInstruction: progress.status === "requires_manual_step" ? progress.message : undefined,
      now: now(),
      payloadPatch: patch,
      status: progress.status,
    });
    return { status: "completed" };
  }

  const payload = asRecord(job.payload);
  const targetVersion = readString(payload.targetVersion) ?? progress.targetVersion;
  const reportedVersion = progress.collectorVersion ?? progress.currentVersion;
  if (progress.status === "succeeded" && targetVersion && reportedVersion === targetVersion) {
    await options.operationStore.completeExternalJob({
      jobId: job.id,
      now: now(),
      payloadPatch: {
        ...patch,
        collectorVersion: reportedVersion,
        stage: "succeeded",
        status: "succeeded",
      },
      status: "succeeded",
    });
    return { status: "completed" };
  }

  await options.operationStore.updateJobPayload({
    jobId: job.id,
    now: now(),
    payloadPatch: patch,
  });
  return { status: "updated" };
}

export async function completeCollectorUpgradeFromCollectorVersion(
  options: CollectorUpgradeCompletionOptions,
  input: {
    readonly collectorVersion: string;
    readonly deviceId: string;
    readonly jobId: string;
    readonly operationId: string;
  },
): Promise<CollectorUpgradeProgressResult> {
  const now = options.now ?? (() => new Date());
  const job = await readUpgradeJobById(options.operationStore, input.operationId, input.jobId);
  if (!job) return { status: "ignored" };
  const payload = asRecord(job.payload);
  if (readString(payload.deviceId) !== input.deviceId) return { status: "ignored" };
  const targetVersion = readString(payload.targetVersion);
  if (!targetVersion || input.collectorVersion !== targetVersion) return { status: "ignored" };

  await options.operationStore.completeExternalJob({
    jobId: job.id,
    now: now(),
    payloadPatch: {
      collectorVersion: input.collectorVersion,
      reconnectedAt: now().toISOString(),
      stage: "succeeded",
      status: "succeeded",
    },
    status: "succeeded",
  });
  return { status: "completed" };
}

function requireUpgradeJobPayload(job: OperationJobRow): {
  currentVersion?: string;
  deadlineAt: string;
  deviceId: string;
  nonce: string;
  targetVersion: string;
} {
  const payload = asRecord(job.payload);
  const deviceId = readString(payload.deviceId);
  const targetVersion = readString(payload.targetVersion);
  const nonce = readString(payload.nonce);
  const deadlineAt = readString(payload.deadlineAt);
  if (!deviceId || !targetVersion || !nonce || !deadlineAt) {
    throw new Error("collector upgrade job payload is incomplete");
  }
  return {
    currentVersion: readString(payload.currentVersion),
    deadlineAt,
    deviceId,
    nonce,
    targetVersion,
  };
}

async function readMatchingUpgradeJob(
  operationStore: Pick<OperationStore, "listJobs">,
  progress: CollectorUpgradeProgressMessage,
): Promise<OperationJobRow | null> {
  const job = await readUpgradeJobById(operationStore, progress.operationId, progress.jobId);
  if (!job) return null;
  const payload = asRecord(job.payload);
  if (readString(payload.deviceId) !== progress.deviceId) return null;
  if (readString(payload.nonce) !== progress.nonce) return null;
  return job;
}

async function readUpgradeJobById(
  operationStore: Pick<OperationStore, "listJobs">,
  operationId: string,
  jobId: string,
): Promise<OperationJobRow | null> {
  const jobs = await operationStore.listJobs({ operationId, limit: 100 });
  return jobs.find((job) => job.id === jobId && job.type === "collector_upgrade_device") ?? null;
}

function progressPayloadPatch(progress: CollectorUpgradeProgressMessage, fallbackObservedAt: string): Record<string, unknown> {
  return {
    deviceId: progress.deviceId,
    jobId: progress.jobId,
    nonce: progress.nonce,
    operationId: progress.operationId,
    observedAt: progress.observedAt ?? fallbackObservedAt,
    stage: progress.stage,
    status: progress.status,
    ...(progress.collectorVersion ? { collectorVersion: progress.collectorVersion } : {}),
    ...(progress.currentVersion ? { currentVersion: progress.currentVersion } : {}),
    ...(progress.targetVersion ? { targetVersion: progress.targetVersion } : {}),
    ...(progress.message ? { message: progress.message } : {}),
    ...(progress.errorCode ? { errorCode: progress.errorCode } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
