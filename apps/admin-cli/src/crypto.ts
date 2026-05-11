import {
  decryptSecret,
  encryptSecret,
  type AccessCredentialRecord
} from "@codex-gateway/core";

export function encryptAccessCredentialToken(token: string): string {
  return encryptGatewaySecret(token);
}

export function revealAccessCredentialToken(record: AccessCredentialRecord): string | null {
  if (!record.tokenCiphertext) {
    return null;
  }
  return decryptGatewaySecret(record.tokenCiphertext);
}

export function encryptGatewaySecret(plaintext: string): string {
  return encryptSecret(plaintext, apiKeyEncryptionSecret());
}

export function decryptGatewaySecret(ciphertext: string): string {
  try {
    return decryptSecret(ciphertext, apiKeyEncryptionSecret());
  } catch (err) {
    throw new Error(
      `Stored secret has an unsupported or undecryptable format: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function apiKeyEncryptionSecret(): string {
  const secret = process.env.GATEWAY_API_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "GATEWAY_API_KEY_ENCRYPTION_SECRET is required to issue or reveal recoverable API keys."
    );
  }
  return secret;
}
