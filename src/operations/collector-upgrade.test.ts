import { describe, expect, it } from "vitest";
import type { CollectorUpgradeRequestMessage } from "../server/runtime-control-channel";
import { applyCollectorUpgradeProgress, completeCollectorUpgradeFromCollectorVersion, dispatchCollectorUpgradeJob } from "./collector-upgrade";
import type { OperationJobRow, OperationStore } from "./operation-store";

describe("collector upgrade orchestration", () => {
  it("dispatches a collector upgrade request and leaves the job externally running", async () => {
    const job = createUpgradeJob({
      payload: {
        currentVersion: "0.1.0",
        deadlineAt: "2026-06-02T09:05:00.000Z",
        deviceId: "fixture-mac",
        nonce: "upgrade_nonce",
        stage: "queued",
        targetVersion: "0.1.2",
      },
    });
    const store = createFakeStore([job]);
    const sentMessages: CollectorUpgradeRequestMessage[] = [];

    const result = await dispatchCollectorUpgradeJob({
      backendBaseUrl: "https://lorume.test",
      controlChannel: {
        sendCollectorUpgradeRequest: (message) => {
          sentMessages.push(message);
          return true;
        },
      },
      now: () => new Date("2026-06-02T09:00:00.000Z"),
      operationStore: store,
    }, job);

    expect(result).toEqual({ status: "external_running" });
    expect(sentMessages).toEqual([
      {
        currentVersion: "0.1.0",
        deadlineAt: "2026-06-02T09:05:00.000Z",
        deviceId: "fixture-mac",
        jobId: "opjob_upgrade",
        manifestUrl: "https://lorume.test/api/device-collector/manifest.json",
        nonce: "upgrade_nonce",
        operationId: "op_upgrade",
        packageBaseUrl: "https://lorume.test/api/device-collector/files",
        protocolVersion: 1,
        targetVersion: "0.1.2",
      },
    ]);
    expect(store.payloadUpdates).toEqual([
      expect.objectContaining({
        jobId: "opjob_upgrade",
        payloadPatch: expect.objectContaining({
          dispatchedAt: "2026-06-02T09:00:00.000Z",
          message: "Collector upgrade request dispatched",
          stage: "dispatched",
        }),
      }),
    ]);
    expect(store.completedExternal).toEqual([]);
  });

  it("fails dispatch when the device socket cannot accept the request", async () => {
    const job = createUpgradeJob({
      payload: {
        currentVersion: "0.1.0",
        deadlineAt: "2026-06-02T09:05:00.000Z",
        deviceId: "fixture-mac",
        nonce: "upgrade_nonce",
        targetVersion: "0.1.2",
      },
    });
    const store = createFakeStore([job]);

    await expect(dispatchCollectorUpgradeJob({
      backendBaseUrl: "https://lorume.test",
      controlChannel: { sendCollectorUpgradeRequest: () => false },
      now: () => new Date("2026-06-02T09:00:00.000Z"),
      operationStore: store,
    }, job)).rejects.toThrow("collector upgrade request was not accepted by the device socket");
    expect(store.payloadUpdates).toEqual([]);
  });

  it("expires a collector upgrade job when its deadline has elapsed before redispatch", async () => {
    const job = createUpgradeJob({
      payload: {
        currentVersion: "0.1.0",
        deadlineAt: "2026-06-02T09:05:00.000Z",
        deviceId: "fixture-mac",
        nonce: "upgrade_nonce",
        stage: "restart_pending",
        targetVersion: "0.1.2",
      },
    });
    const store = createFakeStore([job]);
    const sentMessages: CollectorUpgradeRequestMessage[] = [];

    const result = await dispatchCollectorUpgradeJob({
      backendBaseUrl: "https://lorume.test",
      controlChannel: {
        sendCollectorUpgradeRequest: (message) => {
          sentMessages.push(message);
          return true;
        },
      },
      now: () => new Date("2026-06-02T09:06:00.000Z"),
      operationStore: store,
    }, job);

    expect(result).toEqual({ status: "external_running" });
    expect(sentMessages).toEqual([]);
    expect(store.completedExternal).toEqual([
      expect.objectContaining({
        errorSummary: "Collector upgrade deadline elapsed",
        jobId: "opjob_upgrade",
        payloadPatch: expect.objectContaining({
          deadlineAt: "2026-06-02T09:05:00.000Z",
          stage: "failed",
          status: "failed",
        }),
        status: "failed",
      }),
    ]);
  });

  it("applies running progress to the job payload without completing it", async () => {
    const job = createUpgradeJob({
      payload: {
        deviceId: "fixture-mac",
        nonce: "upgrade_nonce",
        stage: "dispatched",
        targetVersion: "0.1.2",
      },
    });
    const store = createFakeStore([job]);

    const result = await applyCollectorUpgradeProgress({
      now: () => new Date("2026-06-02T09:01:00.000Z"),
      operationStore: store,
    }, {
      currentVersion: "0.1.0",
      deviceId: "fixture-mac",
      jobId: "opjob_upgrade",
      message: "Downloading collector package",
      nonce: "upgrade_nonce",
      operationId: "op_upgrade",
      protocolVersion: 1,
      stage: "downloading",
      status: "running",
      targetVersion: "0.1.2",
    });

    expect(result).toEqual({ status: "updated" });
    expect(store.payloadUpdates).toEqual([
      expect.objectContaining({
        jobId: "opjob_upgrade",
        payloadPatch: expect.objectContaining({
          currentVersion: "0.1.0",
          message: "Downloading collector package",
          observedAt: "2026-06-02T09:01:00.000Z",
          stage: "downloading",
          status: "running",
          targetVersion: "0.1.2",
        }),
      }),
    ]);
    expect(store.completedExternal).toEqual([]);
  });

  it("completes a failed progress message externally", async () => {
    const job = createUpgradeJob({
      payload: {
        deviceId: "fixture-mac",
        nonce: "upgrade_nonce",
        targetVersion: "0.1.2",
      },
    });
    const store = createFakeStore([job]);

    const result = await applyCollectorUpgradeProgress({
      now: () => new Date("2026-06-02T09:02:00.000Z"),
      operationStore: store,
    }, {
      deviceId: "fixture-mac",
      errorCode: "hash_mismatch",
      jobId: "opjob_upgrade",
      message: "Hash mismatch",
      nonce: "upgrade_nonce",
      operationId: "op_upgrade",
      protocolVersion: 1,
      stage: "failed",
      status: "failed",
      targetVersion: "0.1.2",
    });

    expect(result).toEqual({ status: "completed" });
    expect(store.completedExternal).toEqual([
      expect.objectContaining({
        errorSummary: "Hash mismatch",
        jobId: "opjob_upgrade",
        payloadPatch: expect.objectContaining({
          errorCode: "hash_mismatch",
          stage: "failed",
          status: "failed",
        }),
        status: "failed",
      }),
    ]);
  });

  it("completes after reconnect when the collector reports the target version", async () => {
    const job = createUpgradeJob({
      payload: {
        deviceId: "fixture-mac",
        nonce: "upgrade_nonce",
        stage: "restart_pending",
        targetVersion: "0.1.2",
      },
    });
    const store = createFakeStore([job]);

    const oldVersion = await completeCollectorUpgradeFromCollectorVersion({
      now: () => new Date("2026-06-02T09:03:00.000Z"),
      operationStore: store,
    }, {
      collectorVersion: "0.1.0",
      deviceId: "fixture-mac",
      jobId: "opjob_upgrade",
      operationId: "op_upgrade",
    });
    const targetVersion = await completeCollectorUpgradeFromCollectorVersion({
      now: () => new Date("2026-06-02T09:03:30.000Z"),
      operationStore: store,
    }, {
      collectorVersion: "0.1.2",
      deviceId: "fixture-mac",
      jobId: "opjob_upgrade",
      operationId: "op_upgrade",
    });

    expect(oldVersion).toEqual({ status: "ignored" });
    expect(targetVersion).toEqual({ status: "completed" });
    expect(store.completedExternal).toEqual([
      expect.objectContaining({
        jobId: "opjob_upgrade",
        payloadPatch: expect.objectContaining({
          collectorVersion: "0.1.2",
          reconnectedAt: "2026-06-02T09:03:30.000Z",
          stage: "succeeded",
          status: "succeeded",
        }),
        status: "succeeded",
      }),
    ]);
  });
});

function createUpgradeJob(input: Partial<OperationJobRow>): OperationJobRow {
  const now = new Date("2026-06-02T09:00:00.000Z");
  return {
    attemptCount: 1,
    createdAt: now,
    finishedAt: null,
    id: "opjob_upgrade",
    lastErrorSummary: null,
    lockedBy: "upgrade-runner",
    lockedUntil: new Date("2026-06-02T09:01:00.000Z"),
    maxAttempts: 1,
    operationId: "op_upgrade",
    organizationId: "org_1",
    payload: {},
    runAfter: now,
    startedAt: now,
    status: "running",
    type: "collector_upgrade_device",
    updatedAt: now,
    ...input,
  };
}

function createFakeStore(jobs: OperationJobRow[]): Pick<
  OperationStore,
  "completeExternalJob" | "listJobs" | "updateJobPayload"
> & {
  completedExternal: unknown[];
  payloadUpdates: unknown[];
} {
  return {
    completedExternal: [],
    payloadUpdates: [],
    async completeExternalJob(input) {
      this.completedExternal.push(input);
      return jobs.find((job) => job.id === input.jobId) ?? null;
    },
    async listJobs(input) {
      return jobs.filter((job) => job.operationId === input.operationId);
    },
    async updateJobPayload(input) {
      this.payloadUpdates.push(input);
      const job = jobs.find((candidate) => candidate.id === input.jobId);
      if (!job) return null;
      job.payload = { ...job.payload, ...input.payloadPatch };
      return job;
    },
  };
}
