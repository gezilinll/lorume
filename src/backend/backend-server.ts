import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { resolveLorumeAppMode, type LorumeAppMode } from "../app-mode";
import {
  createAuthHttpApiHandler,
  createAuthRuntimeGuards,
  type AuthEmailProvider,
} from "../auth/auth-http-api";
import { createPostgresAuthStore, type AuthStore } from "../auth/auth-store";
import { createNotificationHttpApiHandler } from "../notifications/notification-http-api";
import { createPostgresNotificationStore, type NotificationStore } from "../notifications/notification-store";
import { createOperationHttpApiHandler } from "../operations/operation-http-api";
import { createOperationJobRunner } from "../operations/job-runner";
import { createPostgresOperationStore, type OperationStore } from "../operations/operation-store";
import { createRuntimeControlChannel, type RuntimeControlSocket } from "../server/runtime-control-channel";
import { createRuntimeHttpApiHandler } from "../server/runtime-http-api";
import { createRuntimeDeviceStateStore } from "../server/runtime-device-state-store";
import { createPostgresStore, type PostgresStore } from "../server/postgres-store";
import { createStructuredLogger, type StructuredLogger } from "../logging/structured-logger";
import { createDeviceInstallerHttpApiHandler } from "./device-installer-http-api";
import { createBackendEmailProvider } from "./email-provider";

/** Construction options for the standalone Lorume backend. */
export interface LorumeBackendServerOptions {
  /** Host passed to `server.listen`. */
  host?: string;
  /** Port passed to `server.listen`; use 0 for tests. */
  port?: number;
  /** Optional internal device_state snapshot path used for Skill probe fallback context and control state. */
  deviceStateSnapshotPath?: string;
  /** Milliseconds before a silent connected device is considered stale. */
  staleAfterMs?: number;
  /** Postgres connection string for the formal backend repository. */
  databaseUrl?: string;
  /** Optional repository injection for tests. */
  postgresStore?: PostgresStore;
  /** Optional auth repository injection for tests. */
  authStore?: AuthStore;
  /** Optional Operation repository injection for tests. */
  operationStore?: OperationStore;
  /** Optional Notification repository injection for tests. */
  notificationStore?: NotificationStore;
  /** Enable or disable the in-process Operation job runner. */
  operationRunnerEnabled?: boolean;
  /** Operation runner polling interval in milliseconds. */
  operationRunnerIntervalMs?: number;
  /** Optional email provider injection for tests. */
  emailProvider?: AuthEmailProvider;
  /** Permission profile for local agent, development, or production operation. */
  appMode?: LorumeAppMode;
  /** Whether Runtime Fleet / Runs read APIs require a valid user session. */
  authRequired?: boolean;
  /** Whether collector ingestion and device WebSocket require a valid device token. */
  deviceTokenRequired?: boolean;
  /** Auth HMAC pepper override for tests. */
  authPepper?: string;
  /** Structured logger injection for tests and production wiring. */
  logger?: StructuredLogger;
}

/** Running standalone backend handle used by tests and local dev. */
export interface LorumeBackendServer {
  /** HTTP base URL after `listen` resolves. */
  readonly url: string;
  /** WebSocket base URL after `listen` resolves. */
  readonly wsUrl: string;
  /** Start listening. */
  listen: () => Promise<void>;
  /** Stop HTTP and WebSocket listeners. */
  close: () => Promise<void>;
}

/** Create the local-first standalone Lorume backend service. */
export function createLorumeBackendServer(
  options: LorumeBackendServerOptions = {},
): LorumeBackendServer {
  const host = options.host ?? process.env.LORUME_BACKEND_HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.LORUME_BACKEND_PORT ?? 4173);
  const store = createRuntimeDeviceStateStore({
    snapshotPath: options.deviceStateSnapshotPath,
    staleAfterMs: options.staleAfterMs,
  });
  const controlChannel = createRuntimeControlChannel({
    store,
  });
  const ownedPostgresStore = options.postgresStore
    ? null
    : createPostgresStore({ connectionString: options.databaseUrl });
  const postgresStore = options.postgresStore ?? ownedPostgresStore;
  const ownedAuthStore = options.authStore
    ? null
    : createPostgresAuthStore({ connectionString: options.databaseUrl });
  const authStore = options.authStore ?? ownedAuthStore;
  const authGuards = authStore ? createAuthRuntimeGuards(authStore, { pepper: options.authPepper }) : undefined;
  const ownedOperationStore = options.operationStore
    ? null
    : createPostgresOperationStore({ connectionString: options.databaseUrl });
  const operationStore = options.operationStore ?? ownedOperationStore;
  const ownedNotificationStore = options.notificationStore
    ? null
    : createPostgresNotificationStore({ connectionString: options.databaseUrl });
  const notificationStore = options.notificationStore ?? ownedNotificationStore;
  const logger = options.logger ?? createStructuredLogger({ service: "lorume-backend" });
  const operationRunnerEnabled = options.operationRunnerEnabled
    ?? Boolean(options.databaseUrl ?? process.env.DATABASE_URL);
  const operationRunnerIntervalMs = options.operationRunnerIntervalMs
    ?? Number(process.env.LORUME_OPERATION_RUNNER_INTERVAL_MS ?? 1_000);
  const operationRunner = operationRunnerEnabled && operationStore
    ? createOperationJobRunner({
      handlers: {},
      notificationStore: notificationStore ?? undefined,
      operationStore,
      runnerId: process.env.LORUME_OPERATION_RUNNER_ID ?? "lorume-backend",
    })
    : undefined;
  const appMode = options.appMode ?? resolveLorumeAppMode(process.env.LORUME_APP_MODE ?? process.env.LORUME_AUTH_MODE);
  const authRequired = options.authRequired ?? readBooleanEnv("LORUME_AUTH_REQUIRED", appMode !== "agent");
  const deviceTokenRequired = options.deviceTokenRequired ?? process.env.LORUME_DEVICE_TOKEN_REQUIRED === "1";
  const authHandler = authStore
    ? createAuthHttpApiHandler({
      emailProvider: options.emailProvider ?? createBackendEmailProvider(),
      pepper: options.authPepper,
      store: authStore,
    })
    : undefined;
  const httpHandler = createRuntimeHttpApiHandler({
    auth: {
      requireDeviceToken: deviceTokenRequired ? authGuards?.requireDeviceToken : undefined,
      requireUserSession: authRequired ? authGuards?.requireUserSession : undefined,
    },
    store,
    controlChannel,
    postgresStore: postgresStore ?? undefined,
    collectorNotifications: authStore && notificationStore
      ? {
        createNotificationEvent: notificationStore.createNotificationEvent,
        listRecipientUserIds: (organizationId) => authStore.listOrganizationAdminUserIds(organizationId),
      }
      : undefined,
    operationStore: operationStore ?? undefined,
    skillProbeNotifications: authStore && notificationStore
      ? {
        createNotificationEvent: notificationStore.createNotificationEvent,
        listRecipientUserIds: (organizationId) => authStore.listOrganizationAdminUserIds(organizationId),
      }
      : undefined,
    logger,
  });
  const operationHandler = authGuards && operationStore
    ? createOperationHttpApiHandler({
      operationStore,
      requireUserSession: authGuards.requireUserSession,
    })
    : undefined;
  const notificationHandler = authGuards && notificationStore
    ? createNotificationHttpApiHandler({
      notificationStore,
      requireUserSession: authGuards.requireUserSession,
    })
    : undefined;
  const deviceInstallerHandler = createDeviceInstallerHttpApiHandler();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    const notFound = () => {
      response.statusCode = 404;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("not found");
    };
    const runRuntimeHandler = () => {
      void httpHandler(request, response, notFound);
    };
    const runOperationHandler = () => {
      if (operationHandler) {
        void operationHandler(request, response, runRuntimeHandler);
      } else {
        runRuntimeHandler();
      }
    };
    const runNotificationHandler = () => {
      if (notificationHandler) {
        void notificationHandler(request, response, runOperationHandler);
      } else {
        runOperationHandler();
      }
    };
    const runAuthHandler = () => {
      if (authHandler) {
        void authHandler(request, response, runNotificationHandler);
      } else {
        runNotificationHandler();
      }
    };
    void deviceInstallerHandler(request, response, runAuthHandler);
  });
  let baseUrl = "";
  let listening = false;
  let postgresClosed = false;
  let authClosed = false;
  let operationClosed = false;
  let notificationClosed = false;
  let operationRunnerTimer: ReturnType<typeof setInterval> | null = null;
  let operationRunnerRunning = false;

  const runOperationRunnerTick = async () => {
    if (!operationRunner || operationRunnerRunning) return;
    operationRunnerRunning = true;
    try {
      await operationRunner.runDueJobOnce();
    } catch {
      // Keep the backend alive when the runner cannot claim or execute a due job.
    } finally {
      operationRunnerRunning = false;
    }
  };

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const requestUrl = new URL(request.url || "/", "http://lorume.local");
      if (requestUrl.pathname !== "/api/device-control/ws") {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        attachDeviceControlWebSocket(webSocket, {
          authGuards,
          controlChannel,
          deviceTokenRequired,
        });
        webSocketServer.emit("connection", webSocket, request);
      });
    })().catch(() => {
      socket.destroy();
    });
  });

  return {
    get url() {
      return baseUrl;
    },
    get wsUrl() {
      return baseUrl.replace(/^http/, "ws");
    },
    listen() {
      return new Promise<void>((resolve, reject) => {
        if (listening) {
          resolve();
          return;
        }
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Lorume backend did not receive a TCP address"));
            return;
          }
          const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
          baseUrl = `http://${displayHost}:${address.port}`;
          listening = true;
          if (operationRunner && !operationRunnerTimer) {
            void runOperationRunnerTick();
            operationRunnerTimer = setInterval(() => {
              void runOperationRunnerTick();
            }, Math.max(100, operationRunnerIntervalMs));
          }
          resolve();
        });
      });
    },
    async close() {
      if (operationRunnerTimer) {
        clearInterval(operationRunnerTimer);
        operationRunnerTimer = null;
      }
      await closeWebSocketServer(webSocketServer);
      if (listening) {
        await closeHttpServer(server);
        listening = false;
        baseUrl = "";
      }
      if (ownedPostgresStore && !postgresClosed) {
        postgresClosed = true;
        await ownedPostgresStore.close();
      }
      if (ownedAuthStore && !authClosed) {
        authClosed = true;
        await ownedAuthStore.close();
      }
      if (ownedOperationStore && !operationClosed) {
        operationClosed = true;
        await ownedOperationStore.close();
      }
      if (ownedNotificationStore && !notificationClosed) {
        notificationClosed = true;
        await ownedNotificationStore.close();
      }
    },
  };
}

function attachDeviceControlWebSocket(
  webSocket: WebSocket,
  options: {
    authGuards?: ReturnType<typeof createAuthRuntimeGuards>;
    controlChannel: ReturnType<typeof createRuntimeControlChannel>;
    deviceTokenRequired: boolean;
  },
): void {
  let controlSocket: RuntimeControlSocket | undefined;
  let authenticated = !options.deviceTokenRequired;
  let authenticating = false;
  const pendingMessages: string[] = [];

  const ensureControlSocket = () => {
    if (controlSocket) return controlSocket;
    controlSocket = {
      send(data) {
        if (webSocket.readyState === WebSocket.OPEN) webSocket.send(data);
      },
    };
    options.controlChannel.attach(controlSocket);
    return controlSocket;
  };

  if (!options.deviceTokenRequired) ensureControlSocket();

  webSocket.on("message", (message) => {
    const rawMessage = message.toString();
    void (async () => {
      if (!authenticated) {
        if (authenticating) {
          pendingMessages.push(rawMessage);
          return;
        }
        authenticating = true;
        const hello = parseControlHello(rawMessage);
        if (!hello || !hello.deviceToken || !(await options.authGuards?.verifyDeviceTokenValue(hello.deviceToken))) {
          webSocket.close(1008, "invalid device token");
          return;
        }
        if (webSocket.readyState !== WebSocket.OPEN) return;
        authenticated = true;
        const socket = ensureControlSocket();
        delete hello.deviceToken;
        receiveControlMessage(options.controlChannel, socket, JSON.stringify(hello));
        const queuedMessages = pendingMessages.splice(0);
        for (const queuedMessage of queuedMessages) {
          receiveControlMessage(options.controlChannel, socket, queuedMessage);
        }
        return;
      }

      receiveControlMessage(options.controlChannel, ensureControlSocket(), rawMessage);
    })().catch(() => {
      webSocket.close(1008, "invalid control message");
    }).finally(() => {
      if (!authenticated) authenticating = false;
    });
  });

  webSocket.on("close", () => {
    if (controlSocket) options.controlChannel.detach(controlSocket, "socket closed");
  });
  webSocket.on("error", () => {
    if (controlSocket) options.controlChannel.detach(controlSocket, "socket error");
  });
}

function receiveControlMessage(
  controlChannel: ReturnType<typeof createRuntimeControlChannel>,
  controlSocket: RuntimeControlSocket,
  data: string,
): void {
  try {
    controlChannel.receive(controlSocket, data);
  } catch (error) {
    controlSocket.send(JSON.stringify({
      type: "error",
      error: error instanceof Error ? error.message : "invalid control message",
    }));
  }
}

function parseControlHello(rawMessage: string): ({ deviceToken?: string } & Record<string, unknown>) | null {
  const message = JSON.parse(rawMessage) as unknown;
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "hello" || typeof record.deviceToken !== "string") return null;
  return record as { deviceToken?: string } & Record<string, unknown>;
}

function closeWebSocketServer(webSocketServer: WebSocketServer): Promise<void> {
  for (const client of webSocketServer.clients) client.close();
  return new Promise((resolve, reject) => {
    webSocketServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isDirectRun(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === "1" || value?.toLowerCase() === "true") return true;
  if (value === "0" || value?.toLowerCase() === "false") return false;
  return fallback;
}

if (isDirectRun()) {
  const backend = createLorumeBackendServer();
  await backend.listen();
  process.stdout.write(`Lorume backend listening on ${backend.url}\n`);
}
