import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  deviceInstallerPackageManifest,
  findDeviceInstallerPackageFile,
} from "./device-installer-manifest";

/** Public, secret-free installer assets used by one-line device registration commands. */
export function createDeviceInstallerHttpApiHandler() {
  return async function deviceInstallerHttpApiHandler(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> {
    const requestUrl = new URL(request.url || "/", "http://lorume.local");
    if (request.method !== "GET") {
      next();
      return;
    }

    if (requestUrl.pathname === "/api/device-collector/install.sh") {
      sendText(response, 200, "text/x-shellscript; charset=utf-8", remoteInstallerScript());
      return;
    }

    const fileMatch = requestUrl.pathname.match(/^\/api\/device-collector\/files\/([^/]+)$/);
    if (!fileMatch) {
      next();
      return;
    }

    const fileName = decodeURIComponent(fileMatch[1] ?? "");
    const file = findDeviceInstallerPackageFile(fileName);
    if (!file) {
      sendText(response, 404, "text/plain; charset=utf-8", "not found");
      return;
    }

    try {
      const body = await readFile(path.join(process.cwd(), file.sourcePath), "utf8");
      sendText(response, 200, file.contentType, body);
    } catch {
      sendText(response, 404, "text/plain; charset=utf-8", "not found");
    }
  };
}

function remoteInstallerScript(): string {
  const downloads = deviceInstallerPackageManifest
    .map((file) => `download "${file.fileName}"`)
    .join("\n");

  return `#!/usr/bin/env bash
set -euo pipefail

SERVER_URL=""
for ((index = 1; index <= $#; index++)); do
  if [[ "\${!index}" == "--server-url" ]]; then
    next_index=$((index + 1))
    if [[ $next_index -le $# ]]; then
      SERVER_URL="\${!next_index}"
    fi
  fi
done

if [[ -z "$SERVER_URL" ]]; then
  echo "--server-url is required" >&2
  exit 1
fi

BASE_URL="\${SERVER_URL%/}"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

download() {
  local name="$1"
  local output="$TMP_DIR/scripts/$name"
  mkdir -p "$TMP_DIR/scripts"
  curl -fsSL "$BASE_URL/api/device-collector/files/$name" -o "$output"
}

${downloads}

chmod 0755 "$TMP_DIR/scripts/install-device-collector.sh"
bash "$TMP_DIR/scripts/install-device-collector.sh" --source-dir "$TMP_DIR" "$@"
`;
}

function sendText(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", contentType);
  response.end(body);
}
