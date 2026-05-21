import type { CollectionHealthIngestion } from "./runtime-collection-health";

export type DeviceHealthStatus = "syncing" | "online" | "offline" | "abnormal";

export type DeviceHealthReason =
  | "first_sync_pending"
  | "first_sync_timeout"
  | "heartbeat_and_inventory_fresh"
  | "inventory_or_heartbeat_stale"
  | "last_inventory_failed"
  | "control_error";

export interface DeviceHealthConnection {
  deviceId: string;
  status: "online" | "stale" | "offline";
  connectedAt?: string;
  lastHeartbeatAt?: string;
  lastError?: string;
}

export interface DeviceHealthStatusInput {
  deviceId: string;
  now: Date;
  connection?: DeviceHealthConnection | null;
  inventoryIngestions: CollectionHealthIngestion[];
  firstSyncWindowMs?: number;
  heartbeatFreshMs?: number;
  inventoryFreshMs?: number;
}

export interface DeviceHealthStatusResult {
  deviceId: string;
  status: DeviceHealthStatus;
  label: "同步中" | "在线" | "离线" | "异常";
  reason: DeviceHealthReason;
  message: string;
  lastHeartbeatAt?: string;
  lastInventorySuccessAt?: string;
  lastInventoryFailureAt?: string;
}

const defaultFirstSyncWindowMs = 120_000;
const defaultHeartbeatFreshMs = 90_000;
const defaultInventoryFreshMs = 300_000;

const labels: Record<DeviceHealthStatus, DeviceHealthStatusResult["label"]> = {
  syncing: "同步中",
  online: "在线",
  offline: "离线",
  abnormal: "异常",
};

/** Derive the user-visible Device status from connection freshness and inventory ingestion only. */
export function deriveDeviceHealthStatus(input: DeviceHealthStatusInput): DeviceHealthStatusResult {
  const firstSyncWindowMs = input.firstSyncWindowMs ?? defaultFirstSyncWindowMs;
  const heartbeatFreshMs = input.heartbeatFreshMs ?? defaultHeartbeatFreshMs;
  const inventoryFreshMs = input.inventoryFreshMs ?? defaultInventoryFreshMs;
  const latestInventory = latestInventoryIngestion(input.inventoryIngestions);
  const latestSuccess = latestSucceededInventory(input.inventoryIngestions);
  const lastHeartbeatAt = input.connection?.lastHeartbeatAt;

  if (input.connection?.lastError) {
    return result(input, "abnormal", "control_error", "设备连接出现异常", {
      lastHeartbeatAt,
      lastInventorySuccessAt: receivedAt(latestSuccess),
      lastInventoryFailureAt: latestInventory?.status === "failed" ? receivedAt(latestInventory) : undefined,
    });
  }

  if (latestInventory?.status === "failed") {
    return result(input, "abnormal", "last_inventory_failed", "最近一次设备资产采集失败", {
      lastHeartbeatAt,
      lastInventorySuccessAt: receivedAt(latestSuccess),
      lastInventoryFailureAt: receivedAt(latestInventory),
    });
  }

  if (!latestSuccess) {
    if (isFirstSyncTimedOut(input.connection?.connectedAt, input.now, firstSyncWindowMs)) {
      return result(input, "abnormal", "first_sync_timeout", "设备连接后仍未完成首次同步", {
        lastHeartbeatAt,
      });
    }
    return result(input, "syncing", "first_sync_pending", "等待设备完成首次同步", {
      lastHeartbeatAt,
    });
  }

  const heartbeatFresh = isFresh(lastHeartbeatAt, input.now, heartbeatFreshMs);
  const inventoryFresh = isFresh(receivedAt(latestSuccess), input.now, inventoryFreshMs);
  if (heartbeatFresh && inventoryFresh) {
    return result(input, "online", "heartbeat_and_inventory_fresh", "设备在线且采集正常", {
      lastHeartbeatAt,
      lastInventorySuccessAt: receivedAt(latestSuccess),
    });
  }

  return result(input, "offline", "inventory_or_heartbeat_stale", "设备最近未保持在线同步", {
    lastHeartbeatAt,
    lastInventorySuccessAt: receivedAt(latestSuccess),
  });
}

function result(
  input: DeviceHealthStatusInput,
  status: DeviceHealthStatus,
  reason: DeviceHealthReason,
  message: string,
  times: Pick<DeviceHealthStatusResult, "lastHeartbeatAt" | "lastInventorySuccessAt" | "lastInventoryFailureAt"> = {},
): DeviceHealthStatusResult {
  return {
    deviceId: input.deviceId,
    status,
    label: labels[status],
    reason,
    message,
    ...times,
  };
}

function latestInventoryIngestion(ingestions: CollectionHealthIngestion[]): CollectionHealthIngestion | undefined {
  return ingestions
    .filter((ingestion) => ingestion.snapshotType === "inventory")
    .sort((left, right) => Date.parse(receivedAt(right) ?? "") - Date.parse(receivedAt(left) ?? ""))[0];
}

function latestSucceededInventory(ingestions: CollectionHealthIngestion[]): CollectionHealthIngestion | undefined {
  return ingestions
    .filter((ingestion) => ingestion.snapshotType === "inventory" && ingestion.status === "succeeded")
    .sort((left, right) => Date.parse(receivedAt(right) ?? "") - Date.parse(receivedAt(left) ?? ""))[0];
}

function receivedAt(ingestion: CollectionHealthIngestion | undefined): string | undefined {
  if (!ingestion) return undefined;
  const value = ingestion.receivedAt;
  return value instanceof Date ? value.toISOString() : value;
}

function isFresh(value: string | undefined, now: Date, maxAgeMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp <= maxAgeMs;
}

function isFirstSyncTimedOut(
  connectedAt: string | undefined,
  now: Date,
  firstSyncWindowMs: number,
): boolean {
  if (!connectedAt) return false;
  const timestamp = Date.parse(connectedAt);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp > firstSyncWindowMs;
}
