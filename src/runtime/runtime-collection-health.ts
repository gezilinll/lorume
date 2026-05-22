import type { CollectionDiagnosticItem } from "./runtime-model";

/** Snapshot type that the device collector reports for the current product model. */
export type CollectionHealthSnapshotType = "device_state";

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
  /** Device-side collection completion time when present. */
  collectedAt: string | Date | null;
  /** Backend receive time. */
  receivedAt: string | Date;
  /** Object counts written by the ingestion. */
  counts: Record<string, number>;
  /** Structured adapter diagnostics captured without failing the ingestion. */
  diagnostics: CollectionDiagnosticItem[];
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
  /** Latest device collection completion time. */
  lastCollectedAt?: string;
  /** Latest backend receive time. */
  lastReceivedAt?: string;
  /** Latest object counts for this snapshot type. */
  counts: Record<string, number>;
  /** Structured diagnostics from the latest ingestion. */
  diagnostics: CollectionDiagnosticItem[];
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
  /** Most recent device collection completion time across checks. */
  lastCollectedAt?: string;
  /** Most recent backend receive time across checks. */
  lastReceivedAt?: string;
  /** Individual collection checks for the active collector contract. */
  checks: CollectionHealthCheck[];
}

/** Options for deterministic tests and future policy tuning. */
export interface DeviceCollectionHealthOptions {
  /** Current clock for deterministic tests; recency is displayed as data and does not create a separate status. */
  now?: Date;
  /** Reserved policy knob for future freshness display; it does not create a separate status. */
  staleAfterMs?: number;
}

const snapshotLabels: Record<CollectionHealthSnapshotType, string> = {
  device_state: "设备状态",
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
  const snapshotTypes: CollectionHealthSnapshotType[] = ["device_state"];
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
    lastCollectedAt: maxIso(checks.map((check) => check.lastCollectedAt)),
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
      diagnostics: [],
      message: "尚未收到采集记录",
    };
  }

  const lastReceivedAt = toIso(ingestion.receivedAt);
  const lastCollectedAt = toIso(ingestion.collectedAt);
  const diagnostics = ingestion.diagnostics ?? [];
  const warningCount = diagnosticCount(diagnostics, "warning");
  const errorCount = diagnosticCount(diagnostics, "error");
  if (ingestion.status === "failed") {
    return {
      id: snapshotType,
      label,
      status: "failed",
      lastCollectedAt,
      lastReceivedAt,
      counts: ingestion.counts,
      diagnostics,
      error: ingestion.error ?? null,
      message: "采集失败",
    };
  }

  if (errorCount > 0) {
    return {
      id: snapshotType,
      label,
      status: "failed",
      lastCollectedAt,
      lastReceivedAt,
      counts: ingestion.counts,
      diagnostics,
      error: ingestion.error ?? null,
      message: `采集存在 ${errorCount} 条错误`,
    };
  }

  if (warningCount > 0) {
    return {
      id: snapshotType,
      label,
      status: "healthy",
      lastCollectedAt,
      lastReceivedAt,
      counts: ingestion.counts,
      diagnostics,
      error: ingestion.error ?? null,
      message: `采集成功，但有 ${warningCount} 条数据质量提示`,
    };
  }

  return {
    id: snapshotType,
    label,
    status: "healthy",
    lastCollectedAt,
    lastReceivedAt,
    counts: ingestion.counts,
    diagnostics,
    error: null,
    message: "采集正常",
  };
}

function diagnosticCount(diagnostics: CollectionDiagnosticItem[], severity: CollectionDiagnosticItem["severity"]): number {
  return diagnostics
    .filter((item) => item.severity === severity)
    .reduce((sum, item) => sum + item.count, 0);
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
  if (!worst) return "设备状态采集正常";
  if (checks.every((check) => check.status === "healthy")) {
    return `${checks[0].label}采集正常`;
  }
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
