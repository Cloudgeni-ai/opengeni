import { z } from "zod";
import { defineSchema } from "./define-schema";
import type * as Model from "./mcp-elicitation-model";
import { MCP_ELICITATION_MAX_ROUNDS } from "./mcp-elicitation-model";

/**
 * The zod schemas for MCP form elicitation, for servers and the web: they
 * validate what an MCP server asks and what the person answers. The shapes,
 * their documentation and every helper live in the zod-free
 * `./mcp-elicitation-model` (re-exported here), which the session timeline and
 * React Native import instead. The contracts tests check that each schema
 * infers exactly the model's type.
 *
 * This module must not import `./index`.
 */
export * from "./mcp-elicitation-model";

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
export type McpElicitationField = Model.McpElicitationField;

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
export type McpElicitationRequestedSchema = Model.McpElicitationRequestedSchema;

const QuestionId = z.string().min(1).max(256);
const QuestionMessage = z.string().max(16_384);

/** A form to fill in (or, with no fields, a plain confirmation). */
export const McpElicitationQuestion = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: QuestionId,
    mode: z.literal("form").optional(),
    message: QuestionMessage,
    requestedSchema: McpElicitationRequestedSchema,
  }),
);
export type McpElicitationQuestion = Model.McpElicitationQuestion;

/** `elicitation` on a `session.requiresAction` approval entry. */
export const McpElicitationApprovalRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    server: z.string().min(1).max(256),
    round: z.number().int().min(1).max(MCP_ELICITATION_MAX_ROUNDS),
    requests: z.array(McpElicitationQuestion).min(1).max(20),
  }),
);
export type McpElicitationApprovalRequest = Model.McpElicitationApprovalRequest;

export const McpElicitationValue = /* @__PURE__ */ defineSchema(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
export type McpElicitationValue = Model.McpElicitationValue;

/** The answers in `user.approvalDecision.content`: field values keyed by request id. */
export const McpElicitationContent = /* @__PURE__ */ defineSchema(() =>
  z.record(z.string().min(1).max(256), z.record(z.string().min(1).max(256), McpElicitationValue)),
);
export type McpElicitationContent = Model.McpElicitationContent;
