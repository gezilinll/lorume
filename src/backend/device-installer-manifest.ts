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
    fileName: "lorume.mjs",
    sourcePath: "scripts/lorume.mjs",
    mode: "0755",
  },
] as const satisfies readonly DeviceInstallerRuntimeFile[];

export function findDeviceInstallerPackageFile(fileName: string): DeviceInstallerPackageFile | undefined {
  return deviceInstallerPackageManifest.find((entry) => entry.fileName === fileName);
}
