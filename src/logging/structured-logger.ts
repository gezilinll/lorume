export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogRecord {
  level: LogLevel;
  message: string;
  service: string;
  time: string;
  [key: string]: unknown;
}

export interface StructuredLogger {
  debug: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

export interface StructuredLoggerOptions {
  service: string;
  sink?: (record: StructuredLogRecord) => void;
  now?: () => Date;
}

const redactedKeys = new Set([
  "authorization",
  "bearertoken",
  "code",
  "devicetoken",
  "emailprovidertoken",
  "invitationtoken",
  "password",
  "sessiontoken",
  "token",
]);

/** Create a tiny pino-compatible structured logger for backend and harness code. */
export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  const sink = options.sink ?? ((record) => {
    const line = JSON.stringify(record);
    if (record.level === "error" || record.level === "warn") {
      console.error(line);
      return;
    }
    console.log(line);
  });
  const now = options.now ?? (() => new Date());

  function write(level: LogLevel, fields: Record<string, unknown>, message: string): void {
    sink({
      ...redactLogFields(fields),
      level,
      message,
      service: options.service,
      time: now().toISOString(),
    });
  }

  return {
    debug: (fields, message) => write("debug", fields, message),
    error: (fields, message) => write("error", fields, message),
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
  };
}

export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      redactedKeys.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase()) ? "[redacted]" : value,
    ]),
  );
}
