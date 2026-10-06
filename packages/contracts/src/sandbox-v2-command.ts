import { z } from "zod";

/** Host-only structured file responses. Ordinary model command windows keep
 * their smaller default; immutable journal captures are independent of both. */
export const SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES = 4 * 1024 * 1024;

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative().safe();

/** Protected dispatch locator; no executable specification, credentials or
 * stdin payload. A locator never grants its holder execution authority. */
export const SandboxJournalCommand = z
  .object({
    kind: z.literal("machine-journal-v1"),
    machineId: uuid,
    operationId: uuid,
    diskLineage: uuid,
    bootId: digest,
    specificationDigest: digest,
    stdin: z.boolean(),
    pty: z.boolean(),
  })
  .strict()
  .refine((value) => !value.pty || value.stdin);
export type SandboxJournalCommand = z.infer<typeof SandboxJournalCommand>;

export const SandboxJournalReceipt = z
  .object({
    protocol: z.literal("native-subreaper-v1"),
    invocationId: uuid,
    receiptId: uuid,
    leaderExitCode: z.number().int().min(-2147483648).max(2147483647),
    acceptedInputSequence: count.optional(),
    incompleteInputSequence: count.min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.incompleteInputSequence === undefined ||
      (value.acceptedInputSequence !== undefined &&
        value.incompleteInputSequence === value.acceptedInputSequence + 1),
  );
export type SandboxJournalReceipt = z.infer<typeof SandboxJournalReceipt>;

const byteString = z
  .string()
  .max(1398104)
  .refine((value) => {
    try {
      const bytes = atob(value);
      return bytes.length <= 1024 * 1024 && btoa(bytes) === value;
    } catch {
      return false;
    }
  }, "Noncanonical or oversized output bytes");
const page = z
  .object({ offset: count, nextOffset: count, data: byteString, eof: z.boolean() })
  .strict()
  .refine((value) => {
    try {
      return value.nextOffset - value.offset === atob(value.data).length;
    } catch {
      return false;
    }
  });
export const SandboxJournalObservation = z
  .object({
    operationId: uuid,
    state: z.enum(["not_found", "cancelled", "prepared", "running", "exited", "lost", "unknown"]),
    specificationDigest: digest.nullable(),
    receipt: SandboxJournalReceipt.nullable(),
    stdout: page,
    stderr: page,
  })
  .strict()
  .refine((value) => (value.receipt === null) === (value.state !== "exited"))
  .refine(
    (value) =>
      !["prepared", "running", "exited", "lost"].includes(value.state) ||
      value.specificationDigest !== null,
  )
  .refine((value) => value.receipt === null || value.receipt.invocationId === value.operationId)
  .refine(
    (value) =>
      (!value.stdout.eof && !value.stderr.eof) ||
      value.state === "exited" ||
      value.state === "cancelled",
  )
  .refine(
    (value) =>
      value.state !== "cancelled" ||
      (value.specificationDigest === null &&
        value.receipt === null &&
        [value.stdout, value.stderr].every(
          (stream) =>
            stream.offset === 0 && stream.nextOffset === 0 && stream.data === "" && stream.eof,
        )),
  );
export type SandboxJournalObservation = z.infer<typeof SandboxJournalObservation>;

export const SandboxJournalCursor = z
  .object({
    offset: count,
    remainder: z
      .string()
      .max(4)
      .refine((value) => {
        try {
          const bytes = atob(value);
          return bytes.length <= 3 && btoa(bytes) === value;
        } catch {
          return false;
        }
      }),
  })
  .strict()
  .refine((value) => {
    try {
      const bytes = Uint8Array.from(atob(value.remainder), (character) => character.charCodeAt(0));
      const decoded = decodeSandboxJournalPage("", [bytes], false);
      return (
        bytes.length <= value.offset && decoded.text === "" && decoded.remainder === value.remainder
      );
    } catch {
      return false;
    }
  }, "Cursor remainder must be an observed unfinished UTF-8 suffix");
export type SandboxJournalCursor = z.infer<typeof SandboxJournalCursor>;

/** Decode byte pages identically in the runtime and its protected capture store.
 * Keep only a valid unfinished UTF-8 suffix; preserve a literal leading BOM. */
export function decodeSandboxJournalPage(prior: string, input: Uint8Array[], terminal: boolean) {
  const prefix = Uint8Array.from(atob(prior), (character) => character.charCodeAt(0));
  const bytes = new Uint8Array(
    prefix.length + input.reduce((size, chunk) => size + chunk.length, 0),
  );
  bytes.set(prefix);
  let position = prefix.length;
  for (const chunk of input) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  let boundary = bytes.length;
  if (!terminal) {
    for (let start = Math.max(0, bytes.length - 3); start < bytes.length; start++) {
      const first = bytes[start]!;
      const width =
        first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
      if (!width || bytes.length - start >= width) continue;
      const suffix = bytes.subarray(start + 1);
      if (!suffix.every((byte) => byte >= 0x80 && byte <= 0xbf)) continue;
      const second = suffix[0];
      if (
        second !== undefined &&
        ((first === 0xe0 && second < 0xa0) ||
          (first === 0xed && second > 0x9f) ||
          (first === 0xf0 && second < 0x90) ||
          (first === 0xf4 && second > 0x8f))
      )
        continue;
      boundary = start;
      break;
    }
  }
  return {
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, boundary)),
    remainder: btoa(String.fromCharCode(...bytes.subarray(boundary))),
  };
}
