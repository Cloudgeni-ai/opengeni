import { z } from "zod";

/** Trusted adapter hints, never read from agent arguments or tool output. */
export const ToolReviewContext = z
  .object({
    kind: z.enum(["generic", "gmail"]).default("generic"),
    title: z.string().max(256).optional(),
    accountLabel: z.string().max(256).optional(),
    fieldLabels: z.record(z.string(), z.string().max(256)).optional(),
    protectedFields: z.array(z.string()).max(128).optional(),
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
            ? [[clean(key), clean(value.title)]]
            : [],
        ),
    ),
    protectedFields: properties
      .filter(([, value]) => value && typeof value === "object" && value.writeOnly === true)
      .slice(0, 128)
      .map(([key]) => clean(key)),
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

const protectedName =
  /password|passwd|secret|credential|authorization|cookie|(^|[_-])token($|[_-])|api[_-]?key|accessToken|refreshToken|privateKey/i;
const bound = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;
export function toolReviewFieldLabel(key: string): string {
  const label = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\bids?\b/gi, (word) => (word.length === 3 ? "IDs" : "ID"));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
export function decodeReviewArguments(value: unknown): Record<string, unknown> | null {
  // Historical SDK entries sometimes wrapped arguments in JSON. Decode only once.
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)
    : null;
}
export function safeReviewValue(
  value: unknown,
  key = "",
  protectedFields: readonly string[] = [],
  depth = 0,
): unknown {
  if (protectedName.test(key) || protectedFields.includes(key)) return "[Protected value]";
  if (depth > 20) return "[Nested value; open this field for details]";
  if (Array.isArray(value))
    return value.map((entry) => safeReviewValue(entry, "", protectedFields, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        safeReviewValue(entry, name, protectedFields, depth + 1),
      ]),
    );
  return value;
}
function valueText(value: unknown): string {
  return typeof value === "string"
    ? value
    : value === null
      ? "None"
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : (JSON.stringify(value) ?? "Unavailable");
}
const pointer = (name: string) => `/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
// Long arbitrary property names remain readable without placing them in every
// preview or URL. An indexed segment opens their saved name and value together.
const fieldPointer = (key: string, index: number, parent = "") =>
  pointer(key).length > 256 || parent.length + pointer(key).length > 1024
    ? `/~2${index}`
    : pointer(key);

export function toolReviewFields(
  argumentsValue: unknown,
  context?: ToolReviewContext,
): { fields: ToolActionReview["fields"]; moreFields: number } {
  const args = decodeReviewArguments(argumentsValue);
  if (!args) return { fields: [], moreFields: 0 };
  const entries = Object.entries(args);
  if (context?.email) {
    const email = toolReviewFields(context.email);
    const original = toolReviewFields(args, { ...context, email: undefined });
    const fields = [
      ...email.fields
        .filter(
          (field) =>
            field.path !== "/contentSha256" && field.path !== "/htmlBody" && field.preview !== "",
        )
        .map((field) => ({ ...field, path: `/$email${field.path}` })),
      ...original.fields,
    ];
    return {
      fields: fields.slice(0, 16),
      moreFields: original.moreFields + Math.max(0, fields.length - 16),
    };
  }
  return {
    moreFields: Math.max(0, entries.length - 16),
    fields: entries.slice(0, 16).map(([key, value], index) => {
      const hidden = protectedName.test(key) || Boolean(context?.protectedFields?.includes(key));
      const safe = hidden ? "[Protected value]" : value;
      const count = Array.isArray(value) ? value.length : undefined;
      const text =
        count !== undefined
          ? `${count.toLocaleString("en-US")} item${count === 1 ? "" : "s"}`
          : safe && typeof safe === "object"
            ? `${Object.keys(safe).length} field${Object.keys(safe).length === 1 ? "" : "s"}`
            : valueText(safe);
      return {
        path: fieldPointer(key, index),
        label: bound(
          (context?.fieldLabels && Object.hasOwn(context.fieldLabels, key)
            ? context.fieldLabels[key]
            : undefined) ?? toolReviewFieldLabel(key),
          256,
        ),
        preview: bound(text, 240),
        ...(count !== undefined ? { count } : {}),
        truncated: !hidden && (text.length > 240 || (typeof value === "object" && value !== null)),
        ...(hidden ? { protected: true } : {}),
      };
    }),
  };
}

/** Deterministic consequences from the reviewed bytes. Unknown fields remain visible. */
export function toolReviewAction(
  toolName: string,
  argumentsValue: unknown,
  context?: ToolReviewContext,
): Pick<
  ToolActionReview,
  "title" | "approveLabel" | "effects" | "consequence" | "selectionCount" | "selectionKind"
> {
  const fallback = {
    title: context?.title ?? bound(toolReviewFieldLabel(toolName.replace(/^mcp_[^_]+__/, "")), 256),
    approveLabel: "Approve action",
    effects: [] as string[],
  };
  if (context?.kind !== "gmail") return fallback;
  const args = decodeReviewArguments(argumentsValue);
  if (!args) return fallback;
  const thread = toolName.endsWith("_thread");
  const selectionKind = thread ? ("threads" as const) : ("messages" as const);
  const ids =
    thread && typeof args.threadId === "string"
      ? [args.threadId]
      : Array.isArray(args.messageIds)
        ? args.messageIds
        : typeof args.messageId === "string"
          ? [args.messageId]
          : null;
  const selectionCount = ids?.every((id) => typeof id === "string") ? new Set(ids).size : undefined;
  const noun =
    selectionCount === undefined
      ? selectionKind
      : `${selectionCount.toLocaleString("en-US")} ${thread ? "thread" : "message"}${selectionCount === 1 ? "" : "s"}`;
  const addValues = toolName.startsWith("label_") ? args.labelIds : args.addLabelIds;
  const adds = Array.isArray(addValues)
    ? addValues.filter((v): v is string => typeof v === "string")
    : [];
  const removeValues = toolName.startsWith("unlabel_") ? args.labelIds : args.removeLabelIds;
  const removes = Array.isArray(removeValues)
    ? removeValues.filter((v): v is string => typeof v === "string")
    : [];
  const labelEffect = (label: string, adding: boolean): string => {
    const known: Record<string, [string, string]> = {
      TRASH: ["Move to Trash", "Remove from Trash"],
      INBOX: ["Move to Inbox", "Remove from Inbox"],
      UNREAD: ["Mark as unread", "Mark as read"],
      STARRED: ["Add star", "Remove star"],
      SPAM: ["Mark as spam", "Remove from Spam"],
      IMPORTANT: ["Mark as important", "Remove importance"],
    };
    return (
      (Object.hasOwn(known, label) ? known[label]?.[adding ? 0 : 1] : undefined) ??
      `${adding ? "Add" : "Remove"} label ${bound(label, 120)}`
    );
  };
  const effects = [
    ...adds.map((id) => labelEffect(id, true)),
    ...removes.map((id) => labelEffect(id, false)),
  ];
  if (
    [
      "batch_modify_messages",
      "modify_message",
      "modify_thread",
      "label_message",
      "label_thread",
      "unlabel_message",
      "unlabel_thread",
    ].includes(toolName)
  ) {
    const trash = adds.includes("TRASH");
    return {
      title: trash ? `Move ${noun} to Trash` : `Update ${noun}`,
      approveLabel: trash ? "Move to Trash" : "Apply changes",
      effects,
      ...(selectionCount === undefined ? {} : { selectionCount, selectionKind }),
      ...(trash
        ? { consequence: "Messages stay recoverable in Trash until Gmail deletes them." }
        : thread
          ? { consequence: "Applies to every message in the selected thread." }
          : {}),
    };
  }
  if (["trash_message", "restore_message", "trash_thread", "restore_thread"].includes(toolName))
    return {
      title: toolName.startsWith("trash_") ? `Move ${noun} to Trash` : `Remove ${noun} from Trash`,
      approveLabel: toolName.startsWith("trash_") ? "Move to Trash" : "Remove from Trash",
      effects,
      ...(selectionCount === undefined ? {} : { selectionCount, selectionKind }),
    };
  const named: Record<string, [string, string]> = {
    send_message: ["Send email", "Send email"],
    send_draft: ["Send draft", "Send draft"],
    create_draft: ["Create email draft", "Create draft"],
    update_draft: ["Update email draft", "Update draft"],
    delete_draft: ["Delete email draft", "Delete draft"],
    create_label: ["Create label", "Create label"],
    update_label: ["Update label", "Update label"],
    delete_label: ["Delete label", "Delete label"],
  };
  const action = Object.hasOwn(named, toolName) ? named[toolName] : undefined;
  return action ? { title: action[0], approveLabel: action[1], effects } : fallback;
}

/** A bounded slice of the immutable saved arguments; never evaluates a fresh provider query. */
export function toolReviewDetails(
  argumentsValue: unknown,
  context: ToolReviewContext | undefined,
  path: string,
  offset: number,
  limit = 25,
): Omit<ToolReviewDetailsPage, "id" | "actionDigest" | "version"> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("Invalid review page");
  const args = decodeReviewArguments(argumentsValue);
  let value: unknown = context?.email ? { ...args, $email: context.email } : args;
  if (path !== "") {
    if (!path.startsWith("/")) throw new Error("Invalid review field");
    for (const escaped of path.slice(1).split("/")) {
      if (/^~2\d+$/.test(escaped)) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Review field not found");
        const selected = Object.entries(value)[Number(escaped.slice(2))];
        if (!selected) throw new Error("Review field not found");
        value = {
          fieldName: selected[0],
          value:
            protectedName.test(selected[0]) || context?.protectedFields?.includes(selected[0])
              ? "[Protected value]"
              : selected[1],
        };
        continue;
      }
      const key = escaped.replaceAll("~1", "/").replaceAll("~0", "~");
      if (protectedName.test(key) || context?.protectedFields?.includes(key)) {
        value = "[Protected value]";
        break;
      }
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
        throw new Error("Review field not found");
      value = (value as Record<string, unknown>)[key];
    }
  }
  type DetailItem = ToolReviewDetailsPage["items"][number];
  const preview = (
    entry: unknown,
    key: string,
    childPath: string,
  ): Pick<DetailItem, "value" | "truncated" | "path"> => {
    const hidden = protectedName.test(key) || Boolean(context?.protectedFields?.includes(key));
    if (!hidden && entry !== null && typeof entry === "object") {
      const count = Array.isArray(entry) ? entry.length : Object.keys(entry).length;
      return {
        value: `${count.toLocaleString("en-US")} ${Array.isArray(entry) ? (count === 1 ? "item" : "items") : count === 1 ? "field" : "fields"}`,
        path: childPath,
        truncated: true,
      };
    }
    const text = valueText(safeReviewValue(entry, key, context?.protectedFields));
    return {
      value: bound(text, 4000),
      ...(hidden ? {} : { path: childPath }),
      truncated: !hidden && text.length > 4000,
    };
  };
  let total: number;
  let items: DetailItem[];
  if (Array.isArray(value)) {
    total = value.length;
    items = value.slice(offset, offset + limit).map((entry, index) => ({
      label: `${offset + index + 1}`,
      ...preview(entry, "", `${path}/${offset + index}`),
    }));
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    total = entries.length;
    items = entries.slice(offset, offset + limit).map(([key, entry], index) => ({
      label: bound(
        (context?.fieldLabels && Object.hasOwn(context.fieldLabels, key)
          ? context.fieldLabels[key]
          : undefined) ?? toolReviewFieldLabel(key),
        256,
      ),
      ...preview(entry, key, `${path}${fieldPointer(key, offset + index, path)}`),
    }));
  } else {
    const text = valueText(value);
    total = Math.max(1, Math.ceil(text.length / 4000));
    items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({
      label: `Part ${offset + index + 1}`,
      value: text.slice((offset + index) * 4000, (offset + index + 1) * 4000),
    }));
  }
  return { path, items, total, nextOffset: offset + limit < total ? offset + limit : null };
}
