/** Encrypted issuance inputs; plaintext lookup IDs can contain a phone-derived external ID. Never stores plaintext keys. */
export interface IssuanceTaskRecord {
  id: string;
  provider: string;
  externalUserId: string;
  actorId: string;
  state: string;
  snapshotCiphertext: string;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  retiredAt?: Date | null;
}

export interface IssuanceTaskStore {
  insertIssuanceTask(record: IssuanceTaskRecord): void;
  getIssuanceTask(id: string): IssuanceTaskRecord | null;
  listIssuanceTasks(actorId: string | null, limit: number): IssuanceTaskRecord[];
  claimIssuanceTask(id: string, token: string, now: Date, expiresAt: Date, expectedState: string): boolean;
  saveIssuanceTask(record: IssuanceTaskRecord, token: string, now: Date): void;
  releaseIssuanceTask(id: string, token: string): void;
}
