#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEVICE_PACKAGE_FILES = [
  "scripts/install-device-collector.sh",
  "scripts/lorume-device-collector.mjs",
  "scripts/lorume-runtime-adapters.mjs",
  "scripts/local-ip-normalization.mjs",
  "scripts/lorume.mjs",
  "src/backend/device-installer-manifest.ts",
];

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function readCurrentFile(filePath) {
  return readFileSync(filePath, "utf8");
}

function readGitFile(ref, filePath) {
  const body = git(["show", `${ref}:${filePath}`]);
  return body || undefined;
}

function parseJsonVersion(body, label) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : undefined;
  } catch {
    throw new Error(`cannot parse ${label}`);
  }
}

function parsePackageLockVersions(body, label) {
  try {
    const parsed = JSON.parse(body);
    return {
      packageLockRootVersion: typeof parsed.version === "string" ? parsed.version.trim() : undefined,
      packageLockPackageVersion: typeof parsed.packages?.[""]?.version === "string"
        ? parsed.packages[""].version.trim()
        : undefined,
    };
  } catch {
    throw new Error(`cannot parse ${label}`);
  }
}

function parseCollectorVersionConstant(body, label) {
  const match = body.match(/\bCOLLECTOR_VERSION\s*=\s*"([^"]+)"/);
  if (!match?.[1]) throw new Error(`cannot find COLLECTOR_VERSION in ${label}`);
  return match[1].trim();
}

export function readDevicePackageVersions(ref) {
  const read = ref
    ? (filePath) => readGitFile(ref, filePath)
    : readCurrentFile;

  const packageJson = read("package.json");
  if (!packageJson) return {};

  const packageLock = read("package-lock.json");
  const collectorScript = read("scripts/lorume-device-collector.mjs");
  const runtimeAdapters = read("scripts/lorume-runtime-adapters.mjs");

  return {
    packageVersion: parseJsonVersion(packageJson, ref ? `${ref}:package.json` : "package.json"),
    ...(packageLock
      ? parsePackageLockVersions(packageLock, ref ? `${ref}:package-lock.json` : "package-lock.json")
      : {}),
    collectorScriptVersion: collectorScript
      ? parseCollectorVersionConstant(collectorScript, ref ? `${ref}:scripts/lorume-device-collector.mjs` : "scripts/lorume-device-collector.mjs")
      : undefined,
    runtimeAdaptersVersion: runtimeAdapters
      ? parseCollectorVersionConstant(runtimeAdapters, ref ? `${ref}:scripts/lorume-runtime-adapters.mjs` : "scripts/lorume-runtime-adapters.mjs")
      : undefined,
  };
}

export function compareDevicePackageVersions(left, right) {
  const leftParts = String(left || "").split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = String(right || "").split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightPart = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

function isDevicePackageFile(filePath) {
  return DEVICE_PACKAGE_FILES.includes(filePath);
}

export function validateDevicePackageVersionState({ baseVersions = {}, changedFiles = [], currentVersions }) {
  const problems = [];
  const packageVersion = currentVersions.packageVersion;
  const versionSources = [
    ["package-lock root version", currentVersions.packageLockRootVersion],
    ["package-lock package version", currentVersions.packageLockPackageVersion],
    ["collector script version", currentVersions.collectorScriptVersion],
    ["runtime adapters version", currentVersions.runtimeAdaptersVersion],
  ];

  if (!packageVersion) {
    problems.push("package.json version is missing");
  }

  for (const [label, version] of versionSources) {
    if (!version) {
      problems.push(`${label} is missing`);
    } else if (packageVersion && version !== packageVersion) {
      problems.push(`${label} ${version} must equal package.json version ${packageVersion}`);
    }
  }

  const changedDevicePackageFiles = changedFiles.filter(isDevicePackageFile);
  if (changedDevicePackageFiles.length > 0) {
    if (!baseVersions.packageVersion) {
      problems.push("cannot read base package.json version for device package version guard");
    } else if (packageVersion && compareDevicePackageVersions(packageVersion, baseVersions.packageVersion) <= 0) {
      problems.push(
        `device package version must increase when collector or CLI package files change: `
        + `${baseVersions.packageVersion} -> ${packageVersion}; changed files: ${changedDevicePackageFiles.join(", ")}`,
      );
    }
  }

  return {
    changedDevicePackageFiles,
    problems,
    valid: problems.length === 0,
  };
}

function uniqueSorted(lines) {
  return [...new Set(lines.filter(Boolean))].sort();
}

function determineBaseRef() {
  if (process.env.LORUME_DEVICE_PACKAGE_VERSION_BASE) return process.env.LORUME_DEVICE_PACKAGE_VERSION_BASE;

  const originMain = git(["rev-parse", "--verify", "origin/main"]);
  if (originMain) return git(["merge-base", "origin/main", "HEAD"]) || "HEAD";

  if (git(["rev-parse", "--verify", "HEAD^"])) return "HEAD^";
  if (git(["rev-parse", "--verify", "HEAD"])) return "HEAD";
  return undefined;
}

function collectChangedFiles(baseRef) {
  const diffFiles = baseRef
    ? git(["diff", "--name-only", "--diff-filter=ACMRTUXB", baseRef, "--"]).split(/\r?\n/)
    : [];
  const untrackedFiles = git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/);
  return uniqueSorted([...diffFiles, ...untrackedFiles]);
}

function runCli() {
  const baseRef = determineBaseRef();
  const currentVersions = readDevicePackageVersions();
  const baseVersions = baseRef ? readDevicePackageVersions(baseRef) : {};
  const changedFiles = collectChangedFiles(baseRef);
  const result = validateDevicePackageVersionState({ baseVersions, changedFiles, currentVersions });

  if (!result.valid) {
    console.error("check:device-package-version: failed");
    if (baseRef) console.error(`base: ${baseRef}`);
    for (const problem of result.problems) console.error(`- ${problem}`);
    process.exit(1);
  }

  console.log("check:device-package-version: ok");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
