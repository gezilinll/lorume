#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-device-collector.sh [options]

Options:
  --source-dir <path>     Local Lorume repo/source path that contains scripts/lorume-device-collector.mjs
  --install-dir <path>    Install directory (default: ~/.lorume/collector)
  --server-url <url>      Optional Lorume server URL
  --ws-url <url>          Optional Lorume device control WebSocket URL
  --device-id <id>        Device id to register
  --device-token <token>  Lorume device token for ingestion and control
  --interval-ms <ms>      Collector interval for service mode (default: 300000)
  --once                  Run a one-time collection after install
  --no-service            Do not install launchd/systemd service
  --stop                  Stop the installed collector service and keep files
  --uninstall             Stop service, remove service file, and remove install directory
  --fixture <path>        Fixture snapshot for one-time test mode
  -h, --help              Show help
EOF
}

SOURCE_DIR=""
INSTALL_DIR="$HOME/.lorume/collector"
SERVER_URL=""
WS_URL=""
DEVICE_ID=""
DEVICE_TOKEN=""
INTERVAL_MS="300000"
ONCE="false"
NO_SERVICE="false"
FIXTURE=""
ACTION="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --server-url)
      SERVER_URL="$2"
      shift 2
      ;;
    --ws-url)
      WS_URL="$2"
      shift 2
      ;;
    --device-id)
      DEVICE_ID="$2"
      shift 2
      ;;
    --device-token)
      DEVICE_TOKEN="$2"
      shift 2
      ;;
    --interval-ms)
      INTERVAL_MS="$2"
      shift 2
      ;;
    --once)
      ONCE="true"
      shift
      ;;
    --no-service)
      NO_SERVICE="true"
      shift
      ;;
    --stop)
      ACTION="stop"
      shift
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --fixture)
      FIXTURE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

MACOS_PLIST_PATH="$HOME/Library/LaunchAgents/ai.lorume.collector.plist"
LINUX_SERVICE_PATH="$HOME/.config/systemd/user/lorume-collector.service"

stop_collector_service() {
  case "$(uname -s)" in
    Darwin)
      launchctl bootout "gui/$(id -u)" "$MACOS_PLIST_PATH" >/dev/null 2>&1 || true
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop lorume-collector.service >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

remove_collector_service() {
  stop_collector_service
  case "$(uname -s)" in
    Darwin)
      rm -f "$MACOS_PLIST_PATH"
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable lorume-collector.service >/dev/null 2>&1 || true
        systemctl --user daemon-reload >/dev/null 2>&1 || true
      fi
      rm -f "$LINUX_SERVICE_PATH"
      ;;
  esac
}

if [[ "$ACTION" == "stop" ]]; then
  stop_collector_service
  exit 0
fi

if [[ "$ACTION" == "uninstall" ]]; then
  if [[ -z "$INSTALL_DIR" || "$INSTALL_DIR" == "/" ]]; then
    echo "Refusing to uninstall unsafe install dir: $INSTALL_DIR" >&2
    exit 1
  fi
  remove_collector_service
  rm -rf "$INSTALL_DIR"
  rm -rf "$HOME/.lorume/logs"
  rm -f "$HOME/.lorume/task-sync-cache.json"
  rmdir "$HOME/.lorume" >/dev/null 2>&1 || true
  exit 0
fi

if [[ -z "$SOURCE_DIR" ]]; then
  SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

SOURCE_COLLECTOR="$SOURCE_DIR/scripts/lorume-device-collector.mjs"
if [[ ! -f "$SOURCE_COLLECTOR" ]]; then
  echo "Collector script not found: $SOURCE_COLLECTOR" >&2
  exit 1
fi
SOURCE_CLI="$SOURCE_DIR/scripts/lorume.mjs"
if [[ ! -f "$SOURCE_CLI" ]]; then
  echo "Lorume CLI script not found: $SOURCE_CLI" >&2
  exit 1
fi
SOURCE_RUNTIME_ADAPTERS="$SOURCE_DIR/scripts/lorume-runtime-adapters.mjs"
if [[ ! -f "$SOURCE_RUNTIME_ADAPTERS" ]]; then
  echo "Lorume runtime adapter module not found: $SOURCE_RUNTIME_ADAPTERS" >&2
  exit 1
fi
SOURCE_LOCAL_IP_NORMALIZATION="$SOURCE_DIR/scripts/local-ip-normalization.mjs"
if [[ ! -f "$SOURCE_LOCAL_IP_NORMALIZATION" ]]; then
  echo "Lorume local IP normalization module not found: $SOURCE_LOCAL_IP_NORMALIZATION" >&2
  exit 1
fi
SOURCE_INSTALLER="$SOURCE_DIR/scripts/install-device-collector.sh"
if [[ ! -f "$SOURCE_INSTALLER" ]]; then
  echo "Lorume installer script not found: $SOURCE_INSTALLER" >&2
  exit 1
fi

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  for candidate in \
    "$HOME/.local/bin/node" \
    "$HOME/.npm-global/bin/node" \
    "$HOME/.volta/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  local fnm_root="$HOME/.local/share/fnm/node-versions"
  if [[ -d "$fnm_root" ]]; then
    local candidate
    while IFS= read -r candidate; do
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done < <(find "$fnm_root" -path '*/installation/bin/node' -type f 2>/dev/null | sort -r)
  fi

  return 1
}

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is required to run the Lorume device collector" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install -m 0755 "$SOURCE_INSTALLER" "$INSTALL_DIR/install-device-collector.sh"
install -m 0755 "$SOURCE_COLLECTOR" "$INSTALL_DIR/lorume-device-collector.mjs"
install -m 0755 "$SOURCE_CLI" "$INSTALL_DIR/lorume.mjs"
install -m 0644 "$SOURCE_RUNTIME_ADAPTERS" "$INSTALL_DIR/lorume-runtime-adapters.mjs"
install -m 0644 "$SOURCE_LOCAL_IP_NORMALIZATION" "$INSTALL_DIR/local-ip-normalization.mjs"

"$NODE_BIN" - "$INSTALL_DIR/config.json" "$INSTALL_DIR" "$SERVER_URL" "$WS_URL" "$DEVICE_ID" "$DEVICE_TOKEN" "$INTERVAL_MS" <<'NODE'
const fs = require("node:fs");

const [configPath, installDir, serverUrl, wsUrl, deviceId, deviceToken, intervalMs] = process.argv.slice(2);
const config = {
  installDir,
  serverUrl,
  wsUrl,
  deviceId,
  deviceToken,
  intervalMs: Number(intervalMs),
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

CONFIG_PATH="$INSTALL_DIR/config.json"
COLLECTOR_PATH="$INSTALL_DIR/lorume-device-collector.mjs"

install_macos_service() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist_path="$MACOS_PLIST_PATH"
  mkdir -p "$plist_dir"
  cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.lorume.collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$COLLECTOR_PATH</string>
    <string>--config</string>
    <string>$CONFIG_PATH</string>
    <string>--interval-ms</string>
    <string>$INTERVAL_MS</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/collector.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/collector.err.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
}

install_linux_service() {
  local service_dir="$HOME/.config/systemd/user"
  local service_path="$LINUX_SERVICE_PATH"
  mkdir -p "$service_dir"
  cat > "$service_path" <<EOF
[Unit]
Description=Lorume Device Collector

[Service]
ExecStart=$NODE_BIN $COLLECTOR_PATH --config $CONFIG_PATH --interval-ms $INTERVAL_MS
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now lorume-collector.service
}

if [[ "$ONCE" == "true" ]]; then
  ONCE_ARGS=("$COLLECTOR_PATH" "--once" "--config" "$CONFIG_PATH")
  if [[ -z "$SERVER_URL" ]]; then
    ONCE_ARGS+=("--print-only")
  fi
  if [[ -n "$FIXTURE" ]]; then
    ONCE_ARGS+=("--fixture" "$FIXTURE")
  fi
  "$NODE_BIN" "${ONCE_ARGS[@]}"
fi

if [[ "$NO_SERVICE" == "true" || "$ONCE" == "true" ]]; then
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    install_macos_service
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      install_linux_service
    else
      echo "systemd is not available; run manually: $NODE_BIN $COLLECTOR_PATH --config $CONFIG_PATH" >&2
    fi
    ;;
  *)
    echo "Unsupported service platform; run manually: $NODE_BIN $COLLECTOR_PATH --config $CONFIG_PATH" >&2
    ;;
esac
