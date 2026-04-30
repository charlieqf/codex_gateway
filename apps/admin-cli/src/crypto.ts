import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { AccessCredentialRecord } from "@codex-gateway/core";

export function encryptAccessCredentialToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", apiKeyEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

export function revealAccessCredentialToken(record: AccessCredentialRecord): string | null {
  if (!record.tokenCiphertext) {
    return null;
  }
  const [version, ivText, tagText, ciphertextText] = record.tokenCiphertext.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new Error(`Credential prefix has an unsupported stored token format: ${record.prefix}`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    apiKeyEncryptionKey(),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

function apiKeyEncryptionKey(): Buffer {
  const secret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "GATEWAY_API_KEY_ENCRYPTION_SECRET is required to issue or reveal recoverable API keys."
    );
  }
  return createHash("sha256").update(secret, "utf8").digest();
}
