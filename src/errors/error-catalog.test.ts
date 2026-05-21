import { describe, expect, it } from "vitest";
import {
  createErrorResponse,
  errorMessageForCode,
  normalizeErrorCode,
} from "./error-catalog";

describe("Lorume error catalog", () => {
  it("maps stable error codes to user-readable messages", () => {
    expect(errorMessageForCode("invalid_device_state_snapshot")).toBe(
      "设备状态采集数据无效，请检查 Lorume CLI 版本或上报结构。",
    );
    expect(errorMessageForCode("device_not_connected")).toBe(
      "设备控制通道未连接，请确认目标设备上的 Lorume CLI 正在运行。",
    );
    expect(errorMessageForCode("collector_post_failed")).toBe(
      "采集数据暂时无法上报到 Lorume 后端，请检查网络或后端服务。",
    );
    expect(errorMessageForCode("invalid_or_expired_code")).toBe(
      "验证码无效或已过期，请重新获取验证码。",
    );
    expect(errorMessageForCode("auth_backend_unavailable")).toBe(
      "登录服务暂时不可用，请稍后重试。",
    );
  });

  it("normalizes technical exception text into stable error codes", () => {
    expect(normalizeErrorCode("invalid device state snapshot")).toBe("invalid_device_state_snapshot");
    expect(normalizeErrorCode("Snapshot post failed: HTTP 503")).toBe("collector_post_failed");
    expect(normalizeErrorCode("request body too large")).toBe("request_body_too_large");
  });

  it("builds API error responses with both code and readable message", () => {
    expect(createErrorResponse(new Error("invalid device state snapshot"))).toEqual({
      error: "invalid_device_state_snapshot",
      message: "设备状态采集数据无效，请检查 Lorume CLI 版本或上报结构。",
    });
  });
});
