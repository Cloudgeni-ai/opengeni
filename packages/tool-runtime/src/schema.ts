import Ajv, { type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import type { CanonicalToolJsonSchema } from "@opengeni/contracts";
import { digestCanonicalJson } from "./catalog";

export type CanonicalToolSchemaValidator = ValidateFunction<unknown>;
export type CanonicalToolSchemaCompilers = Readonly<{
  draft7: SchemaCompiler;
  draft2019: SchemaCompiler;
  draft2020: SchemaCompiler;
}>;

export type CanonicalToolSchemaValidators = Readonly<{
  input: CanonicalToolSchemaValidator;
  output: CanonicalToolSchemaValidator | null;
}>;

type SchemaCompiler = { compile(schema: object): ValidateFunction<unknown> };

export class CanonicalToolInputValidationError extends Error {
  readonly code = "invalid_tool_arguments";

  constructor() {
    super("Tool arguments do not match the canonical tool input schema");
    this.name = "CanonicalToolInputValidationError";
  }
}

export class CanonicalToolOutputValidationError extends Error {
  readonly code = "invalid_tool_result";

  constructor() {
    super("Tool result does not match the canonical tool output schema");
    this.name = "CanonicalToolOutputValidationError";
  }
}

// Validator compilation is structural and independent of caller identity,
// executable closures, credentials, and authorization. Reuse only exact
// content-addressed validators. The hard cap prevents an untrusted schema
// stream from turning the process cache into a memory sink.
export const CANONICAL_TOOL_SCHEMA_CACHE_MAX_ENTRIES = 512;
const compiledCanonicalToolSchemaCache = new Map<string, ValidateFunction<unknown>>();

export function createCanonicalToolSchemaCompilers(): CanonicalToolSchemaCompilers {
  const options = {
    allErrors: false,
    coerceTypes: false,
    strict: false,
    useDefaults: false,
    validateFormats: false,
  } as const;
  return {
    draft7: new Ajv(options),
    draft2019: new Ajv2019(options),
    draft2020: new Ajv2020(options),
  };
}

export function compileCanonicalToolSchema(
  schema: CanonicalToolJsonSchema,
  compilers: CanonicalToolSchemaCompilers = createCanonicalToolSchemaCompilers(),
): CanonicalToolSchemaValidator {
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  const family = dialect.includes("2020-12")
    ? "2020-12"
    : dialect.includes("2019-09")
      ? "2019-09"
      : "draft7";
  const cacheKey = `${family}:${digestCanonicalJson(schema)}`;
  const cached = compiledCanonicalToolSchemaCache.get(cacheKey);
  if (cached) {
    compiledCanonicalToolSchemaCache.delete(cacheKey);
    compiledCanonicalToolSchemaCache.set(cacheKey, cached);
    return cached;
  }
  const compiled =
    family === "2020-12"
      ? compilers.draft2020.compile(schema)
      : family === "2019-09"
        ? compilers.draft2019.compile(schema)
        : compilers.draft7.compile(schema);
  while (compiledCanonicalToolSchemaCache.size >= CANONICAL_TOOL_SCHEMA_CACHE_MAX_ENTRIES) {
    const oldest = compiledCanonicalToolSchemaCache.keys().next().value;
    if (oldest === undefined) break;
    compiledCanonicalToolSchemaCache.delete(oldest);
  }
  compiledCanonicalToolSchemaCache.set(cacheKey, compiled);
  return compiled;
}

export function compileCanonicalToolSchemaValidators(input: {
  inputSchema: CanonicalToolJsonSchema;
  outputSchema?: CanonicalToolJsonSchema;
}): CanonicalToolSchemaValidators {
  const compilers = createCanonicalToolSchemaCompilers();
  return {
    input: compileCanonicalToolSchema(input.inputSchema, compilers),
    output: input.outputSchema ? compileCanonicalToolSchema(input.outputSchema, compilers) : null,
  };
}

export function assertCanonicalToolInput(
  validator: CanonicalToolSchemaValidator,
  argumentsValue: unknown,
): void {
  if (!validator(argumentsValue)) throw new CanonicalToolInputValidationError();
}

export function assertCanonicalToolOutput(
  validator: CanonicalToolSchemaValidator,
  structuredContent: unknown,
): void {
  if (!validator(structuredContent)) throw new CanonicalToolOutputValidationError();
}

/** Honest JSON-Schema-to-TypeScript projection used by declaration generation. */
export function jsonSchemaToTypeScript(schema: unknown): string {
  return schemaType(schema, schema, new Set<string>(), 0);
}

export function rootObjectArgumentsAreOptional(schema: unknown): boolean {
  if (!isSchemaObject(schema)) return false;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  return required.length === 0 && (schema.type === "object" || isSchemaObject(schema.properties));
}

function schemaType(
  schema: unknown,
  rootSchema: unknown,
  resolvingRefs: Set<string>,
  depth: number,
): string {
  if (depth > 48 || schema === true) return "unknown";
  if (schema === false) return "never";
  if (!isSchemaObject(schema)) return "unknown";

  if (typeof schema.$ref === "string") {
    const reference = schema.$ref;
    if (!reference.startsWith("#/") || resolvingRefs.has(reference)) return "unknown";
    const resolved = resolveLocalReference(rootSchema, reference);
    if (resolved === undefined) return "unknown";
    const next = new Set(resolvingRefs);
    next.add(reference);
    return schemaType(resolved, rootSchema, next, depth + 1);
  }

  if (Object.hasOwn(schema, "const")) return literalType(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(literalType));

  const composites: string[] = [];
  if (Array.isArray(schema.oneOf)) {
    composites.push(
      union(schema.oneOf.map((part) => schemaType(part, rootSchema, resolvingRefs, depth + 1))),
    );
  }
  if (Array.isArray(schema.anyOf)) {
    composites.push(
      union(schema.anyOf.map((part) => schemaType(part, rootSchema, resolvingRefs, depth + 1))),
    );
  }
  if (Array.isArray(schema.allOf)) {
    composites.push(
      intersection(
        schema.allOf.map((part) => schemaType(part, rootSchema, resolvingRefs, depth + 1)),
      ),
    );
  }
  if (composites.length > 0) {
    const composed = intersection(composites);
    return schema.nullable === true ? union([composed, "null"]) : composed;
  }

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((value): value is string => typeof value === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : inferredSchemaTypes(schema);
  const rendered = declaredTypes.map((type) =>
    typeType(type, schema, rootSchema, resolvingRefs, depth + 1),
  );
  if (schema.nullable === true) rendered.push("null");
  return union(rendered.length > 0 ? rendered : ["unknown"]);
}

function inferredSchemaTypes(schema: Record<string, unknown>): string[] {
  if (isSchemaObject(schema.properties) || Object.hasOwn(schema, "additionalProperties")) {
    return ["object"];
  }
  if (Object.hasOwn(schema, "items") || Array.isArray(schema.prefixItems)) return ["array"];
  return [];
}

function typeType(
  type: string,
  schema: Record<string, unknown>,
  rootSchema: unknown,
  resolvingRefs: Set<string>,
  depth: number,
): string {
  switch (type) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "array":
      return arrayType(schema, rootSchema, resolvingRefs, depth);
    case "object":
      return objectType(schema, rootSchema, resolvingRefs, depth);
    default:
      return "unknown";
  }
}

function arrayType(
  schema: Record<string, unknown>,
  rootSchema: unknown,
  resolvingRefs: Set<string>,
  depth: number,
): string {
  if (Array.isArray(schema.prefixItems)) {
    const tuple = schema.prefixItems.map((item) =>
      schemaType(item, rootSchema, resolvingRefs, depth + 1),
    );
    if (schema.items === false) return `readonly [${tuple.join(", ")}]`;
    const rest =
      schema.items === undefined || schema.items === true
        ? "unknown"
        : schemaType(schema.items, rootSchema, resolvingRefs, depth + 1);
    return `readonly [${tuple.join(", ")}${tuple.length > 0 ? ", " : ""}...${rest}[]]`;
  }
  const item =
    schema.items === undefined || schema.items === true
      ? "unknown"
      : schemaType(schema.items, rootSchema, resolvingRefs, depth + 1);
  return `readonly (${item})[]`;
}

function objectType(
  schema: Record<string, unknown>,
  rootSchema: unknown,
  resolvingRefs: Set<string>,
  depth: number,
): string {
  const properties = isSchemaObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const entries = Object.entries(properties).sort(([left], [right]) => left.localeCompare(right));
  const fields = entries.map(([name, propertySchema]) => {
    const key = identifierOrQuoted(name);
    const optional = required.has(name) ? "" : "?";
    return `readonly ${key}${optional}: ${schemaType(
      propertySchema,
      rootSchema,
      resolvingRefs,
      depth + 1,
    )}`;
  });
  for (const missing of [...required].filter((name) => !Object.hasOwn(properties, name)).sort()) {
    fields.push(`readonly ${identifierOrQuoted(missing)}: unknown`);
  }

  const additional = schema.additionalProperties;
  if (additional !== false) {
    if (entries.length === 0 && additional !== undefined && additional !== true) {
      return `Readonly<Record<string, ${schemaType(
        additional,
        rootSchema,
        resolvingRefs,
        depth + 1,
      )}>>`;
    }
    // Known properties and typed additional properties can have incompatible
    // value types. `unknown` preserves legal values without fabricating a lie.
    fields.push("readonly [key: string]: unknown");
  }
  return fields.length === 0 ? "Record<string, never>" : `{ ${fields.join("; ")} }`;
}

function resolveLocalReference(rootSchema: unknown, reference: string): unknown {
  let current = rootSchema;
  for (const encoded of reference.slice(2).split("/")) {
    if (!isSchemaObject(current)) return undefined;
    const segment = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function literalType(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `readonly [${value.map(literalType).join(", ")}]`;
  if (isSchemaObject(value)) {
    return `{ ${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `readonly ${identifierOrQuoted(key)}: ${literalType(child)}`)
      .join("; ")} }`;
  }
  return "unknown";
}

function union(types: string[]): string {
  const unique = [...new Set(types)];
  if (unique.includes("unknown")) return "unknown";
  if (unique.length === 0) return "never";
  return unique.length === 1 ? unique[0]! : unique.map(parenthesizeComposite).join(" | ");
}

function intersection(types: string[]): string {
  const unique = [...new Set(types.filter((type) => type !== "unknown"))];
  if (unique.length === 0) return "unknown";
  return unique.length === 1 ? unique[0]! : unique.map(parenthesizeComposite).join(" & ");
}

function parenthesizeComposite(type: string): string {
  return /[|&]/u.test(type) ? `(${type})` : type;
}

function identifierOrQuoted(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) ? value : JSON.stringify(value);
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
