export type LorumeAppMode = "production" | "development" | "agent";

/** Resolve the product permission profile used by frontend and backend entrypoints. */
export function resolveLorumeAppMode(value?: string | null): LorumeAppMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "production";
  if (normalized === "development" || normalized === "dev") return "development";
  if (normalized === "agent") return "agent";
  if (normalized === "production" || normalized === "prod") return "production";
  return "production";
}
