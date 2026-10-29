import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * MCP elicitation (protocol revision 2026-07-28): an MCP server asks the
 * person a question in the middle of a tool call, either a form to fill in or
 * a web page to open. Opengeni shows the question as an approval of that call;
 * these are its public shapes, the question on a `session.requiresAction`
 * approval entry and the answer in `user.approvalDecision`.
 *
 * This module must not import `./index`.
 */

const FieldText = {
  title: z.string().max(1_024).optional(),
  description: z.string().max(4_096).optional(),
};
const ChoiceValue = z.string().max(1_024);
const TitledChoice = z.object({ const: ChoiceValue, title: z.string().max(1_024) });
const MAX_CHOICES = 200;

/** One field of a server's form: the restricted, flat JSON Schema the protocol allows. */
export const McpElicitationField = /* @__PURE__ */ defineSchema(() =>
  z.union([
    z.object({
      type: z.literal("string"),
      ...FieldText,
      oneOf: z.array(TitledChoice).min(1).max(MAX_CHOICES),
      default: ChoiceValue.optional(),
    }),
    z.object({
      type: z.literal("string"),
      ...FieldText,
      enum: z.array(ChoiceValue).min(1).max(MAX_CHOICES),
      /** Older servers' display names, one per `enum` value. */
      enumNames: z.array(z.string().max(1_024)).max(MAX_CHOICES).optional(),
      default: ChoiceValue.optional(),
    }),
    z.object({
      type: z.literal("string"),
      ...FieldText,
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      format: z.enum(["email", "uri", "date", "date-time"]).optional(),
      default: z.string().max(65_536).optional(),
    }),
    z.object({
      type: z.enum(["number", "integer"]),
      ...FieldText,
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      default: z.number().optional(),
    }),
    z.object({
      type: z.literal("boolean"),
      ...FieldText,
      default: z.boolean().optional(),
    }),
    z.object({
      type: z.literal("array"),
      ...FieldText,
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      items: z.union([
        z.object({ anyOf: z.array(TitledChoice).min(1).max(MAX_CHOICES) }),
        z.object({
          type: z.literal("string"),
          enum: z.array(ChoiceValue).min(1).max(MAX_CHOICES),
        }),
      ]),
      default: z.array(ChoiceValue).max(MAX_CHOICES).optional(),
    }),
  ]),
);
export type McpElicitationField = z.infer<typeof McpElicitationField>;

/** A server's whole form: named top-level fields, some of them required. */
export const McpElicitationRequestedSchema = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal("object"),
      properties: z.record(z.string().min(1).max(256), McpElicitationField),
      required: z.array(z.string().min(1).max(256)).max(100).optional(),
    })
    .superRefine((schema, ctx) => {
      if (Object.keys(schema.properties).length > 100) {
        ctx.addIssue({ code: "custom", message: "A form has at most 100 fields" });
      }
      for (const name of schema.required ?? []) {
        if (!Object.hasOwn(schema.properties, name)) {
          ctx.addIssue({ code: "custom", message: `Required field ${name} is not defined` });
        }
      }
    }),
);
export type McpElicitationRequestedSchema = z.infer<typeof McpElicitationRequestedSchema>;

/**
 * The host a person is sent to by a URL question, or null when the link is
 * not one Opengeni offers: only `https` links without embedded credentials.
 * Surfaces show this host next to the link so the person sees exactly where
 * it leads.
 */
export function mcpElicitationUrlHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  return parsed.hostname || null;
}

const QuestionId = z.string().min(1).max(256);
const QuestionMessage = z.string().max(16_384);

/** A form to fill in (or, with no fields, a plain confirmation). */
export const McpElicitationFormQuestion = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: QuestionId,
    mode: z.literal("form").optional(),
    message: QuestionMessage,
    requestedSchema: McpElicitationRequestedSchema,
  }),
);
export type McpElicitationFormQuestion = z.infer<typeof McpElicitationFormQuestion>;

/**
 * A web page the server wants the person to open, for example to sign in or
 * pay. Nothing is entered in Opengeni and the page's contents never pass
 * through it; continuing tells the server the person agreed to go there.
 */
export const McpElicitationUrlQuestion = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: QuestionId,
    mode: z.literal("url"),
    message: QuestionMessage,
    url: z
      .string()
      .max(8_192)
      .refine((url) => mcpElicitationUrlHost(url) !== null, {
        message: "Only https links without credentials can be opened",
      }),
  }),
);
export type McpElicitationUrlQuestion = z.infer<typeof McpElicitationUrlQuestion>;

/** One of a server's questions: a form, or a web page to open. */
export const McpElicitationQuestion = /* @__PURE__ */ defineSchema(() =>
  z.union([McpElicitationUrlQuestion, McpElicitationFormQuestion]),
);
export type McpElicitationQuestion = z.infer<typeof McpElicitationQuestion>;

export function isMcpElicitationUrlQuestion(
  question: McpElicitationQuestion,
): question is McpElicitationUrlQuestion {
  return question.mode === "url";
}

/**
 * `elicitation` on a `session.requiresAction` approval entry: the server is
 * asking the person these questions before the call can finish. `requests`
 * keeps the server's order; `id` is the key the answer uses. A question with
 * `mode: "url"` asks the person to open a web page; any other is a form.
 */
export const McpElicitationApprovalRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    server: z.string().min(1).max(256),
    requests: z.array(McpElicitationQuestion).min(1).max(20),
  }),
);
export type McpElicitationApprovalRequest = z.infer<typeof McpElicitationApprovalRequest>;

/**
 * How a person answers a server's questions: `confirm` is a yes or no with
 * nothing to fill in, `url` asks them to open a web page first, and `form` has
 * fields to fill in (its card also shows any page to open). Only a
 * confirmation can be answered in one tap.
 */
export type McpElicitationKind = "confirm" | "form" | "url";

export function mcpElicitationKind(request: McpElicitationApprovalRequest): McpElicitationKind {
  const hasFields = request.requests.some(
    (question) =>
      !isMcpElicitationUrlQuestion(question) &&
      Object.keys(question.requestedSchema.properties).length > 0,
  );
  if (hasFields) return "form";
  return request.requests.some(isMcpElicitationUrlQuestion) ? "url" : "confirm";
}

export const McpElicitationValue = /* @__PURE__ */ defineSchema(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
export type McpElicitationValue = z.infer<typeof McpElicitationValue>;

/**
 * The answers in `user.approvalDecision.content`: field values keyed by
 * request id. A URL question has nothing to fill in and no entry.
 */
export const McpElicitationContent = /* @__PURE__ */ defineSchema(() =>
  z.record(z.string().min(1).max(256), z.record(z.string().min(1).max(256), McpElicitationValue)),
);
export type McpElicitationContent = z.infer<typeof McpElicitationContent>;

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
 * URL questions take no answer beyond the approval itself.
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
    if (isMcpElicitationUrlQuestion(entry)) {
      if (Object.keys(content?.[entry.id] ?? {}).length > 0) {
        return { ok: false, problem: `Question ${entry.id} has nothing to fill in` };
      }
      continue;
    }
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
