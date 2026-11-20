import { types as nodeTypes } from "node:util";

/** Prototype-safe JSON serialization for MCP response envelopes and text content.
 * Only ordinary JSON data is accepted. The projected graph has null prototypes,
 * so inherited Object.prototype/Array.prototype hooks cannot alter the output.
 */
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_OBJECT_KEYS = 10_000;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_TOTAL_KEYS = 50_000;
const MAX_STRING_UNITS = 500_000;
const MAX_TOTAL_STRING_UNITS = 2_000_000;
const MAX_LINE_UNITS = 16_000_000;

const nativeStringify = JSON.stringify;
const nativeIsProxy = nodeTypes.isProxy;
const nativeApply = Reflect.apply;
const nativeGetPrototypeOf = Object.getPrototypeOf;
const nativeOwnKeys = Reflect.ownKeys;
const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const nativeCreate = Object.create;
const nativeDefineProperty = Object.defineProperty;
const nativeSetPrototypeOf = Object.setPrototypeOf;
const nativeIsArray = Array.isArray;
const nativeIsFinite = Number.isFinite;
const nativeIsSafeInteger = Number.isSafeInteger;
const NativeWeakSet = WeakSet;
const nativeWeakSetHas = WeakSet.prototype.has;
const nativeWeakSetAdd = WeakSet.prototype.add;
const nativeWeakSetDelete = WeakSet.prototype.delete;
const jsonObject = JSON;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;

interface Budget {
  nodes: number;
  keys: number;
  stringUnits: number;
}

function ownDataValue(target: object, key: PropertyKey): unknown {
  const descriptor = nativeGetOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) throw new TypeError("missing own data property");
  const valueDescriptor = nativeGetOwnPropertyDescriptor(descriptor, "value");
  if (valueDescriptor === undefined) throw new TypeError("accessor properties are not serializable");
  return valueDescriptor.value;
}

function ownEnumerableDataValue(target: object, key: PropertyKey): unknown {
  const descriptor = nativeGetOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) throw new TypeError("missing own data property");
  const enumerableDescriptor = nativeGetOwnPropertyDescriptor(descriptor, "enumerable");
  if (enumerableDescriptor?.value !== true) throw new TypeError("non-enumerable properties are not serializable");
  const valueDescriptor = nativeGetOwnPropertyDescriptor(descriptor, "value");
  if (valueDescriptor === undefined) throw new TypeError("accessor properties are not serializable");
  return valueDescriptor.value;
}

function defineOwn(target: object, key: string, value: unknown): void {
  nativeDefineProperty(target, key, {
    value, enumerable: true, configurable: true, writable: true,
  });
}

function accountString(value: string, budget: Budget): void {
  if (value.length > MAX_STRING_UNITS) throw new TypeError("MCP JSON string exceeds limits");
  budget.stringUnits += value.length;
  if (budget.stringUnits > MAX_TOTAL_STRING_UNITS) throw new TypeError("MCP JSON contains too much string data");
}

function projectArray(value: object, budget: Budget, depth: number, ancestors: WeakSet<object>): unknown[] {
  const length = ownDataValue(value, "length");
  if (typeof length !== "number" || !nativeIsSafeInteger(length) || length < 0 || length > MAX_ARRAY_ITEMS) {
    throw new TypeError("MCP JSON array exceeds limits");
  }
  const prototype = nativeGetPrototypeOf(value);
  if (prototype !== arrayPrototype && prototype !== null) throw new TypeError("custom array prototypes are not serializable");
  const keys = nativeOwnKeys(value);
  if (keys.length !== length + 1) throw new TypeError("sparse or extended arrays are not serializable");
  budget.keys += length;
  if (budget.keys > MAX_TOTAL_KEYS) throw new TypeError("MCP JSON has too many properties");

  const output: unknown[] = [];
  nativeSetPrototypeOf(output, null);
  for (let index = 0; index < length; index++) {
    const key = `${index}`;
    const item = ownEnumerableDataValue(value, key);
    defineOwn(output, key, projectValue(item, budget, depth + 1, ancestors));
  }
  return output;
}

function projectObject(value: object, budget: Budget, depth: number, ancestors: WeakSet<object>): Record<string, unknown> {
  const prototype = nativeGetPrototypeOf(value);
  if (prototype !== objectPrototype && prototype !== null) throw new TypeError("custom object prototypes are not serializable");
  const keys = nativeOwnKeys(value);
  if (keys.length > MAX_OBJECT_KEYS) throw new TypeError("MCP JSON object has too many properties");
  budget.keys += keys.length;
  if (budget.keys > MAX_TOTAL_KEYS) throw new TypeError("MCP JSON has too many properties");

  const output = nativeCreate(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (typeof key !== "string") throw new TypeError("symbol properties are not serializable");
    accountString(key, budget);
    defineOwn(output, key, projectValue(ownEnumerableDataValue(value, key), budget, depth + 1, ancestors));
  }
  return output;
}

function projectValue(value: unknown, budget: Budget, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) throw new TypeError("MCP JSON is too deeply nested");
  budget.nodes++;
  if (budget.nodes > MAX_NODES) throw new TypeError("MCP JSON has too many values");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    accountString(value, budget);
    return value;
  }
  if (typeof value === "number") {
    if (!nativeIsFinite(value)) throw new TypeError("non-finite numbers are not serializable");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("unsupported MCP JSON value");
  // Proxy reflection traps can execute during getPrototypeOf/ownKeys/descriptor
  // inspection. Node exposes a side-effect-free proxy predicate; reject before
  // performing any reflection on an untrusted response value.
  if (nativeApply(nativeIsProxy, nodeTypes, [value])) throw new TypeError("proxy values are not serializable");
  if (nativeApply(nativeWeakSetHas, ancestors, [value])) throw new TypeError("cyclic MCP JSON value");
  nativeApply(nativeWeakSetAdd, ancestors, [value]);
  try {
    return nativeIsArray(value)
      ? projectArray(value, budget, depth, ancestors)
      : projectObject(value, budget, depth, ancestors);
  } finally {
    nativeApply(nativeWeakSetDelete, ancestors, [value]);
  }
}

function escapeLineSeparators(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\u0085") output += "\\u0085";
    else if (character === "\u2028") output += "\\u2028";
    else if (character === "\u2029") output += "\\u2029";
    else output += character;
    if (output.length > MAX_LINE_UNITS) throw new TypeError("MCP JSON line exceeds limits");
  }
  return output;
}

/** Serialize one JSON value without invoking inherited serializers or getters. */
export function mcpJsonText(value: unknown): string {
  const projected = projectValue(value, { nodes: 0, keys: 0, stringUnits: 0 }, 0, new NativeWeakSet<object>());
  const serialized = nativeApply(nativeStringify, jsonObject, [projected]) as string;
  if (serialized.length > MAX_LINE_UNITS) throw new TypeError("MCP JSON line exceeds limits");
  return escapeLineSeparators(serialized);
}

/** Serialize exactly one newline-delimited MCP JSON-RPC response. */
export function mcpJsonLine(value: unknown): string {
  return `${mcpJsonText(value)}\n`;
}
