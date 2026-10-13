import { createHash } from "node:crypto";
import { z } from "zod";

const locator = z.string().min(1).max(200);
const Page = z
  .object({
    sandboxId: locator,
    taskId: locator,
    requestedFileDescriptor: z.literal(2),
    entryId: z.string().max(200),
    items: z
      .array(z.object({ fileDescriptor: z.literal(2), data: z.string().max(65536) }).strict())
      .max(256),
    eof: z.boolean(),
  })
  .strict();
export type NativeBrokerDiagnosticsPage = z.infer<typeof Page>;
export type NativeBrokerDiagnosticsChannel = {
  readonly sandboxId: string;
  readonly taskId: string;
  /** A completed iterator is a completed bounded provider query, not timeout
   * suppression, EOF, process termination or a guarantee about future bytes. */
  diagnostics(cursor: string, signal?: AbortSignal): AsyncIterable<NativeBrokerDiagnosticsPage>;
};
const Fault = z
  .object({
    version: z.literal(1),
    sandboxId: locator,
    taskId: locator,
    reason: z.enum([
      "diagnostics",
      "initial_eof",
      "invalid_page",
      "observation_limit",
      "identity_mismatch",
      "replay_conflict",
    ]),
    page: z
      .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), value: z.string().max(65536) })
      .strict()
      .nullable(),
  })
  .strict();
export type NativeBrokerDiagnosticsFault = z.infer<typeof Fault>;
export function parseNativeBrokerDiagnosticsFault(
  input: unknown,
  identity: { sandboxId: string; taskId: string },
): NativeBrokerDiagnosticsFault {
  const fault = Fault.parse(input);
  if (fault.sandboxId !== identity.sandboxId || fault.taskId !== identity.taskId)
    throw new Error("Native broker diagnostic fault changed physical identity");
  if (fault.page) {
    const { value, sha256 } = fault.page;
    const page = Page.parse(JSON.parse(value));
    if (
      Buffer.byteLength(value) > 65536 ||
      value !== JSON.stringify(page) ||
      createHash("sha256").update(value).digest("hex") !== sha256 ||
      ["invalid_page", "observation_limit"].includes(fault.reason) ||
      (fault.reason === "diagnostics" && !page.items.some((item) => item.data.length > 0)) ||
      (fault.reason === "initial_eof" && !page.eof) ||
      (fault.reason === "identity_mismatch" &&
        page.sandboxId === identity.sandboxId &&
        page.taskId === identity.taskId) ||
      (fault.reason === "replay_conflict" &&
        (!page.entryId || page.eof || page.items.some((item) => item.data.length > 0))) ||
      (fault.reason !== "identity_mismatch" &&
        (page.sandboxId !== identity.sandboxId || page.taskId !== identity.taskId))
    )
      throw new Error("Native broker diagnostic fault receipt is inconsistent");
  } else if (!["invalid_page", "observation_limit"].includes(fault.reason))
    throw new Error("Native broker diagnostic fault requires its exact page");
  return Object.freeze({ ...fault, page: fault.page ? Object.freeze(fault.page) : null });
}

/** These bytes are the initial broker's diagnostics, never a command's stderr.
 * Keep the exact bounded receipt private for durable incident retention. */
export class NativeBrokerInitialDiagnosticsError extends Error {
  constructor(readonly observation: Readonly<NativeBrokerDiagnosticsFault>) {
    super(`Native broker initial diagnostics are fenced: ${observation.reason}`);
    this.name = "NativeBrokerInitialDiagnosticsError";
  }
}

/** Read from the original stderr origin, independently of stdout framing.
 * Clean means ONLY that this bounded authenticated query completed without
 * diagnostics. It is not durable admission, a future-health promise or exit
 * proof. Callers must retain faults and keep the live admission gate separate.
 * Channel implementations must honor AbortSignal; no abandoned read is raced.
 */
export async function inspectNativeBrokerInitialDiagnostics(
  channel: NativeBrokerDiagnosticsChannel,
  signal?: AbortSignal,
) {
  const scope = {
    sandboxId: locator.parse(channel.sandboxId),
    taskId: locator.parse(channel.taskId),
  };
  const timeout = AbortSignal.timeout(5_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  bounded.throwIfAborted();
  const receipts: Readonly<{ entryId: string; sha256: string; value: string }>[] = [];
  const seen = new Map<string, string>();
  const fail = (
    reason: NativeBrokerDiagnosticsFault["reason"],
    page: NativeBrokerDiagnosticsPage | null = null,
  ): never => {
    const value = page === null ? null : JSON.stringify(page);
    throw new NativeBrokerInitialDiagnosticsError(
      parseNativeBrokerDiagnosticsFault(
        {
          ...scope,
          version: 1,
          reason,
          page:
            value === null
              ? null
              : { value, sha256: createHash("sha256").update(value).digest("hex") },
        },
        scope,
      ),
    );
  };
  let bytes = 0,
    count = 0;
  for await (const supplied of channel.diagnostics("0-0", bounded)) {
    bounded.throwIfAborted();
    const parsed = Page.safeParse(supplied);
    const page = parsed.success ? parsed.data : fail("invalid_page");
    const value = JSON.stringify(page);
    bytes += Buffer.byteLength(value);
    if (++count > 128 || bytes > 64 * 1024) fail("observation_limit");
    if (page.sandboxId !== scope.sandboxId || page.taskId !== scope.taskId)
      fail("identity_mismatch", page);
    const sha256 = createHash("sha256").update(value).digest("hex");
    if (page.eof) fail("initial_eof", page);
    if (page.items.some((item) => item.data.length > 0)) fail("diagnostics", page);
    if (page.entryId) {
      const previous = seen.get(page.entryId);
      if (previous && previous !== sha256) fail("replay_conflict", page);
      if (!previous) {
        seen.set(page.entryId, sha256);
        receipts.push(Object.freeze({ entryId: page.entryId, sha256, value }));
      }
    }
  }
  bounded.throwIfAborted();
  return Object.freeze({
    ...scope,
    version: 1 as const,
    requestedCursor: "0-0" as const,
    status: "clean_observation" as const,
    commandAdmission: false as const,
    pages: Object.freeze(receipts),
  });
}
