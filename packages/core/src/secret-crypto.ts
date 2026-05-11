import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function encryptSecret(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

export function decryptSecret(ciphertext: string, secret: string): string {
  const [version, ivText, tagText, ciphertextText] = ciphertext.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new Error("Unsupported encrypted secret format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", secretKey(secret), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

function secretKey(secret: string): Buffer {
  if (!secret) {
    throw new Error("Encryption secret is required.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}
