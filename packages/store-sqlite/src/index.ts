export interface SqliteStoreOptions {
  path: string;
}

export interface SqliteStoreHandle {
  kind: "sqlite";
  path: string;
}

export function createSqliteStore(options: SqliteStoreOptions): SqliteStoreHandle {
  return {
    kind: "sqlite",
    path: options.path
  };
}

