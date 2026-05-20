/** Snapshot types that the device collector reports independently. */
export type CollectionHealthSnapshotType = "inventory" | "work_state";

/** Product-level collection health used by backend diagnostics and Runtime Fleet status folding. */
export type CollectionHealthStatus = "healthy" | "failed";

/** Human-readable labels for collection health states. */
export const collectionHealthStatusLabels: Record<CollectionHealthStatus, string> = {
  healthy: "正常",
  failed: "异常",
};

/** Collector ingestion row needed to derive product-level collection health. */
export interface CollectionHealthIngestion {
  /** Device that produced the snapshot. */
  deviceId: string;
  /** Snapshot type persisted by the backend. */
  snapshotType: CollectionHealthSnapshotType;
  /** Whether backend accepted this ingestion. */
  status: "succeeded" | "failed";
  /** Device-side observation time when present. */
  observedAt: string | Date | null;
  /** Backend receive time. */
  receivedAt: string | Date;
  /** Object counts written by the ingestion. */
  counts: Record<string, number>;
  /** Adapter warnings captured without failing the ingestion. */
  warnings: string[];
  /** Error summary for failed ingestion. */
  error?: string | null;
}

/** One collection diagnostic check persisted for backend, logs, and status folding. */
export interface CollectionHealthCheck {
  /** Stable check id. */
  id: CollectionHealthSnapshotType;
  /** User-facing check label. */
  label: string;
  /** Product-level status for this check. */
  status: CollectionHealthStatus;
  /** Latest device observation time. */
  lastObservedAt?: string;
  /** Latest backend receive time. */
  lastReceivedAt?: string;
  /** Latest object counts for this snapshot type. */
  counts: Record<string, number>;
  /** Adapter warnings from the latest ingestion. */
  warnings: string[];
  /** Error summary from the latest failed ingestion. */
  error?: string | null;
  /** Short explanation suitable for the UI. */
  message: string;
}

/** Device-level collection diagnostic summary derived from collector ingestion history. */
export interface DeviceCollectionHealth {
  /** Device this health record belongs to. */
  deviceId: string;
  /** Worst relevant check status. */
  status: CollectionHealthStatus;
  /** User-facing summary for the whole device. */
  summary: string;
  /** Most recent observation time across checks. */
  lastObservedAt?: string;
  /** Most recent backend receive time across checks. */
  lastReceivedAt?: string;
  /** Individual inventory and work-state checks. */
  checks: CollectionHealthCheck[];
}

/** Options for deterministic tests and future policy tuning. */
export interface DeviceCollectionHealthOptions {
  /** Kept for caller compatibility; recency is displayed as data and does not create a separate status. */
  now?: Date;
  /** Kept for caller compatibility; recency is displayed as data and does not create a separate status. */
  staleAfterMs?: number;
}

const snapshotTypes: CollectionHealthSnapshotType[] = ["inventory", "work_state"];
const snapshotLabels: Record<CollectionHealthSnapshotType, string> = {
  inventory: "设备资产",
  work_state: "工作态",
};
const statusSeverity: Record<CollectionHealthStatus, number> = {
  healthy: 0,
  failed: 1,
};

/** Derive the product-level collection health for one device from raw ingestion rows. */
export function deriveDeviceCollectionHealth(
  deviceId: string,
  ingestions: CollectionHealthIngestion[],
  options: DeviceCollectionHealthOptions = {},
): DeviceCollectionHealth {
  void options;
  const checks = snapshotTypes.map((snapshotType) =>
    deriveCheck(snapshotType, latestIngestion(ingestions, snapshotType)),
  );
  const status = checks.reduce<CollectionHealthStatus>(
    (current, check) => statusSeverity[check.status] > statusSeverity[current] ? check.status : current,
    "healthy",
  );

  return {
    deviceId,
    status,
    summary: createSummary(checks),
    lastObservedAt: maxIso(checks.map((check) => check.lastObservedAt)),
    lastReceivedAt: maxIso(checks.map((check) => check.lastReceivedAt)),
    checks,
  };
}

function deriveCheck(
  snapshotType: CollectionHealthSnapshotType,
  ingestion: CollectionHealthIngestion | undefined,
): CollectionHealthCheck {
  const label = snapshotLabels[snapshotType];
  if (!ingestion) {
    return {
      id: snapshotType,
      label,
      status: "failed",
      counts: {},
      warnings: [],
      message: "尚未收到采集记录",
    };
  }

  const lastReceivedAt = toIso(ingestion.receivedAt);
  const lastObservedAt = toIso(ingestion.observedAt);
  if (ingestion.status === "failed") {
    return {
      id: snapshotType,
      label,
      status: "failed",
      lastObservedAt,
      lastReceivedAt,
      counts: ingestion.counts,
      warnings: ingestion.warnings,
      error: ingestion.error ?? null,
      message: "采集失败",
    };
  }

  if (ingestion.warnings.length > 0) {
    return {
      id: snapshotType,
      label,
      status: "healthy",
      lastObservedAt,
      lastReceivedAt,
      counts: ingestion.counts,
      warnings: ingestion.warnings,
      error: ingestion.error ?? null,
      message: `采集成功，但有 ${ingestion.warnings.length} 条警告`,
    };
  }

  return {
    id: snapshotType,
    label,
    status: "healthy",
    lastObservedAt,
    lastReceivedAt,
    counts: ingestion.counts,
    warnings: [],
    error: null,
    message: "采集正常",
  };
}

function latestIngestion(
  ingestions: CollectionHealthIngestion[],
  snapshotType: CollectionHealthSnapshotType,
): CollectionHealthIngestion | undefined {
  return ingestions
    .filter((ingestion) => ingestion.snapshotType === snapshotType)
    .sort((left, right) => Date.parse(toIso(right.receivedAt)) - Date.parse(toIso(left.receivedAt)))[0];
}

function createSummary(checks: CollectionHealthCheck[]): string {
  const worst = checks.reduce(
    (current, check) => statusSeverity[check.status] > statusSeverity[current.status] ? check : current,
    checks[0],
  );
  if (!worst || checks.every((check) => check.status === "healthy")) return "设备资产与工作态采集正常";
  return `${worst.label}${summarySuffix(worst.status)}`;
}

function summarySuffix(status: CollectionHealthStatus): string {
  if (status === "failed") return "采集失败";
  return "采集正常";
}

function toIso(value: string | Date | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : value;
}

function maxIso(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}
