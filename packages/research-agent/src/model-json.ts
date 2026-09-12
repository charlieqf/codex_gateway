/**
 * Model outputs arrive as fenced or bare JSON. Agents previously shipped four
 * private parsers with three different behaviors; this module is the shared
 * base. Fence handling is intentionally lenient (paired fence, or stray
 * leading/trailing fence markers) because models emit both shapes.
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const paired = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)[ \t]*\r?\n?```$/u.exec(trimmed);
  if (paired) {
    return JSON.parse(paired[1]!.trim());
  }
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  return JSON.parse(stripped);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strict variant: the result must be a JSON object or a SyntaxError is thrown. */
export function parseModelJsonObject(text: string): Record<string, unknown> {
  const value: unknown = parseModelJson(text);
  if (!isObject(value)) {
    throw new SyntaxError("Expected a JSON object.");
  }
  return value;
}
