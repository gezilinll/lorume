import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CollectorPackageManifest } from "../collector/collector-upgrade-model";

export interface DeviceInstallerPackageFile {
  readonly fileName: string;
  readonly sourcePath: string;
  readonly contentType: string;
}

export interface DeviceInstallerRuntimeFile {
  readonly fileName: string;
  readonly sourcePath: string;
  readonly mode: "0755" | "0644";
}

export const deviceInstallerPackageManifest = [
  {
    fileName: "install-device-collector.sh",
    sourcePath: "scripts/install-device-collector.sh",
    contentType: "text/x-shellscript; charset=utf-8",
  },
  {
    fileName: "lorume-device-collector.mjs",
    sourcePath: "scripts/lorume-device-collector.mjs",
    contentType: "text/javascript; charset=utf-8",
  },
  {
    fileName: "lorume-runtime-adapters.mjs",
    sourcePath: "scripts/lorume-runtime-adapters.mjs",
    contentType: "text/javascript; charset=utf-8",
  },
  {
    fileName: "local-ip-normalization.mjs",
    sourcePath: "scripts/local-ip-normalization.mjs",
    contentType: "text/javascript; charset=utf-8",
  },
  {
    fileName: "lorume.mjs",
    sourcePath: "scripts/lorume.mjs",
    contentType: "text/javascript; charset=utf-8",
  },
] as const satisfies readonly DeviceInstallerPackageFile[];

export const deviceInstallerRuntimeFiles = [
  {
    fileName: "lorume-device-collector.mjs",
    sourcePath: "scripts/lorume-device-collector.mjs",
    mode: "0755",
  },
  {
    fileName: "lorume-runtime-adapters.mjs",
    sourcePath: "scripts/lorume-runtime-adapters.mjs",
    mode: "0644",
  },
  {
    fileName: "local-ip-normalization.mjs",
    sourcePath: "scripts/local-ip-normalization.mjs",
    mode: "0644",
  },
  {
    fileName: "lorume.mjs",
    sourcePath: "scripts/lorume.mjs",
    mode: "0755",
  },
] as const satisfies readonly DeviceInstallerRuntimeFile[];

export function findDeviceInstallerPackageFile(fileName: string): DeviceInstallerPackageFile | undefined {
  return deviceInstallerPackageManifest.find((entry) => entry.fileName === fileName);
}

export async function createCollectorPackageManifest(options: {
  readonly createdAt?: string;
  readonly version?: string;
} = {}): Promise<CollectorPackageManifest> {
  const files = await Promise.all(deviceInstallerRuntimeFiles.map(async (entry) => {
    const body = await readFile(path.join(process.cwd(), entry.sourcePath));
    return {
      bytes: body.byteLength,
      fileName: entry.fileName,
      mode: entry.mode,
      path: entry.fileName,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }));

  return {
    schemaVersion: "collector-package-v1",
    version: options.version ?? await readCurrentPackageVersion(),
    createdAt: options.createdAt ?? new Date().toISOString(),
    minUpgradeProtocolVersion: 1,
    files,
  };
}

async function readCurrentPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  return typeof packageJson.version === "string" && packageJson.version.trim() !== ""
    ? packageJson.version
    : "0.0.0";
}
