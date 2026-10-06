import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SandboxJournalCommand,
  SandboxJournalReceipt,
  SandboxJournalObservation,
} from "@opengeni/contracts";

export const JOURNAL_PAGE_BYTES = 1024 * 1024;
export const JOURNAL_INPUT_BYTES = 4096;
const count = z.number().int().nonnegative().safe();
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z
  .string()
  .refine((value) => !value.includes("\0") && Buffer.from(value).toString("utf8") === value);
const path = text.refine((value) => value.startsWith("/"));
const size = z
  .object({ columns: z.number().int().min(1).max(5000), rows: z.number().int().min(1).max(5000) })
  .strict();
const environmentKey = text.min(1).refine((value) => !value.includes("="));
// z.record drops __proto__. Environment names are OS strings, so preserve every
// own data key, including JS-reserved names, before hashing or serializing.
const environment = z.unknown().transform((value, context): Record<string, string> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    context.addIssue({ code: "custom", message: "Environment must contain string data entries" });
    return z.NEVER;
  }
  const entries: [string, string][] = [];
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (
      !("value" in property) ||
      !environmentKey.safeParse(key).success ||
      !text.safeParse(property.value).success
    ) {
      context.addIssue({ code: "custom", path: [key], message: "Invalid environment entry" });
      return z.NEVER;
    }
    entries.push([key, property.value as string]);
  }
  return Object.fromEntries(entries);
});

/** This exact body is retained in the dispatching call, never reconstructed
 * with refreshed credentials to retry an ambiguous operation. */
export const JournalStartRequest = z
  .object({
    operationId: uuid,
    diskLineage: uuid,
    bootId: digest,
    program: path,
    args: z.array(text),
    cwd: path,
    environment,
    stdin: z.boolean().default(false),
    pty: size.nullable().default(null),
  })
  .strict()
  .refine((value) => value.pty === null || value.stdin);
export type JournalStartRequest = z.infer<typeof JournalStartRequest>;

/** Matches serde's field order and BTreeMap's UTF-8 key order, including numeric
 * environment keys (which ordinary JS object serialization would reorder). */
export function journalSpecificationDigest(input: JournalStartRequest): string {
  const request = JournalStartRequest.parse(input);
  const head = JSON.stringify({
    operationId: request.operationId,
    diskLineage: request.diskLineage,
    bootId: request.bootId,
    program: request.program,
    args: request.args,
    cwd: request.cwd,
  });
  const canonicalEnvironment = Object.keys(request.environment)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(request.environment[key])}`)
    .join(",");
  const canonical =
    `${head.slice(0, -1)},"environment":{${canonicalEnvironment}},` +
    `"stdin":${request.stdin},"pty":${JSON.stringify(request.pty)}}`;
  return createHash("sha256").update(canonical).digest("hex");
}

function byteString(maxBytes: number, empty: boolean) {
  return z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .refine((value) => {
      const bytes = Buffer.from(value, "base64");
      return (
        bytes.length <= maxBytes &&
        (empty || bytes.length > 0) &&
        bytes.toString("base64") === value
      );
    }, "Noncanonical or oversized byte string");
}
export const JournalInputAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("data"), base64: byteString(JOURNAL_INPUT_BYTES, false) }).strict(),
  z.object({ kind: z.literal("close") }).strict(),
  size.extend({ kind: z.literal("resize") }).strict(),
]);
export type JournalInputAction = z.infer<typeof JournalInputAction>;
export const JournalInputReply = z
  .object({
    operationId: uuid,
    sequence: count.min(1),
    status: z.enum(["accepted", "pending", "rejected", "unknown"]),
    acceptedThrough: count.nullable(),
    reason: z.string(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "accepted" ||
      (value.acceptedThrough !== null && value.acceptedThrough >= value.sequence),
  );
export type JournalInputReply = z.infer<typeof JournalInputReply>;

export const JournalReceipt = SandboxJournalReceipt;
export type JournalReceipt = z.infer<typeof JournalReceipt>;

export const JournalObservation = SandboxJournalObservation;
export type JournalObservation = z.infer<typeof JournalObservation>;
export const JournalCapabilities = z
  .object({
    protocol: z.literal("opengeni-run-v1"),
    bootId: digest,
    supervision: z.literal("native-subreaper-v1"),
    stdin: z.boolean(),
    pty: z.boolean(),
  })
  .strict();

/** Retained by the control plane before the first network dispatch. No command,
 * credential, input payload, socket nonce or authorization is stored here. */
export const JournalCommand = SandboxJournalCommand;
export type JournalCommand = z.infer<typeof JournalCommand>;
