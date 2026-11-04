import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";

// Shared-cache budgets: tool sets, serialized JSON bytes, and total root schemas.
// Active requests may retain evicted compilers until their validation completes.
export const maxToolSchemaCacheEntries = 128;
export const maxToolSchemaCacheBytes = 2 * 1024 * 1024;
export const maxToolSchemaCacheSchemas = 1024;

export interface CompiledToolSchema {
  validator: Ajv;
  validate: ValidateFunction;
}

interface CacheEntry {
  compiled: readonly CompiledToolSchema[];
  bytes: number;
}

export class ToolSchemaCompilationError extends Error {
  constructor(readonly schemaIndex: number, error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "ToolSchemaCompilationError";
  }
}

/** Each tool set owns its compilers, including Ajv's retained code-generation scope. */
export class ToolSchemaValidatorCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;
  private schemas = 0;

  constructor(
    private readonly maxEntries = maxToolSchemaCacheEntries,
    private readonly maxBytes = maxToolSchemaCacheBytes,
    private readonly maxSchemas = maxToolSchemaCacheSchemas,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
        !Number.isSafeInteger(maxSchemas) || maxSchemas < 0) {
      throw new Error("Tool schema cache limits must be nonnegative safe integers.");
    }
  }

  get size() { return this.entries.size; }
  get schemaBytes() { return this.bytes; }
  get schemaCount() { return this.schemas; }

  get(schema: Record<string, unknown>): CompiledToolSchema {
    return this.getMany([schema])[0]!;
  }

  getMany(schemas: readonly Record<string, unknown>[]): readonly CompiledToolSchema[] {
    if (schemas.length === 0) return [];
    const normalized = schemas.map((schema, index) => {
      try {
        const { Compiler, schema: value } = normalizeSchema(schema);
        return { Compiler, key: JSON.stringify(value) };
      } catch (error) {
        throw new ToolSchemaCompilationError(index, error);
      }
    });
    const key = `[${normalized.map(item => item.key).join(",")}]`;
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.compiled;
    }

    // Ajv caches schemas by object identity. removeSchema() leaves references
    // in its code-generation scope, so eviction must release the whole compiler.
    // Compile a complete request together: references stay request-local, and a
    // tool set larger than the old per-schema LRU cannot evict itself on each call.
    const validators = new Map<typeof Ajv, Ajv>();
    const snapshots = new Map<string, Record<string, unknown>>();
    const prepared = normalized.map(({ Compiler, key: schemaKey }, index) => {
      try {
        let validator = validators.get(Compiler);
        if (!validator) {
          validator = new Compiler({ allErrors: true, strict: false });
          validators.set(Compiler, validator);
        }
        let schema = snapshots.get(schemaKey);
        if (!schema) {
          schema = JSON.parse(schemaKey) as Record<string, unknown>;
          snapshots.set(schemaKey, schema);
          // Register named roots before compiling, including forward references.
          // Anonymous roots keep their original base URI and local-ref semantics.
          if (typeof schema.$id === "string" && schema.$id.length > 0) validator.addSchema(schema);
        }
        return { validator, schema };
      } catch (error) {
        throw new ToolSchemaCompilationError(index, error);
      }
    });
    const compiled = prepared.map(({ validator, schema }, index) => {
      try {
        return { validator, validate: validator.compile(schema) };
      } catch (error) {
        throw new ToolSchemaCompilationError(index, error);
      }
    });
    const bytes = Buffer.byteLength(key, "utf8");
    if (this.maxEntries === 0 || bytes > this.maxBytes || schemas.length > this.maxSchemas) return compiled;

    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes ||
           this.schemas + schemas.length > this.maxSchemas) {
      const oldest = this.entries.keys().next().value!;
      const entry = this.entries.get(oldest)!;
      this.bytes -= entry.bytes;
      this.schemas -= entry.compiled.length;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { compiled, bytes });
    this.bytes += bytes;
    this.schemas += schemas.length;
    return compiled;
  }
}

function normalizeSchema(schema: Record<string, unknown>) {
  const uri = typeof schema.$schema === "string" ? schema.$schema.replace(/#$/, "") : null;
  let Compiler: typeof Ajv = Ajv;
  let canonical: string | null = null;
  if (uri === "http://json-schema.org/draft-07/schema" || uri === "https://json-schema.org/draft-07/schema") {
    canonical = "http://json-schema.org/draft-07/schema#";
  } else if (uri === "http://json-schema.org/draft/2019-09/schema" || uri === "https://json-schema.org/draft/2019-09/schema") {
    Compiler = Ajv2019;
    canonical = "https://json-schema.org/draft/2019-09/schema";
  } else if (uri === "http://json-schema.org/draft/2020-12/schema" || uri === "https://json-schema.org/draft/2020-12/schema") {
    Compiler = Ajv2020;
    canonical = "https://json-schema.org/draft/2020-12/schema";
  }
  return { Compiler, schema: canonical && schema.$schema !== canonical ? { ...schema, $schema: canonical } : schema };
}

export const toolSchemaValidators = new ToolSchemaValidatorCache();
