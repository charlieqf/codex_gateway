export interface SqliteStoreOptions {
  path: string;
  logger?: SqliteStoreLogger;
}

export interface SqliteStoreLogger {
  info(message: string): void;
}

export interface UpdateSubjectInput {
  label?: string;
  name?: string | null;
  phoneNumber?: string | null;
}
