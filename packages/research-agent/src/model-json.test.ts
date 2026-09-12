import { describe, expect, it } from "vitest";
import { parseModelJson, parseModelJsonObject } from "./model-json.js";

describe("parseModelJson", () => {
  it.each([
    ["bare object", '{"a":1}'],
    ["paired json fence", "```json\n{\"a\":1}\n```"],
    ["paired bare fence", "```\n{\"a\":1}\n```"],
    ["stray leading fence", "```json\n{\"a\":1}"],
    ["stray trailing fence", "{\"a\":1}\n```"],
    ["crlf fence", "```json\r\n{\"a\":1}\r\n```"],
    ["array payload", "[1,2]"],
    ["scalar payload", "42"]
  ])("%s", (_name, input) => {
    expect(() => parseModelJson(input)).not.toThrow();
  });

  it.each([
    ["unclosed fence", "```json\n{\"a\":1"],
    ["missing final brace", "{\"a\":1"],
    ["prose wrapper", "Here you go: {\"a\":1} thanks"]
  ])("throws on %s", (_name, input) => {
    expect(() => parseModelJson(input)).toThrow();
  });

  it("rejects fenced prose that only looks like JSON", () => {
    expect(() => parseModelJson("```json\nnot json\n```")).toThrow();
  });
});

describe("parseModelJsonObject", () => {
  it("returns the object for fenced and bare inputs", () => {
    expect(parseModelJsonObject("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseModelJsonObject(" {\"a\":1} ")).toEqual({ a: 1 });
  });

  it("throws a SyntaxError for non-object payloads", () => {
    expect(() => parseModelJsonObject("[1,2]")).toThrow(SyntaxError);
    expect(() => parseModelJsonObject("42")).toThrow(SyntaxError);
  });
});
