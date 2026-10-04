import { z } from "zod";

/** Trusted adapter hints, never read from agent arguments or tool output. */
export const ToolReviewContext = z
  .object({
    kind: z.enum(["generic", "gmail"]).default("generic"),
    title: z.string().max(256).optional(),
    accountLabel: z.string().max(256).optional(),
    fieldLabels: z.record(z.string(), z.string().max(256)).optional(),
    protectedFields: z.array(z.string()).optional(),
    email: z
      .object({
        from: z.string().max(4096),
        to: z.string().max(32768),
        cc: z.string().max(32768),
        bcc: z.string().max(32768),
        subject: z.string().max(32768),
        textBody: z.string().max(262144),
        htmlBody: z.string().max(262144),
        contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
        attachments: z
          .array(
            z
              .object({
                name: z.string().max(1024),
                mediaType: z.string().max(256),
                bytes: z.number().int().nonnegative(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .optional(),
    samples: z
      .array(
        z
          .object({
            id: z.string().max(256),
            title: z.string().max(256),
            subtitle: z.string().max(256).optional(),
            provenance: z.literal("provider_metadata"),
          })
          .strict(),
      )
      .max(3)
      .optional(),
  })
  .strict();
export type ToolReviewContext = z.infer<typeof ToolReviewContext>;

// Names are exact saved identities, never display labels. A name protected by
// any reachable schema stays protected at every depth (conservative for sibling
// properties with the same name). Never truncate this set and expose its tail.
function schemaProtectedFields(root: Record<string, unknown>): string[] {
  const protectedFields = new Set<string>();
  const seen = new WeakMap<object, Set<string | undefined>>();
  let visited = 0;
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const refuse = () => {
    throw new Error("Tool review schema cannot be safely displayed");
  };
  const visit = (node: unknown, owner?: string, depth = 0): void => {
    if (!object(node)) return;
    const owners = seen.get(node) ?? new Set<string | undefined>();
    if (owners.has(owner)) return;
    owners.add(owner);
    seen.set(node, owners);
    if (++visited > 20000 || depth > 100) refuse();
    if (node.$dynamicRef !== undefined || node.$recursiveRef !== undefined) refuse();
    // A nested resource identifier changes the resolution base of local refs.
    if (node !== root && node.$id !== undefined) refuse();
    if (node.writeOnly === true) {
      if (owner === undefined) refuse();
      protectedFields.add(owner!);
    }
    if (node.contentSchema !== undefined) {
      // Encoded content is one opaque argument value. Nested privacy annotations
      // cannot be applied to its string without decoding and changing the bytes.
      if (owner === undefined) refuse();
      protectedFields.add(owner!);
    }
    if (typeof node.$ref === "string") {
      if (node.$ref !== "#" && !node.$ref.startsWith("#/")) refuse();
      let target: unknown = root;
      if (node.$ref !== "#")
        for (const part of node.$ref.slice(2).split("/")) {
          const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
          if (!object(target) || !Object.hasOwn(target, key)) refuse();
          target = (target as Record<string, unknown>)[key];
        }
      if (!object(target) && typeof target !== "boolean") refuse();
      visit(target, owner, depth + 1);
    }
    if (object(node.properties))
      for (const [key, schema] of Object.entries(node.properties)) visit(schema, key, depth + 1);
    for (const key of [
      "items",
      "additionalItems",
      "additionalProperties",
      "unevaluatedItems",
      "unevaluatedProperties",
      "contains",
      "if",
      "then",
      "else",
      "not",
    ]) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) visit(child, owner, depth + 1);
      else visit(value, owner, depth + 1);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child, owner, depth + 1);
    }
    // A pattern cannot be represented by this exact-name privacy contract.
    // Protect its containing object if any branch declares a private value.
    for (const key of ["patternProperties", "dependentSchemas", "dependencies"]) {
      if (object(node[key]))
        for (const child of Object.values(node[key])) visit(child, owner, depth + 1);
    }
  };
  try {
    visit(root);
    return [...protectedFields];
  } catch {
    // Review formatting must not change Allow/Block execution. Unsupported
    // schema privacy is conservative: display no values, never guess a key.
    return ["*"];
  }
}

export function toolReviewContextFromSchema(
  inputSchema: unknown,
  hints: Omit<ToolReviewContext, "fieldLabels" | "protectedFields">,
): ToolReviewContext {
  const schema =
    inputSchema && typeof inputSchema === "object" ? (inputSchema as Record<string, unknown>) : {};
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? Object.entries(schema.properties)
      : [];
  const clean = (text: string) =>
    text
      .replaceAll("\u0000", "")
      .replace(/\p{Surrogate}/gu, "�")
      .slice(0, 256);
  return {
    kind: hints.kind,
    ...(hints.title ? { title: clean(hints.title) } : {}),
    ...(hints.accountLabel ? { accountLabel: clean(hints.accountLabel) } : {}),
    fieldLabels: Object.fromEntries(
      properties
        .slice(0, 128)
        .flatMap(([key, value]) =>
          value && typeof value === "object" && typeof value.title === "string"
            ? [[key, clean(value.title)]]
            : [],
        ),
    ),
    protectedFields: schemaProtectedFields(schema),
  };
}

export const ToolReviewStatus = z.enum([
  "pending",
  "approved",
  "executing",
  "completed",
  "partial",
  "unknown",
  "rejected",
  "cancelled",
  "expired",
  "revoked",
  "stale",
  "failed",
  "unavailable",
]);
export type ToolReviewStatus = z.infer<typeof ToolReviewStatus>;
export const ToolReviewField = z
  .object({
    path: z.string(),
    label: z.string(),
    preview: z.string(),
    count: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    protected: z.boolean().optional(),
  })
  .strict();
export const ToolActionReview = z
  .object({
    version: z.literal(1),
    id: z.string(),
    actionDigest: z.string(),
    revision: z.string(),
    status: ToolReviewStatus,
    title: z.string(),
    accountLabel: z.string().optional(),
    consequence: z.string().optional(),
    effects: z.array(z.string()),
    selectionCount: z.number().int().nonnegative().optional(),
    selectionKind: z.enum(["messages", "threads"]).optional(),
    samples: ToolReviewContext.shape.samples,
    fields: z.array(ToolReviewField),
    moreFields: z.number().int().nonnegative(),
    reason: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    approveLabel: z.string(),
    availableActions: z.array(z.enum(["approve", "reject"])),
    detailsAvailable: z.boolean(),
  })
  .strict();
export type ToolActionReview = z.infer<typeof ToolActionReview>;
export const ToolReviewDetailsPage = z
  .object({
    version: z.literal(1),
    id: z.string(),
    actionDigest: z.string(),
    path: z.string(),
    items: z.array(
      z
        .object({
          label: z.string(),
          value: z.string(),
          path: z.string().optional(),
          truncated: z.boolean().optional(),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ToolReviewDetailsPage = z.infer<typeof ToolReviewDetailsPage>;

export {
  decodeReviewArguments,
  safeReviewValue,
  toolReviewAction,
  toolReviewDetails,
  toolReviewFieldLabel,
  toolReviewFields,
} from "./tool-review-presentation";
