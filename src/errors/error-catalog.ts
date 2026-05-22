export interface LorumeErrorResponse {
  error: string;
  message: string;
}

const errorMessages: Record<string, string> = {
  auth_backend_unavailable: "登录服务暂时不可用，请稍后重试。",
  backend_unavailable: "服务暂时不可用，请稍后重试。",
  collector_post_failed: "采集数据暂时无法上报到 Lorume 后端，请检查网络或后端服务。",
  collector_run_failed: "设备采集任务执行失败，请查看 Lorume CLI 采集日志。",
  device_not_connected: "设备控制通道未连接，请确认目标设备上的 Lorume CLI 正在运行。",
  email_and_code_required: "请输入邮箱和验证码。",
  email_provider_unavailable: "验证码暂时无法发送，请确认邮件服务已配置后重试。",
  email_required: "请输入邮箱地址。",
  forbidden: "当前账号没有执行此操作的权限。",
  invalid_device_state_snapshot: "设备状态采集数据无效，请检查 Lorume CLI 版本或上报结构。",
  invalid_device_token: "设备认证失败，请检查 Lorume CLI 的设备令牌配置。",
  invalid_json_body: "请求内容不是有效的 JSON。",
  invalid_runtime_task_batch: "任务批量上报数据无效，请检查 Lorume CLI 版本或上报结构。",
  invalid_or_expired_code: "验证码无效或已过期，请重新获取验证码。",
  invitation_email_and_role_required: "请输入邀请邮箱并选择成员角色。",
  invitation_not_available: "邀请链接无效、已过期或与当前邮箱不匹配。",
  organization_name_required: "请输入组织名称。",
  postgres_store_unavailable: "后端数据存储暂时不可用，请稍后重试。",
  request_body_too_large: "请求内容过大，请减少单次上报的数据量。",
  request_failed: "操作失败，请稍后重试。",
  unauthorized: "请先登录后再继续操作。",
};

const technicalCodePatterns: Array<[RegExp, string]> = [
  [/invalid device state snapshot/i, "invalid_device_state_snapshot"],
  [/invalid runtime task batch/i, "invalid_runtime_task_batch"],
  [/invalid collector snapshot/i, "invalid_device_state_snapshot"],
  [/invalid snapshot/i, "invalid_device_state_snapshot"],
  [/invalid json body/i, "invalid_json_body"],
  [/request body too large/i, "request_body_too_large"],
  [/snapshot post failed/i, "collector_post_failed"],
  [/device.*not connected/i, "device_not_connected"],
];

export function normalizeErrorCode(value: string | undefined | null): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "request_failed";
  if (errorMessages[normalized]) return normalized;
  for (const [pattern, code] of technicalCodePatterns) {
    if (pattern.test(normalized)) return code;
  }
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "request_failed";
}

export function errorMessageForCode(code: string, fallback = errorMessages.request_failed): string {
  return errorMessages[normalizeErrorCode(code)] ?? fallback;
}

export function createErrorResponse(error: unknown, fallbackCode = "request_failed"): LorumeErrorResponse {
  const code = error instanceof Error ? normalizeErrorCode(error.message) : normalizeErrorCode(fallbackCode);
  const normalizedCode = errorMessages[code] ? code : normalizeErrorCode(fallbackCode);
  return {
    error: normalizedCode,
    message: errorMessageForCode(normalizedCode),
  };
}
