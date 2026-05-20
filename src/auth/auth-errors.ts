import { errorMessageForCode, normalizeErrorCode } from "../errors/error-catalog";

export function authErrorMessage(code: string, fallback = "操作失败，请稍后重试。"): string {
  return errorMessageForCode(code, fallback);
}

export function normalizeAuthErrorCode(code: string): string {
  return normalizeErrorCode(code);
}
