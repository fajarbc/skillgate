import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(root, "fixtures", "cli-json-v1");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

// Intentionally strict evaluator for the schema keywords used by these fixtures.
// Unsupported keywords must fail instead of silently weakening the checks.
// A full standards-compliant JSON Schema validator is still needed for release.
function validate(schema, value, path = "$") {
  const supported = new Set(["$schema", "title", "description", "oneOf", "type", "const", "enum", "required", "properties", "items", "minLength"]);
  for (const keyword of Object.keys(schema)) {
    assert.ok(supported.has(keyword), `Unsupported fixture schema keyword: ${keyword}`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((variant) => {
      try { validate(variant, value, path); return true; } catch { return false; }
    });
    assert.equal(matches.length, 1, `${path}: expected exactly one matching variant`);
    return;
  }
  if ("const" in schema) assert.deepEqual(value, schema.const, `${path}: constant mismatch`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path}: unexpected enum value`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    assert.ok(types.includes(actual), `${path}: expected ${types.join("|")}, got ${actual}`);
  }
  if (schema.minLength !== undefined) {
    assert.equal(typeof value, "string", `${path}: expected string`);
    assert.ok(value.length >= schema.minLength, `${path}: too short`);
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
console.log(`CLI JSON v1 schema fixtures passed (${names.length} fixtures)`);
