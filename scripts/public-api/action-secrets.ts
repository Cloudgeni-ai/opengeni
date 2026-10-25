/**
 * Which app actions carry a key, password, token or other secret, derived
 * from their request and response schemas. Without full access, an agent in a
 * chat leaves these to the app: one click would otherwise put a lasting
 * secret into the conversation and the model provider's logs.
 *
 * A field counts when:
 * - its contract schema is marked with `secretValue(...)` (the
 *   `secretValues` registry in @opengeni/contracts), whatever the field is
 *   called: credential header and value bundles are marked where they are
 *   defined, so every action reusing them is caught; or
 * - as a backstop, its name says it holds a secret (`secretFieldName`:
 *   "apiKey", "clientSecret", "signingSecret", "token", "masterPassword"…)
 *   and its schema can hold one: a string, or an object or value with no
 *   named fields. Flags, numbers, fixed values and structured objects that
 *   only describe a credential ("credential": { connectionId }) don't count.
 *   A bare "code" counts only at the top of a request, where it is a sign-in
 *   code; elsewhere it is an error or status code.
 *
 * Every open map of strings in an action schema (the usual shape of a header
 * or credential bundle) must be marked or listed in ACTION_PLAIN_STRING_MAPS
 * with its reason, and a test fails when the catalog disagrees with this
 * derivation, so a new bundle can't slip through unclassified.
 */
import { z } from "zod";
import { secretValues } from "@opengeni/contracts";
import { secretFieldName } from "../../packages/contracts/src/tool-review-presentation";
import contractsPackage from "../../packages/contracts/package.json";

/** Routes whose secrets travel without a contract schema, matched against "METHOD /path". */
export const ACTION_SECRET_ROUTES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /^(GET|POST|PATCH|PUT) \/v1\/workspaces\/:workspaceId\/vaults\/:vaultId\/items(\/:itemId(\/fields\/.+|\/restore)?)?$/,
    reason:
      "a vault item's fields hold its secret values, and these routes have no contract schema",
  },
];

/** Field paths that match the rule but hold no secret, each with the reason. */
export const ACTION_SECRET_FIELD_EXCEPTIONS: ReadonlyArray<{ path: RegExp; reason: string }> = [
  {
    path: /\.previewToken$/,
    reason:
      "a digest of the previewed plugin uninstall, so the uninstall can't drift; not a credential",
  },
  {
    path: /\.references\.\w+$/,
    reason: "a vault item's secret references name a field for later use, never hold its value",
  },
];

/**
 * Open maps of strings in action schemas that hold no secret, each with the
 * reason. Any other such map must be marked with `secretValue(...)`.
 */
export const ACTION_PLAIN_STRING_MAPS: ReadonlyArray<{ path: RegExp; reason: string }> = [
  {
    path: /^response\.requiredHeaders$/,
    reason: "the content type and checksum headers a presigned upload must carry, not a credential",
  },
  {
    path: /\.failure\.detail$/,
    reason: "why a background command failed, as diagnostic text",
  },
  {
    path: /\.agent\.unavailableReasons$/,
    reason: "why parts of the agent are unavailable, as plain reasons",
  },
  {
    path: /\.references\.byField$/,
    reason: "a vault item's secret references by field: names for later use, never values",
  },
  {
    path: /\.entrySources\.(fallbackOrder|providers|rotation)$/,
    reason: "where each model account setting comes from (workspace or organization)",
  },
];

type JsonSchema = Record<string, unknown>;

/** Every schema exported by @opengeni/contracts and its subpaths, by name. */
async function contractSchemas(): Promise<Map<string, z.ZodType>> {
  const schemas = new Map<string, z.ZodType>();
  const subpaths = Object.keys(contractsPackage.exports as Record<string, unknown>);
  for (const subpath of subpaths.sort()) {
    const specifier =
      subpath === "." ? "@opengeni/contracts" : `@opengeni/contracts/${subpath.slice(2)}`;
    const module = (await import(specifier)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module))
      if (value instanceof z.ZodType && !schemas.has(name)) schemas.set(name, value);
  }
  return schemas;
}

const SCHEMAS = await contractSchemas();

function resolve(root: JsonSchema, schema: unknown): JsonSchema | null {
  if (!schema || typeof schema !== "object") return null;
  const ref = (schema as JsonSchema).$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const defs = (root.$defs ?? {}) as Record<string, unknown>;
    return resolve(root, defs[ref.slice("#/$defs/".length)]);
  }
  return schema as JsonSchema;
}

function variants(root: JsonSchema, schema: unknown): JsonSchema[] {
  const resolved = resolve(root, schema);
  if (!resolved) return [];
  const options = [resolved.anyOf, resolved.oneOf].find(Array.isArray) as unknown[] | undefined;
  return options ? options.flatMap((option) => variants(root, option)) : [resolved];
}

/** Whether a field's schema is marked with `secretValue(...)` in the contracts. */
function markedSecret(root: JsonSchema, schema: unknown): boolean {
  return variants(root, schema).some((option) => option.secret === true);
}

/** Whether a field's schema is an open map of strings: no named fields, string values. */
function openStringMap(root: JsonSchema, schema: unknown): boolean {
  return variants(root, schema).some((option) => {
    if (option.type !== "object" || (option.properties && Object.keys(option.properties).length))
      return false;
    const values = variants(root, option.additionalProperties);
    return values.length > 0 && values.every((value) => value.type === "string");
  });
}

/** Whether a field's schema can hold a secret value: a string, or an unstructured object or value. */
function canHoldSecret(root: JsonSchema, schema: unknown): boolean {
  const options = variants(root, schema);
  if (options.length === 0) return true;
  if (options.some((option) => option.properties && Object.keys(option.properties).length > 0))
    return false;
  return options.some((option) => {
    if (option.enum !== undefined || option.const !== undefined) return false;
    const types = Array.isArray(option.type) ? option.type : [option.type];
    return types.some((type) => type === undefined || type === "string" || type === "object");
  });
}

function secretPaths(
  root: JsonSchema,
  schema: unknown,
  prefix: string,
  out: Set<string>,
  seen: Set<unknown>,
) {
  for (const option of variants(root, schema)) {
    if (seen.has(option)) continue;
    seen.add(option);
    const properties = (option.properties ?? {}) as Record<string, unknown>;
    for (const [name, field] of Object.entries(properties)) {
      const path = `${prefix}.${name}`;
      const topRequestCode = name === "code" && prefix === "request";
      if (
        markedSecret(root, field) ||
        ((topRequestCode || (name !== "code" && secretFieldName(name))) &&
          !ACTION_SECRET_FIELD_EXCEPTIONS.some((exception) => exception.path.test(path)) &&
          canHoldSecret(root, field))
      ) {
        out.add(path);
      }
      secretPaths(root, field, path, out, seen);
    }
    for (const key of ["items", "additionalProperties"]) {
      if (option[key] && typeof option[key] === "object")
        secretPaths(root, option[key], `${prefix}[]`, out, seen);
    }
    if (Array.isArray(option.allOf))
      for (const part of option.allOf) secretPaths(root, part, prefix, out, seen);
  }
}

/**
 * Where an action carries a secret: field paths such as "request.apiKey" or
 * "response.token", or the reason from ACTION_SECRET_ROUTES. Empty when none.
 */
export function actionSecretFields(route: {
  method: string;
  path: string;
  request: readonly string[];
  response: readonly string[];
}): string[] {
  const out = new Set<string>();
  const key = `${route.method} ${route.path}`;
  for (const rule of ACTION_SECRET_ROUTES)
    if (rule.pattern.test(key)) out.add(`route: ${rule.reason}`);
  for (const [side, names] of [
    ["request", route.request],
    ["response", route.response],
  ] as const) {
    for (const name of names) {
      const schema = SCHEMAS.get(name);
      if (!schema) throw new Error(`Unknown contract schema ${name} for ${key}`);
      for (const path of schemaSecretFields(schema, side)) out.add(path);
    }
  }
  return [...out].sort();
}

/** The secret-carrying field paths of one request or response schema. */
export function schemaSecretFields(schema: z.ZodType, side: "request" | "response"): string[] {
  const root = z.toJSONSchema(schema, {
    io: side === "request" ? "input" : "output",
    unrepresentable: "any",
    cycles: "ref",
    metadata: secretValues,
  }) as JsonSchema;
  const out = new Set<string>();
  secretPaths(root, root, side, out, new Set());
  return [...out].sort();
}

/** Every field path of a named contract schema, for checking that the exceptions still apply. */
export function actionFieldPaths(name: string, side: "request" | "response"): string[] {
  const schema = SCHEMAS.get(name);
  if (!schema) return [];
  const root = z.toJSONSchema(schema, {
    io: side === "request" ? "input" : "output",
    unrepresentable: "any",
    cycles: "ref",
    metadata: secretValues,
  }) as JsonSchema;
  const out = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown, prefix: string) => {
    for (const option of variants(root, node)) {
      if (seen.has(option)) continue;
      seen.add(option);
      for (const [field, child] of Object.entries(
        (option.properties ?? {}) as Record<string, unknown>,
      )) {
        out.add(`${prefix}.${field}`);
        walk(child, `${prefix}.${field}`);
      }
      for (const key of ["items", "additionalProperties"])
        if (option[key] && typeof option[key] === "object") walk(option[key], `${prefix}[]`);
      if (Array.isArray(option.allOf)) for (const part of option.allOf) walk(part, prefix);
    }
  };
  walk(root, side);
  return [...out];
}

/**
 * Open maps of strings in one named contract schema that are neither marked
 * secret nor listed in ACTION_PLAIN_STRING_MAPS: each needs a decision.
 */
export function unclassifiedStringMaps(name: string, side: "request" | "response"): string[] {
  const schema = SCHEMAS.get(name);
  if (!schema) return [];
  const root = z.toJSONSchema(schema, {
    io: side === "request" ? "input" : "output",
    unrepresentable: "any",
    cycles: "ref",
    metadata: secretValues,
  }) as JsonSchema;
  const out = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown, prefix: string) => {
    for (const option of variants(root, node)) {
      if (seen.has(option)) continue;
      seen.add(option);
      for (const [field, child] of Object.entries(
        (option.properties ?? {}) as Record<string, unknown>,
      )) {
        const path = `${prefix}.${field}`;
        if (
          openStringMap(root, child) &&
          !markedSecret(root, child) &&
          !ACTION_PLAIN_STRING_MAPS.some((entry) => entry.path.test(path))
        )
          out.add(path);
        walk(child, path);
      }
      for (const key of ["items", "additionalProperties"])
        if (option[key] && typeof option[key] === "object") walk(option[key], `${prefix}[]`);
      if (Array.isArray(option.allOf)) for (const part of option.allOf) walk(part, prefix);
    }
  };
  walk(root, side);
  return [...out].sort();
}
