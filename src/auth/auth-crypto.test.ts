import { describe, expect, it } from "vitest";
import { createNumericCode, createSecretToken, decryptSecret, encryptSecret, hashSecret, verifySecret } from "./auth-crypto";

describe("auth crypto helpers", () => {
  it("hashes login codes and tokens without exposing the original secret", () => {
    const hash = hashSecret("123456", "login-code", "test-pepper");

    expect(hash).not.toContain("123456");
    expect(verifySecret("123456", hash, "login-code", "test-pepper")).toBe(true);
    expect(verifySecret("123457", hash, "login-code", "test-pepper")).toBe(false);
    expect(verifySecret("123456", hash, "session-token", "test-pepper")).toBe(false);
  });

  it("creates short numeric email codes and high-entropy bearer tokens", () => {
    expect(createNumericCode({ length: 6 })).toMatch(/^\d{6}$/);
    expect(createSecretToken("agt")).toMatch(/^agt_[A-Za-z0-9_-]{32,}$/);
  });

  it("encrypts recoverable secrets without storing plaintext", () => {
    const encrypted = encryptSecret("agt_device_secret", "device-token", "test-pepper");

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("agt_device_secret");
    expect(decryptSecret(encrypted, "device-token", "test-pepper")).toBe("agt_device_secret");
    expect(() => decryptSecret(encrypted, "session-token", "test-pepper")).toThrow("invalid_encrypted_secret");
  });
});
