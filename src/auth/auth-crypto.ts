import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Create a short numeric code for email verification. */
export function createNumericCode(options: { length?: number } = {}): string {
  const length = options.length ?? 6;
  const digits = Array.from({ length }, () => String(randomBytes(1)[0] % 10));
  return digits.join("");
}

/** Create an opaque bearer token with a readable prefix for diagnostics. */
export function createSecretToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Hash a secret with a purpose-specific HMAC. The returned value is safe to persist. */
export function hashSecret(secret: string, purpose: string, pepper = defaultPepper()): string {
  return createHmac("sha256", pepper)
    .update(`${purpose}\0${secret}`)
    .digest("base64url");
}

/** Constant-time verification for secrets represented by `hashSecret`. */
export function verifySecret(secret: string, expectedHash: string, purpose: string, pepper = defaultPepper()): boolean {
  const actualHash = hashSecret(secret, purpose, pepper);
  const actual = Buffer.from(actualHash);
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Encrypt a secret that must be recoverable by protected backend routes. */
export function encryptSecret(secret: string, purpose: string, pepper = defaultPepper()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(purpose, pepper), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Decrypt a recoverable secret created by `encryptSecret`. */
export function decryptSecret(encrypted: string, purpose: string, pepper = defaultPepper()): string {
  const [version, ivValue, tagValue, ciphertextValue] = encrypted.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("invalid_encrypted_secret");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(purpose, pepper), Buffer.from(ivValue, "base64url"));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new Error("invalid_encrypted_secret");
  }
}

function encryptionKey(purpose: string, pepper: string): Buffer {
  return createHash("sha256").update(`lorume-secret-encryption\0${purpose}\0${pepper}`).digest();
}

function defaultPepper(): string {
  return process.env.LORUME_AUTH_SECRET || "lorume-development-auth-secret";
}
