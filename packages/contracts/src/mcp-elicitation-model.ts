/**
 * MCP form elicitation (protocol revision 2026-07-28): an MCP server asks the
 * person to fill in a form, or just confirm, in the middle of a tool call.
 * Opengeni shows the question as an approval of that call. These are its
 * public shapes (the question on a `session.requiresAction` approval entry and
 * the answer in `user.approvalDecision`) and the helpers that read them.
 * URL-mode questions are not offered.
 *
 * Dependency-free, like `./values`: the session timeline and React Native
 * import this module, so it must never import zod or `./index`. The zod
 * schemas for the same shapes live in `./mcp-elicitation`, which checks they
 * match these types.
 */

type FieldText = {
  title?: string | undefined;
  description?: string | undefined;
};

/** One labelled choice of a single- or multi-select field. */
export type McpElicitationTitledChoice = { const: string; title: string };

/** One field of a server's form: the restricted, flat JSON Schema the protocol allows. */
export type McpElicitationField =
  | (FieldText & {
      type: "string";
      oneOf: McpElicitationTitledChoice[];
      default?: string | undefined;
    })
  | (FieldText & {
      type: "string";
      enum: string[];
      /** Older servers' display names, one per `enum` value. */
      enumNames?: string[] | undefined;
      default?: string | undefined;
    })
  | (FieldText & {
      type: "string";
      minLength?: number | undefined;
      maxLength?: number | undefined;
      format?: "email" | "uri" | "date" | "date-time" | undefined;
      default?: string | undefined;
    })
  | (FieldText & {
      type: "number" | "integer";
      minimum?: number | undefined;
      maximum?: number | undefined;
      default?: number | undefined;
    })
  | (FieldText & { type: "boolean"; default?: boolean | undefined })
  | (FieldText & {
      type: "array";
      minItems?: number | undefined;
      maxItems?: number | undefined;
      items: { anyOf: McpElicitationTitledChoice[] } | { type: "string"; enum: string[] };
      default?: string[] | undefined;
    });

/** A server's whole form: named top-level fields, some of them required. */
export type McpElicitationRequestedSchema = {
  type: "object";
  properties: Record<string, McpElicitationField>;
  required?: string[] | undefined;
};

/** A form to fill in (or, with no fields, a plain confirmation). */
export type McpElicitationQuestion = {
  id: string;
  mode?: "form" | undefined;
  message: string;
  requestedSchema: McpElicitationRequestedSchema;
};

/** How many times one tool call's server may ask before the call stops. */
export const MCP_ELICITATION_MAX_ROUNDS = 10;

/**
 * `elicitation` on a `session.requiresAction` approval entry: the server is
 * asking the person these questions before the call can finish. `requests`
 * keeps the server's order; `id` is the key the answer uses. `round` counts
 * the questions this call has asked (1 for the first); a server can ask again
 * after an answer, under the same approval id, so an approval names the round
 * it answers.
 */
export type McpElicitationApprovalRequest = {
  server: string;
  round: number;
  requests: McpElicitationQuestion[];
};

/**
 * How a person answers a server's questions: `confirm` is a yes or no with
 * nothing to fill in, and `form` has fields to fill in.
 */
export type McpElicitationKind = "confirm" | "form";

export function mcpElicitationKind(request: McpElicitationApprovalRequest): McpElicitationKind {
  return request.requests.some(
    (question) => Object.keys(question.requestedSchema.properties).length > 0,
  )
    ? "form"
    : "confirm";
}

/** One answered field. */
export type McpElicitationValue = string | number | boolean | string[];

/** The answers in `user.approvalDecision.content`: field values keyed by request id. */
export type McpElicitationContent = Record<string, Record<string, McpElicitationValue>>;

/**
 * What approving an approval with `elicitation` sends with the decision: the
 * answers and the round they answer.
 */
export type McpElicitationAnswer = {
  content: McpElicitationContent;
  elicitationRound: number;
};

/** The server's own defaults for one form, as the starting answer. */
export function mcpElicitationDefaults(
  schema: McpElicitationRequestedSchema,
): Record<string, McpElicitationValue> {
  const values: Record<string, McpElicitationValue> = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    if (field.default !== undefined) values[name] = field.default;
  }
  return values;
}

/** Whether a form can be answered without filling anything in. */
export function mcpElicitationNeedsInput(schema: McpElicitationRequestedSchema): boolean {
  const defaults = mcpElicitationDefaults(schema);
  return (schema.required ?? []).some((name) => defaults[name] === undefined);
}

/** The choices a single- or multi-select field offers, with their labels. */
export function mcpElicitationChoices(
  field: McpElicitationField,
): Array<{ value: string; label: string }> | null {
  if (field.type === "string" && "oneOf" in field) {
    return field.oneOf.map((choice) => ({ value: choice.const, label: choice.title }));
  }
  if (field.type === "string" && "enum" in field) {
    return field.enum.map((value, index) => ({
      value,
      label: field.enumNames?.[index] ?? value,
    }));
  }
  if (field.type === "array") {
    return "anyOf" in field.items
      ? field.items.anyOf.map((choice) => ({ value: choice.const, label: choice.title }))
      : field.items.enum.map((value) => ({ value, label: value }));
  }
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function validDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().startsWith(value);
}

function validUrl(value: string): boolean {
  try {
    return new URL(value).protocol.length > 0;
  } catch {
    return false;
  }
}

function formatProblem(format: string, value: string): string | null {
  switch (format) {
    case "email":
      return EMAIL.test(value) ? null : "must be an email address";
    case "uri":
      return validUrl(value) ? null : "must be a URL";
    case "date":
      return validDate(value) ? null : "must be a date (YYYY-MM-DD)";
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : "must be a date and time";
    default:
      return null;
  }
}

function fieldProblem(field: McpElicitationField, value: McpElicitationValue): string | null {
  const choices = mcpElicitationChoices(field)?.map((choice) => choice.value) ?? null;
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return "must be text";
      if (choices) return choices.includes(value) ? null : "must be one of the offered choices";
      const text = field as {
        minLength?: number;
        maxLength?: number;
        format?: "email" | "uri" | "date" | "date-time";
      };
      const length = Array.from(value).length;
      if (text.minLength !== undefined && length < text.minLength) {
        return `must be at least ${text.minLength} characters`;
      }
      if (text.maxLength !== undefined && length > text.maxLength) {
        return `must be at most ${text.maxLength} characters`;
      }
      return text.format ? formatProblem(text.format, value) : null;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (field.type === "integer" && !Number.isInteger(value)) return "must be a whole number";
      if (field.minimum !== undefined && value < field.minimum) {
        return `must be at least ${field.minimum}`;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return `must be at most ${field.maximum}`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "array": {
      if (!Array.isArray(value)) return "must be a list of choices";
      if (!value.every((item) => choices?.includes(item))) {
        return "must only contain offered choices";
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        return `must have at least ${field.minItems} choices`;
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return `must have at most ${field.maxItems} choices`;
      }
      return null;
    }
  }
}

export type McpElicitationContentResolution =
  | { ok: true; content: McpElicitationContent }
  | { ok: false; problem: string };

/**
 * The complete answer to a server's questions: each form's defaults overlaid
 * with what the person entered, checked against the form. A plain approval
 * (no `content`) is a valid answer when every required field has a default.
 */
export function resolveMcpElicitationContent(
  request: McpElicitationApprovalRequest,
  content: McpElicitationContent | undefined,
): McpElicitationContentResolution {
  const known = new Set(request.requests.map((entry) => entry.id));
  for (const id of Object.keys(content ?? {})) {
    if (!known.has(id)) return { ok: false, problem: `There is no question ${id} to answer` };
  }
  const resolved: McpElicitationContent = {};
  for (const entry of request.requests) {
    const schema = entry.requestedSchema;
    const given = content?.[entry.id] ?? {};
    for (const name of Object.keys(given)) {
      if (!Object.hasOwn(schema.properties, name)) {
        return { ok: false, problem: `The form has no field ${name}` };
      }
    }
    const values = { ...mcpElicitationDefaults(schema), ...given };
    for (const name of schema.required ?? []) {
      if (values[name] === undefined) {
        return { ok: false, problem: `${fieldLabel(schema, name)} is required` };
      }
    }
    for (const [name, value] of Object.entries(values)) {
      const problem = fieldProblem(schema.properties[name]!, value);
      if (problem) return { ok: false, problem: `${fieldLabel(schema, name)} ${problem}` };
    }
    resolved[entry.id] = values;
  }
  return { ok: true, content: resolved };
}

function fieldLabel(schema: McpElicitationRequestedSchema, name: string): string {
  return schema.properties[name]?.title ?? name;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

const isString = (value: unknown): boolean => typeof value === "string";
const isNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function isList(value: unknown, item: (value: unknown) => boolean, min = 0): boolean {
  return Array.isArray(value) && value.length >= min && value.every(item);
}

function isTitledChoice(value: unknown): boolean {
  return isObject(value) && isString(value.const) && isString(value.title);
}

function isField(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!optional(value.title, isString) || !optional(value.description, isString)) return false;
  switch (value.type) {
    case "string":
      if ("oneOf" in value) {
        return isList(value.oneOf, isTitledChoice, 1) && optional(value.default, isString);
      }
      if ("enum" in value) {
        return (
          isList(value.enum, isString, 1) &&
          optional(value.enumNames, (names) => isList(names, isString)) &&
          optional(value.default, isString)
        );
      }
      return (
        optional(value.minLength, isCount) &&
        optional(value.maxLength, isCount) &&
        optional(value.format, (format) =>
          ["email", "uri", "date", "date-time"].includes(format as string),
        ) &&
        optional(value.default, isString)
      );
    case "number":
    case "integer":
      return (
        optional(value.minimum, isNumber) &&
        optional(value.maximum, isNumber) &&
        optional(value.default, isNumber)
      );
    case "boolean":
      return optional(value.default, (fallback) => typeof fallback === "boolean");
    case "array": {
      const items = value.items;
      const choices =
        isObject(items) &&
        ("anyOf" in items
          ? isList(items.anyOf, isTitledChoice, 1)
          : items.type === "string" && isList(items.enum, isString, 1));
      return (
        choices &&
        optional(value.minItems, isCount) &&
        optional(value.maxItems, isCount) &&
        optional(value.default, (fallback) => isList(fallback, isString))
      );
    }
    default:
      return false;
  }
}

function isRequestedSchema(value: unknown): boolean {
  if (!isObject(value) || value.type !== "object" || !isObject(value.properties)) return false;
  const properties = value.properties;
  return (
    Object.values(properties).every(isField) &&
    optional(value.required, (names) =>
      isList(names, (name) => isString(name) && Object.hasOwn(properties, name as string)),
    )
  );
}

function isQuestion(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value.id) &&
    value.id !== "" &&
    optional(value.mode, (mode) => mode === "form") &&
    isString(value.message) &&
    isRequestedSchema(value.requestedSchema)
  );
}

/**
 * An approval entry's `elicitation`, when it has the shape above; otherwise
 * null. A structural check without zod for clients that only show what the
 * server already validated with `McpElicitationApprovalRequest` (the server
 * also enforces its size limits).
 */
export function parseMcpElicitationApprovalRequest(
  value: unknown,
): McpElicitationApprovalRequest | null {
  if (!isObject(value)) return null;
  const { server, round, requests } = value;
  return isString(server) &&
    server !== "" &&
    typeof round === "number" &&
    Number.isInteger(round) &&
    round >= 1 &&
    round <= MCP_ELICITATION_MAX_ROUNDS &&
    isList(requests, isQuestion, 1)
    ? (value as McpElicitationApprovalRequest)
    : null;
}
