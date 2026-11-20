import { describe, expect, it } from "vitest";
import { mcpJsonLine, mcpJsonText } from "./json-serialize.js";

const originalObjectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
const originalArrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
const originalStringReplace = String.prototype.replace;
const originalJsonStringify = JSON.stringify;
const originalReflectOwnKeys = Reflect.ownKeys;
const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const originalWeakSetHas = WeakSet.prototype.has;
const originalWeakSetAdd = WeakSet.prototype.add;
const originalWeakSetDelete = WeakSet.prototype.delete;
const originalArrayIterator = Array.prototype[Symbol.iterator];

function restore(): void {
  if (originalObjectToJSON) Object.defineProperty(Object.prototype, "toJSON", originalObjectToJSON);
  else delete (Object.prototype as { toJSON?: unknown }).toJSON;
  if (originalArrayToJSON) Object.defineProperty(Array.prototype, "toJSON", originalArrayToJSON);
  else delete (Array.prototype as { toJSON?: unknown }).toJSON;
  String.prototype.replace = originalStringReplace;
  JSON.stringify = originalJsonStringify;
  Reflect.ownKeys = originalReflectOwnKeys;
  Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
  WeakSet.prototype.has = originalWeakSetHas;
  WeakSet.prototype.add = originalWeakSetAdd;
  WeakSet.prototype.delete = originalWeakSetDelete;
  Array.prototype[Symbol.iterator] = originalArrayIterator;
}

describe("MCP JSON serialization integrity", () => {
  it("writes one compact JSON line and preserves JSON values", () => {
    const line = mcpJsonLine({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect((JSON.parse(line) as { result: { content: { text: string }[] } }).result.content[0]!.text).toBe("ok");
  });

  it("does not invoke inherited Object.prototype.toJSON on the outer response", () => {
    let calls = 0;
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value() { calls++; return "exfiltrated"; } });
    try {
      const line = mcpJsonLine({ jsonrpc: "2.0", id: 7, result: { secret: "CANARY" } });
      expect((JSON.parse(line) as { result: { secret: string } }).result.secret).toBe("CANARY");
      expect(calls).toBe(0);
    } finally { restore(); }
  });

  it("does not invoke inherited Array.prototype.toJSON on nested content", () => {
    let calls = 0;
    Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value() { calls++; return ["injected"]; } });
    try {
      const line = mcpJsonLine({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "safe" }] } });
      expect((JSON.parse(line) as { result: { content: { text: string }[] } }).result.content[0]!.text).toBe("safe");
      expect(calls).toBe(0);
    } finally { restore(); }
  });

  it("rejects own accessors without invoking them", () => {
    let calls = 0;
    const value = {};
    Object.defineProperty(value, "secret", { enumerable: true, get() { calls++; return "CANARY"; } });
    expect(() => mcpJsonText(value)).toThrow(/accessor/);
    expect(calls).toBe(0);
  });

  it("rejects symbol and non-enumerable fields", () => {
    const symbolValue = { safe: true, [Symbol("hidden")]: "x" };
    const hiddenValue = { safe: true };
    Object.defineProperty(hiddenValue, "hidden", { value: "x", enumerable: false });
    expect(() => mcpJsonText(symbolValue)).toThrow(/symbol/);
    expect(() => mcpJsonText(hiddenValue)).toThrow(/non-enumerable/);
  });

  it("rejects sparse and extended arrays", () => {
    const sparse = new Array(1);
    const extended = ["safe"] as string[] & { extra?: boolean };
    extended.extra = true;
    expect(() => mcpJsonText(sparse)).toThrow(/sparse/);
    expect(() => mcpJsonText(extended)).toThrow(/sparse/);
  });

  it("rejects custom prototypes and cycles", () => {
    const custom = Object.create({ inherited: true }) as { value?: number };
    custom.value = 1;
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => mcpJsonText(custom)).toThrow(/custom object/);
    expect(() => mcpJsonText(cycle)).toThrow(/cyclic/);
  });

  it("keeps __proto__ as inert own data", () => {
    const value: unknown = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const parsed = JSON.parse(mcpJsonText(value)) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("escapes line separators without changing parsed values", () => {
    const value = { text: "a\u0085b\u2028c\u2029d" };
    const line = mcpJsonLine(value);
    expect(line).toMatch(/\\u0085/);
    expect(line).toMatch(/\\u2028/);
    expect(line).toMatch(/\\u2029/);
    expect((JSON.parse(line) as typeof value).text).toBe(value.text);
  });

  it("uses captured stringify and does not depend on mutable replace or array iteration", () => {
    String.prototype.replace = () => { throw new Error("poisoned replace"); };
    Array.prototype[Symbol.iterator] = function* () { throw new Error("poisoned iterator"); };
    try {
      const parsed = JSON.parse(mcpJsonLine({ items: ["a", "b"] })) as { items: string[] };
      expect(parsed.items[1]).toBe("b");
    } finally { restore(); }
  });

  it("rejects non-finite and unsupported values", () => {
    expect(() => mcpJsonText({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => mcpJsonText({ value: 1n })).toThrow(/unsupported/);
    expect(() => mcpJsonText({ value: undefined })).toThrow(/unsupported/);
  });

  it("rejects oversized and deeply nested structures", () => {
    expect(() => mcpJsonText({ value: "x".repeat(500_001) })).toThrow(/string exceeds/);
    const value: Record<string, unknown> = {};
    let cursor = value;
    for (let index = 0; index < 66; index++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => mcpJsonText(value)).toThrow(/deeply nested/);
  });

  it("rejects proxies before any reflection trap executes", () => {
    let getPrototypeCalls = 0;
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    const proxy = new Proxy({ secret: "CANARY" }, {
      getPrototypeOf() { getPrototypeCalls++; throw new Error("getPrototypeOf trap must not execute"); },
      ownKeys() { ownKeysCalls++; throw new Error("ownKeys trap must not execute"); },
      getOwnPropertyDescriptor() { descriptorCalls++; throw new Error("descriptor trap must not execute"); },
    });
    expect(() => mcpJsonText({ nested: proxy })).toThrow(/proxy/);
    expect([getPrototypeCalls, ownKeysCalls, descriptorCalls]).toEqual([0, 0, 0]);

    const revoked = Proxy.revocable({ safe: true }, {});
    revoked.revoke();
    expect(() => mcpJsonText(revoked.proxy)).toThrow(/proxy/);
  });

  it("does not invoke inherited numeric setters while projecting arrays", () => {
    let calls = 0;
    Object.defineProperty(Array.prototype, "0", { configurable: true, set() { calls++; } });
    try {
      const parsed = JSON.parse(mcpJsonLine({ items: ["safe"] })) as { items: string[] };
      expect(parsed.items[0]).toBe("safe");
      expect(calls).toBe(0);
    } finally { delete (Array.prototype as unknown as Record<string, unknown>)["0"]; }
  });

  it("rejects own toJSON methods rather than invoking them", () => {
    let calls = 0;
    const value = { safe: true, toJSON() { calls++; return "unsafe"; } };
    expect(() => mcpJsonText(value)).toThrow(/unsupported/);
    expect(calls).toBe(0);
  });

  it("uses captured JSON and reflection intrinsics after ambient mutation", () => {
    JSON.stringify = () => { throw new Error("poisoned stringify"); };
    Reflect.ownKeys = () => { throw new Error("poisoned ownKeys"); };
    Object.getOwnPropertyDescriptor = () => { throw new Error("poisoned descriptor"); };
    WeakSet.prototype.has = () => { throw new Error("poisoned WeakSet.has"); };
    WeakSet.prototype.add = () => { throw new Error("poisoned WeakSet.add"); };
    WeakSet.prototype.delete = () => { throw new Error("poisoned WeakSet.delete"); };
    try {
      const parsed = JSON.parse(mcpJsonText({ nested: { value: 3 } })) as { nested: { value: number } };
      expect(parsed.nested.value).toBe(3);
    } finally { restore(); }
  });
});
