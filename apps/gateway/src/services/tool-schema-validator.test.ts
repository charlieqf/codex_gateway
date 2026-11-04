import { describe, expect, it } from "vitest";
import { ToolSchemaValidatorCache } from "./tool-schema-validator.js";

const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

describe("bounded tool schema compilation", () => {
  it("reuses independently parsed schemas and preserves all validation errors", () => {
    const cache = new ToolSchemaValidatorCache();
    const first = cache.get(structuredClone(schema));
    for (let i = 0; i < 500; i++) expect(cache.get(structuredClone(schema)).validate).toBe(first.validate);
    expect(cache.size).toBe(1);
    expect(first.validate({ value: "ok" })).toBe(true);
    expect(first.validate({ extra: true })).toBe(false);
    expect(first.validate.errors?.map(e => e.keyword).sort()).toEqual(["additionalProperties", "required"]);
  });

  it("evicts the least recently used compiler rather than growing its Ajv scope", () => {
    const cache = new ToolSchemaValidatorCache(2);
    const a = cache.get({ ...schema, description: "a" });
    const b = cache.get({ ...schema, description: "b" });
    expect(a.validator).not.toBe(b.validator);
    cache.get({ ...schema, description: "a" });
    cache.get({ ...schema, description: "c" });
    expect(cache.size).toBe(2);
    expect(cache.get({ ...schema, description: "a" }).validate).toBe(a.validate);
    expect(cache.get({ ...schema, description: "b" }).validate).not.toBe(b.validate);
    for (let i = 0; i < 30; i++) cache.get({ ...schema, description: `different-${i}` });
    expect(cache.size).toBe(2);
  });

  it("bounds retained schema bytes and validates oversized schemas without caching them", () => {
    const bytes = Buffer.byteLength(JSON.stringify([schema]));
    const cache = new ToolSchemaValidatorCache(128, bytes);
    const first = cache.get(schema);
    const large = { ...schema, description: "x".repeat(bytes) };
    expect(cache.get(large).validate({ value: "ok" })).toBe(true);
    expect(cache.get(large).validate).not.toBe(cache.get(large).validate);
    expect(cache.schemaBytes).toBe(bytes);
    expect(cache.get(schema).validate).toBe(first.validate);
    cache.get({ type: "string" });
    expect(cache.schemaBytes).toBeLessThanOrEqual(bytes);
    expect(cache.size).toBe(1);
  });

  it("isolates reused schema IDs and snapshots mutable caller input", () => {
    const cache = new ToolSchemaValidatorCache();
    const input = { $id: "urn:tool:example", ...structuredClone(schema) };
    const original = cache.get(input);
    input.properties.value.type = "number";
    const changed = cache.get(input);
    expect(original.validate({ value: "ok" })).toBe(true);
    expect(changed.validate({ value: "ok" })).toBe(false);
    expect(changed.validate({ value: 2 })).toBe(true);
    expect(() => cache.get({ $ref: "urn:tool:example" })).toThrow();
  });

  it.each([
    ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema"],
    ["https://json-schema.org/draft/2019-09/schema", "http://json-schema.org/draft/2019-09/schema#"],
    ["https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft/2020-12/schema#"],
  ])("retains %s support, local references and URI normalization", (uri, alias) => {
    const cache = new ToolSchemaValidatorCache();
    const input = { $schema: uri, $defs: { text: { type: "string" } }, type: "object", properties: { value: { $ref: "#/$defs/text" } }, required: ["value"] };
    const first = cache.get(input);
    expect(first.validate({ value: "ok" })).toBe(true);
    expect(first.validate({ value: 1 })).toBe(false);
    expect(cache.get({ ...input, $schema: alias }).validate).toBe(first.validate);
  });

  it("does not retain failed compilations or poison later valid schemas", () => {
    const cache = new ToolSchemaValidatorCache();
    for (let i = 0; i < 25; i++) expect(() => cache.get({ type: "not-a-type", title: `invalid-${i}` })).toThrow();
    expect(cache.size).toBe(0);
    expect(cache.schemaBytes).toBe(0);
    expect(cache.get(schema).validate({ value: "ok" })).toBe(true);
  });

  it("keeps two alternating 65-tool requests warm and shares one compiler per tool set", () => {
    const cache = new ToolSchemaValidatorCache();
    const sets = ["a", "b"].map(client => Array.from({ length: 65 }, (_, i) => ({ ...schema, description: `${client}-${i}` })));
    const first = sets.map(set => cache.getMany(set));
    expect(new Set(first[0]!.map(item => item.validator)).size).toBe(1);
    expect(first[0]![0]!.validator).not.toBe(first[1]![0]!.validator);
    for (let i = 0; i < 20; i++) {
      const client = i % 2;
      expect(cache.getMany(structuredClone(sets[client]!))).toBe(first[client]);
    }
    expect(cache.size).toBe(2);
    expect(cache.schemaCount).toBe(130);
  });

  it("does not evict a 129-schema request while compiling or reusing it", () => {
    const cache = new ToolSchemaValidatorCache();
    const set = Array.from({ length: 129 }, (_, i) => ({ ...schema, description: `${i}` }));
    const first = cache.getMany(set);
    expect(cache.getMany(structuredClone(set))).toBe(first);
    expect(cache.size).toBe(1);
    expect(cache.schemaCount).toBe(129);
  });

  it("bounds total schemas as well as tool sets, without flushing on an oversized set", () => {
    const cache = new ToolSchemaValidatorCache(128, 2 * 1024 * 1024, 3);
    const a = [schema, { ...schema, description: "a" }];
    const b = [schema, { ...schema, description: "b" }];
    cache.getMany(a);
    const retained = cache.getMany(b);
    expect(cache.size).toBe(1);
    expect(cache.schemaCount).toBe(2);
    const large = [schema, schema, schema, schema];
    expect(cache.getMany(large)).not.toBe(cache.getMany(large));
    expect(cache.getMany(b)).toBe(retained);
    expect(cache.schemaCount).toBe(2);
  });

  it.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ])("resolves request-local forward refs for %s without leaking definitions between requests", ($schema) => {
    const cache = new ToolSchemaValidatorCache();
    const reference = { $schema, $ref: "urn:tool:shared" };
    const definition = { $schema, $id: "urn:tool:shared", ...schema };
    const first = cache.getMany([reference, definition]);
    const second = cache.getMany([reference, { ...definition, properties: { value: { type: "number" } } }]);
    expect(first[0]!.validate({ value: "ok" })).toBe(true);
    expect(first[0]!.validate({ value: 1 })).toBe(false);
    expect(second[0]!.validate({ value: "ok" })).toBe(false);
    expect(second[0]!.validate({ value: 1 })).toBe(true);
    expect(() => cache.get(reference)).toThrow(/can't resolve reference/);
    expect(cache.getMany([reference, definition])).toBe(first);
  });
});
