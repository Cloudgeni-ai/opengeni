import type { AttemptToolJsonSchema } from "@opengeni/contracts";
import { z } from "zod";

type JsonSchemaNode = Record<string, unknown>;

/** Keywords that only constrain validation. The tool's Zod schema still
 * enforces them before execution, and rejects with the exact field. */
const VALIDATION_ONLY_KEYWORDS = new Set(["$schema", "$id", "minLength", "maxLength"]);
/** Larger numeric bounds are overflow guards, not guidance. */
const MEANINGFUL_NUMERIC_BOUND = 100_000;
const MEANINGFUL_MAX_ITEMS = 64;
/** Longer patterns (UUIDs, control-character guards) are validation noise. */
const MEANINGFUL_PATTERN_LENGTH = 32;

/**
 * The JSON Schema an interaction tool shows the model.
 *
 * Model providers expand every `$ref` when they render a tool, so a tagged
 * union such as a browser action, whose locator union repeats in each of its
 * twenty variants, costs several thousand tokens. Each tagged union of objects
 * is shown as one object instead: the tag lists every variant, each field
 * appears once, and one compact line names the fields each variant takes.
 * Validation-only limits are left out. The tool's own Zod schema stays the
 * authority and rejects any invalid combination with the exact field.
 */
export function interactionToolInputJsonSchema(schema: z.ZodType): AttemptToolJsonSchema {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12" }) as JsonSchemaNode;
  return modelFacingSchema(generated) as AttemptToolJsonSchema;
}

/** Per-variant field lists of a flattened union, for the enclosing summary. */
const flattenedVariants = new WeakMap<JsonSchemaNode, Array<[string, string[]]>>();

function modelFacingSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(modelFacingSchema);
  if (!isNode(node)) return node;
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (VALIDATION_ONLY_KEYWORDS.has(key)) continue;
    if (key === "additionalProperties" && value === false) continue;
    if (
      (key === "minimum" || key === "maximum") &&
      typeof value === "number" &&
      Math.abs(value) >= MEANINGFUL_NUMERIC_BOUND
    ) {
      continue;
    }
    if (key === "minItems" && typeof value === "number" && value <= 1) continue;
    if (key === "maxItems" && typeof value === "number" && value > MEANINGFUL_MAX_ITEMS) continue;
    if (
      key === "pattern" &&
      typeof value === "string" &&
      value.length > MEANINGFUL_PATTERN_LENGTH
    ) {
      continue;
    }
    out[key] = modelFacingSchema(value);
  }
  for (const unionKey of ["oneOf", "anyOf"] as const) {
    const members = out[unionKey];
    if (!Array.isArray(members)) continue;
    const flattened = flattenTaggedUnion(members);
    if (!flattened) continue;
    delete out[unionKey];
    const { description, ...rest } = flattened;
    Object.assign(out, rest);
    const own = typeof out.description === "string" ? out.description : "";
    out.description = own ? `${own} ${String(description)}` : description;
    flattenedVariants.set(out, flattenedVariants.get(flattened) ?? []);
  }
  return out;
}

/** One object for a union whose members are objects sharing a string tag.
 * Null when the union is not such a tagged union. */
function flattenTaggedUnion(members: unknown[]): JsonSchemaNode | null {
  if (members.length < 2 || !members.every(isObjectSchema)) return null;
  const objects = members as Array<JsonSchemaNode & { properties: Record<string, unknown> }>;
  const tag = ["type", "kind", "operation"].find((candidate) =>
    objects.every((member) => tagValues(member.properties[candidate]) !== null),
  );
  if (!tag) return null;

  const variants: Array<[string, string[]]> = [];
  const tagValuesInOrder: string[] = [];
  const properties = new Map<string, unknown[]>();
  for (const member of objects) {
    const nested = flattenedVariants.get(member);
    const required = new Set(Array.isArray(member.required) ? (member.required as string[]) : []);
    if (nested) {
      variants.push(...nested);
    } else {
      const fields = Object.keys(member.properties)
        .filter((field) => field !== tag)
        .map((field) => (required.has(field) ? field : `${field}?`));
      for (const value of tagValues(member.properties[tag])!) variants.push([value, fields]);
    }
    for (const value of tagValues(member.properties[tag])!) {
      if (!tagValuesInOrder.includes(value)) tagValuesInOrder.push(value);
    }
    for (const [field, schema] of Object.entries(member.properties)) {
      if (field === tag) continue;
      const seen = properties.get(field) ?? [];
      if (!seen.some((existing) => sameSchema(existing, schema))) seen.push(schema);
      properties.set(field, seen);
    }
  }

  const merged: Record<string, unknown> = {
    [tag]: { type: "string", enum: tagValuesInOrder },
  };
  for (const [field, schemas] of properties) {
    merged[field] = schemas.length === 1 ? schemas[0] : mergeAlternatives(schemas);
  }
  const summary = mergeSameTagVariants(variants)
    .map(([value, fields]) => (fields.length > 0 ? `${value}: ${fields.join(", ")}` : value))
    .join("; ");
  const flattened: JsonSchemaNode = {
    type: "object",
    properties: merged,
    required: [tag],
    description: `Fields by ${tag} (? = optional): ${summary}.`,
  };
  flattenedVariants.set(flattened, variants);
  return flattened;
}

/**
 * One summary entry per tag value. Several members can share a value (for
 * example one variant with an optional id and one without); a field is then
 * required only when every such member requires it.
 */
function mergeSameTagVariants(variants: Array<[string, string[]]>): Array<[string, string[]]> {
  const byValue = new Map<string, Array<string[]>>();
  for (const [value, fields] of variants) {
    const seen = byValue.get(value) ?? [];
    seen.push(fields);
    byValue.set(value, seen);
  }
  return [...byValue].map(([value, members]) => {
    if (members.length === 1) return [value, members[0]!];
    const names: string[] = [];
    for (const fields of members) {
      for (const field of fields) {
        const name = field.endsWith("?") ? field.slice(0, -1) : field;
        if (!names.includes(name)) names.push(name);
      }
    }
    return [
      value,
      names.map((name) => (members.every((fields) => fields.includes(name)) ? name : `${name}?`)),
    ];
  });
}

function mergeAlternatives(schemas: unknown[]): unknown {
  if (schemas.every((schema) => tagValues(schema) !== null)) {
    return { type: "string", enum: [...new Set(schemas.flatMap((schema) => tagValues(schema)!))] };
  }
  return { anyOf: schemas };
}

function tagValues(schema: unknown): string[] | null {
  if (!isNode(schema)) return null;
  if (typeof schema.const === "string") return [schema.const];
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((value) => typeof value === "string")
  ) {
    return schema.enum as string[];
  }
  return null;
}

function isObjectSchema(schema: unknown): boolean {
  return isNode(schema) && schema.type === "object" && isNode(schema.properties);
}

function sameSchema(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_REPORTED_ISSUES = 4;
const MAX_ISSUE_MESSAGE_CHARS = 240;

/**
 * Name exactly what is wrong with invalid tool arguments. A union failure
 * reports the variant the arguments chose (the one whose tag matched), so a
 * click without a locator role says `action.locator.role`, not only "invalid".
 */
export function describeInvalidToolArguments(error: z.ZodError): string {
  const issues = leafIssues(error.issues, []).slice(0, MAX_REPORTED_ISSUES);
  const described = issues.map(({ path, message }) => {
    const text = message.replace(/^Invalid input: /u, "").slice(0, MAX_ISSUE_MESSAGE_CHARS);
    return path.length > 0 ? `${path.join(".")}: ${text}` : text;
  });
  return `Interaction tool arguments are invalid: ${described.join("; ")}.`;
}

type LeafIssue = { path: PropertyKey[]; message: string };

function leafIssues(issues: readonly z.core.$ZodIssue[], base: PropertyKey[]): LeafIssue[] {
  const leaves: LeafIssue[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      leaves.push(...leafIssues(chosenUnionBranch(issue.errors), path));
      continue;
    }
    if (issue.code === "unrecognized_keys") {
      leaves.push({ path, message: `unexpected field ${issue.keys.join(", ")}` });
      continue;
    }
    leaves.push({ path, message: issue.message });
  }
  return leaves;
}

/** The union branch the arguments meant: one whose tag matched, else the
 * branch that reports the unknown tag, else the one with the fewest issues. */
function chosenUnionBranch(branches: z.core.$ZodIssue[][]): z.core.$ZodIssue[] {
  const tagMismatch = (issue: z.core.$ZodIssue): boolean =>
    (issue.code === "invalid_union" && issue.errors.length === 0) ||
    (issue.code === "invalid_value" &&
      ["type", "kind", "operation"].includes(String(issue.path.at(-1))));
  const matching = branches.filter((branch) => !branch.some(tagMismatch));
  if (matching.length > 0) {
    return matching.reduce((best, branch) => (branch.length < best.length ? branch : best));
  }
  const unknownTag = branches.find((branch) =>
    branch.some((issue) => issue.code === "invalid_union" && issue.errors.length === 0),
  );
  return (
    unknownTag?.filter((issue) => issue.code === "invalid_union") ??
    branches.reduce((best, branch) => (branch.length < best.length ? branch : best))
  );
}
