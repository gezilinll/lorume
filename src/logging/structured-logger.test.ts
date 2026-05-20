import { describe, expect, it } from "vitest";
import { createStructuredLogger } from "./structured-logger";

describe("structured logger", () => {
  it("writes normalized JSON records without leaking tokens", () => {
    const records: unknown[] = [];
    const logger = createStructuredLogger({
      service: "runtime",
      sink: (record) => records.push(record),
    });

    logger.warn(
      {
        deviceId: "fixture-device",
        deviceToken: "secret-device-token",
        errorCode: "invalid_collector_snapshot",
        event: "collector_ingestion_failed",
        sessionToken: "secret-session-token",
      },
      "设备采集失败",
    );

    expect(records).toEqual([
      expect.objectContaining({
        deviceId: "fixture-device",
        errorCode: "invalid_collector_snapshot",
        event: "collector_ingestion_failed",
        level: "warn",
        message: "设备采集失败",
        service: "runtime",
      }),
    ]);
    expect(JSON.stringify(records[0])).not.toContain("secret-device-token");
    expect(JSON.stringify(records[0])).not.toContain("secret-session-token");
  });
});
