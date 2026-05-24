import type { RuntimeDeviceStateStore } from "./runtime-device-state-store";

/** Minimal socket interface shared by tests and the Vite WebSocket adapter. */
export interface RuntimeControlSocket {
  /** Send a serialized JSON control message. */
  send: (data: string) => void;
}

/** Runtime control channel construction options. */
export interface RuntimeControlChannelOptions {
  /** Store used for connection state. */
  store: RuntimeDeviceStateStore;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/** Runtime control channel API used by the dev backend. */
export interface RuntimeControlChannel {
  /** Attach a socket before it sends hello. */
  attach: (socket: RuntimeControlSocket) => void;
  /** Detach a socket and mark its device offline when registered. */
  detach: (socket: RuntimeControlSocket, reason?: string) => void;
  /** Receive one serialized JSON message from a socket. */
  receive: (socket: RuntimeControlSocket, rawMessage: string) => void;
  /** Return whether the channel currently has a live socket for a device. */
  isDeviceConnected: (deviceId: string) => boolean;
}

type ControlMessage = {
  type?: string;
  deviceId?: string;
  collectorVersion?: string;
  hostname?: string;
  summary?: Record<string, unknown>;
  error?: string;
};

/** Create the in-memory Runtime Fleet device control channel. */
export function createRuntimeControlChannel(options: RuntimeControlChannelOptions): RuntimeControlChannel {
  const now = options.now ?? (() => new Date());
  const socketDeviceIds = new WeakMap<RuntimeControlSocket, string>();
  const socketsByDeviceId = new Map<string, RuntimeControlSocket>();

  function send(socket: RuntimeControlSocket, message: Record<string, unknown>): void {
    socket.send(JSON.stringify({ sentAt: now().toISOString(), ...message }));
  }

  return {
    attach() {
      // The socket becomes addressable after it sends hello with a device id.
    },
    detach(socket, reason = "socket disconnected") {
      const deviceId = socketDeviceIds.get(socket);
      if (!deviceId) return;
      socketDeviceIds.delete(socket);
      if (socketsByDeviceId.get(deviceId) === socket) socketsByDeviceId.delete(deviceId);
      options.store.markDeviceDisconnected(deviceId, now().toISOString(), reason);
    },
    receive(socket, rawMessage) {
      const message = parseControlMessage(rawMessage);
      if (message.type === "hello") {
        const deviceId = requireDeviceId(message);
        socketDeviceIds.set(socket, deviceId);
        socketsByDeviceId.set(deviceId, socket);
        options.store.writeDeviceConnection({
          deviceId,
          status: "online",
          connectedAt: now().toISOString(),
          lastHeartbeatAt: now().toISOString(),
          collectorVersion: message.collectorVersion,
          hostname: message.hostname,
        });
        send(socket, { type: "hello.ack", deviceId });
        return;
      }

      if (message.type === "heartbeat") {
        const deviceId = requireDeviceId(message, socketDeviceIds.get(socket));
        const current = options.store.readDeviceConnection(deviceId) ?? {
          deviceId,
          status: "online" as const,
        };
        options.store.writeDeviceConnection({
          ...current,
          deviceId,
          status: "online",
          lastHeartbeatAt: now().toISOString(),
          collectorVersion: message.collectorVersion ?? current.collectorVersion,
          hostname: message.hostname ?? current.hostname,
          summary: message.summary ?? current.summary,
          lastError: message.error || undefined,
        });
        return;
      }

      send(socket, { type: "error", error: `unsupported message type: ${message.type ?? "unknown"}` });
    },
    isDeviceConnected(deviceId) {
      return socketsByDeviceId.has(deviceId);
    },
  };
}

function parseControlMessage(rawMessage: string): ControlMessage {
  const parsed = JSON.parse(rawMessage) as unknown;
  if (!isRecord(parsed)) throw new Error("control message must be an object");
  return parsed;
}

function requireDeviceId(message: ControlMessage, fallback?: string): string {
  const deviceId = message.deviceId ?? fallback;
  if (!deviceId) throw new Error("control message missing deviceId");
  return deviceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
