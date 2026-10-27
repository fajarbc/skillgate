import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(root, "fixtures", "cli-json-v1");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/** JSON Schema equality ignores object property order and treats -0 as 0.
 * Node's deepStrictEqual incorrectly distinguishes signed zero for JSON data.
 */
function jsonEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right ||
      typeof left !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

// Intentionally strict evaluator for the schema keywords used by these fixtures.
// Unsupported keywords must fail instead of silently weakening the checks.
// A full standards-compliant JSON Schema validator is still needed for release.
export function validate(schema, value, path = "$") {
  const supported = new Set(["$schema", "title", "description", "oneOf", "allOf", "type", "const", "enum", "required", "properties", "items", "minLength", "maxLength", "pattern", "minItems", "maxItems", "minimum", "maximum", "additionalProperties"]);
  for (const keyword of Object.keys(schema)) {
    assert.ok(supported.has(keyword), `Unsupported fixture schema keyword: ${keyword}`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((variant) => {
      try { validate(variant, value, path); return true; } catch { return false; }
    });
    assert.equal(matches.length, 1, `${path}: expected exactly one matching variant`);
    // oneOf is an applicator, not a short circuit: sibling keywords must
    // still constrain the same instance (JSON Schema 2020-12 semantics).
  }
  if (schema.allOf !== undefined) {
    assert.ok(Array.isArray(schema.allOf) && schema.allOf.length > 0,
      `${path}: invalid allOf schema`);
    for (const variant of schema.allOf) validate(variant, value, path);
  }
  if ("const" in schema) assert.ok(jsonEqual(value, schema.const), `${path}: constant mismatch`);
  if (schema.enum) assert.ok(schema.enum.some((candidate) => jsonEqual(candidate, value)),
    `${path}: unexpected enum value`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    assert.ok(types.some((type) => type === "integer"
      ? typeof value === "number" && Number.isSafeInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
      : type === actual), `${path}: expected ${types.join("|")}, got ${actual}`);
  }
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    assert.equal(typeof value, "string", `${path}: expected string`);
    // JSON Schema measures string lengths in Unicode code points, not UTF-16 units.
    const length = Array.from(value).length;
    if (schema.minLength !== undefined) assert.ok(length >= schema.minLength, `${path}: too short`);
    if (schema.maxLength !== undefined) assert.ok(length <= schema.maxLength, `${path}: too long`);
  }
  if (schema.pattern) {
    assert.equal(typeof value, "string", `${path}: expected string`);
    assert.match(value, new RegExp(schema.pattern), `${path}: pattern mismatch`);
  }
  if (schema.minItems !== undefined || schema.maxItems !== undefined) {
    assert.ok(Array.isArray(value), `${path}: expected array`);
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path}: too few items`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${path}: too many items`);
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    assert.ok(typeof value === "number" && Number.isFinite(value), `${path}: expected finite number`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path}: below minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path}: above maximum`);
  }
  if (schema.additionalProperties !== undefined) {
    assert.equal(typeof schema.additionalProperties, "boolean", `${path}: unsupported additionalProperties schema`);
    if (schema.additionalProperties === false && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) assert.ok(allowed.has(key), `${path}: unexpected property ${key}`);
    }
  }
  if (schema.required) {
    for (const key of schema.required) assert.ok(Object.hasOwn(value, key), `${path}: missing ${key}`);
  }
  if (schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
  }
}

async function validateFixtures() {
  const output = await readJson(join(root, "schemas", "cli-json-v1.schema.json"));
  const input = await readJson(join(root, "schemas", "cli-json-stdin-v1.schema.json"));
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith(".json")).sort();
  assert.equal(names.length, 8, "expected all eight v1 golden fixtures");
  for (const name of names) {
    const fixture = await readJson(join(fixtureDir, name));
    validate(name === "stdin-request.json" ? input : output, fixture);
  }
  assert.throws(() => validate(output, { protocolVersion: 2, command: "scan", ok: true, data: {} }));
  assert.throws(() => validate(input, { protocolVersion: 1, task: 42 }));
  assert.throws(() => validate(input, { protocolVersion: 1, task: "  " }));
  assert.throws(() => validate(input, { protocolVersion: 1, task: "ok", context: { paths: [" "] } }));
  // The same strict subset also validates MCP tool schemas in the built smoke.
  // Exercise each added keyword here, independently of a compiled MCP server.
  const bounded = {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 2, pattern: "\\S" },
      count: { type: "integer", minimum: 1, maximum: 3 },
      entries: { type: "array", maxItems: 1, items: { type: "string" } },
    },
    required: ["name", "count", "entries"],
    additionalProperties: false,
  };
  const valid = { name: "🛡🛡", count: 2, entries: ["ok"] };
  validate(bounded, valid);
  for (const invalid of [
    { ...valid, name: "🛡🛡🛡" },
    { ...valid, name: " " },
    { ...valid, count: 1.5 },
    { ...valid, count: 0 },
    { ...valid, count: 4 },
    { ...valid, entries: ["a", "b"] },
    { ...valid, extra: true },
    { name: "ok", count: 1 },
  ]) assert.throws(() => validate(bounded, invalid));
  // JSON Schema enum compares JSON values structurally, not by object
  // identity. A validator that uses Array.includes rejects valid objects.
  const enumSchema = { enum: [
    { name: "safe", flags: [true, null] },
    ["rank", { limit: 2 }],
    0,
  ] };
  validate(enumSchema, { flags: [true, null], name: "safe" });
  validate(enumSchema, ["rank", { limit: 2 }]);
  validate(enumSchema, 0);
  for (const invalid of [
    { name: "safe", flags: [true, false] },
    ["rank", { limit: 3 }],
    "0",
    { name: "safe", flags: [true, null], secret: "unexpected" },
  ]) assert.throws(() => validate(enumSchema, invalid), /unexpected enum value/);
  // oneOf must not bypass sibling object/ownership constraints. A value can
  // match exactly one variant and still violate the enclosing schema.
  const combined = {
    type: "object",
    oneOf: [
      { type: "object", properties: { kind: { const: "safe" } }, required: ["kind"] },
      { type: "object", properties: { kind: { const: "other" } }, required: ["kind"] },
    ],
    properties: { kind: { type: "string" } },
    required: ["kind"],
    additionalProperties: false,
  };
  validate(combined, { kind: "safe" });
  validate(combined, { kind: "other" });
  assert.throws(() => validate(combined, { kind: "safe", path: "/etc/passwd" }),
    /unexpected property/);
  assert.throws(() => validate({ ...combined, required: ["kind", "token"] }, { kind: "safe" }),
    /missing token/);
  assert.throws(() => validate({ ...combined, type: "array" }, { kind: "safe" }),
    /expected array/);
  // A JavaScript number is not necessarily a representable JSON number.
  // Never approve NaN/Infinity before an MCP result is serialized to JSON.
  validate({ type: "number" }, 0);
  validate({ type: "number" }, 1.25);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.throws(() => validate({ type: "number" }, invalid), /expected number/);
    assert.throws(() => validate({ type: ["number", "null"] }, invalid), /expected number\\|null/);
  }
  assert.throws(() => validate({ type: "object", unevaluatedProperties: false }, {}),
    /Unsupported fixture schema keyword/);
  // allOf applies in addition to sibling constraints, including nested MCP
  // display-name restrictions. A trailing newline must not pass via $ anchoring.
  const safeDisplayName = {
    type: "string", pattern: "\\S",
    allOf: [{ pattern: String.raw`^(?![\s\S]*[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069])[\s\S]*$` }],
  };
  validate(safeDisplayName, "React 東京 🛡️");
  for (const invalid of [" ", "React\n", "React\u001b[31m", "React\u202e"]) {
    assert.throws(() => validate(safeDisplayName, invalid), /pattern mismatch/);
  }
  assert.throws(() => validate({ allOf: [] }, "ok"), /invalid allOf schema/);
  assert.throws(() => validate({ type: "object", allOf: [{ required: ["name"] }] }, {}),
    /missing name/);
  console.log(`CLI JSON v1 schema fixtures passed (${names.length} fixtures)`);
}

// Importing the validator from built CLI smoke must not execute fixture checks.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateFixtures();
}
