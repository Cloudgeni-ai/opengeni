/**
 * An MCP event's subscription settings as a form. MCP servers describe a
 * subscription's arguments with a JSON Schema; flat schemas of text, numbers,
 * yes/no and fixed choices become labelled fields, and anything richer is
 * edited as JSON. The draft keeps the arguments as JSON text either way, so
 * keys the form doesn't show survive an edit.
 */

/** One argument the form can edit. */
export type EventArgumentField = {
  name: string;
  /** The schema's title, else the property name in words. */
  label: string;
  description: string | null;
  required: boolean;
} & (
  | {
      kind: "text";
      /** The schema's `format`, such as "uuid" or "email". */
      format: string | null;
      placeholder: string | null;
    }
  | { kind: "number"; integer: boolean; placeholder: string | null }
  | { kind: "boolean" }
  | { kind: "choice"; options: EventArgumentOption[] }
);

export interface EventArgumentOption {
  value: string | number | boolean;
  label: string;
}

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** "projectId" -> "Project id", "max_items" -> "Max items". */
export function eventArgumentLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function scalarExample(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function choiceOptions(property: Schema): EventArgumentOption[] | null {
  if (Array.isArray(property.enum)) {
    const values = property.enum.filter(
      (value): value is string | number | boolean =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean",
    );
    if (values.length === 0 || values.length !== property.enum.length) return null;
    return values.map((value) => ({ value, label: String(value) }));
  }
  const variants = Array.isArray(property.oneOf)
    ? property.oneOf
    : Array.isArray(property.anyOf)
      ? property.anyOf
      : null;
  if (!variants || variants.length === 0) return null;
  const options: EventArgumentOption[] = [];
  for (const variant of variants) {
    if (!isSchema(variant) || !("const" in variant)) return null;
    const value = variant.const;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      return null;
    options.push({
      value,
      label: typeof variant.title === "string" && variant.title ? variant.title : String(value),
    });
  }
  return options;
}

function argumentField(
  name: string,
  property: unknown,
  required: boolean,
): EventArgumentField | null {
  if (!isSchema(property)) return null;
  const base = {
    name,
    label:
      typeof property.title === "string" && property.title.trim()
        ? property.title.trim()
        : eventArgumentLabel(name),
    description:
      typeof property.description === "string" && property.description.trim()
        ? property.description.trim()
        : null,
    required,
  };
  const options = choiceOptions(property);
  if (options) return { ...base, kind: "choice", options };
  const examples = Array.isArray(property.examples) ? property.examples : [];
  const placeholder = scalarExample(property.default) ?? scalarExample(examples[0]);
  switch (property.type) {
    case "string":
      return {
        ...base,
        kind: "text",
        format: typeof property.format === "string" ? property.format : null,
        placeholder,
      };
    case "number":
    case "integer":
      return { ...base, kind: "number", integer: property.type === "integer", placeholder };
    case "boolean":
      return { ...base, kind: "boolean" };
    default:
      return null;
  }
}

/**
 * The fields for a subscription's arguments, required ones first; an empty
 * list when it takes none, and null when the schema needs JSON (nested
 * objects, lists, or types the form can't show).
 */
export function eventArgumentFields(
  schema: Record<string, unknown> | null | undefined,
): EventArgumentField[] | null {
  if (!schema) return [];
  if (schema.type !== undefined && schema.type !== "object") return null;
  const properties = schema.properties;
  if (properties === undefined) return [];
  if (!isSchema(properties)) return null;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const fields: EventArgumentField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const field = argumentField(name, property, required.has(name));
    if (!field) return null;
    fields.push(field);
  }
  return [
    ...fields.filter((field) => field.required),
    ...fields.filter((field) => !field.required),
  ];
}

/** The arguments in JSON text as an object; null when the text isn't a JSON object. */
export function eventArgumentsValue(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isSchema(value) ? value : null;
  } catch {
    return null;
  }
}

/** The JSON text with one argument set, or removed when `value` is undefined. */
export function withEventArgument(text: string, name: string, value: unknown): string {
  const current = eventArgumentsValue(text) ?? {};
  const next: Record<string, unknown> = { ...current };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return Object.keys(next).length > 0 ? JSON.stringify(next, null, 2) : "";
}

/**
 * The arguments for a newly picked event: what was already entered for
 * arguments it takes, else the host's defaults (such as the project a chat
 * belongs to). Arguments it doesn't take are dropped; text that isn't a JSON
 * object, or an event without a schema, keeps the text as it is.
 */
export function eventArgumentsForEvent(
  schema: Record<string, unknown> | null | undefined,
  text: string,
  defaults: Readonly<Record<string, unknown>> | undefined,
): string {
  const properties = schema?.properties;
  const current = eventArgumentsValue(text);
  if (!isSchema(properties) || current === null) return text;
  const next: Record<string, unknown> = {};
  for (const name of Object.keys(properties)) {
    const value = name in current ? current[name] : defaults?.[name];
    if (value !== undefined) next[name] = value;
  }
  return Object.keys(next).length > 0 ? JSON.stringify(next, null, 2) : "";
}
