import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

const ModalOutputCursor = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      batchIndex: primitives.nonnegativeInteger.safe(),
      utf8Remainder: z
        .string()
        .max(8)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
      exitCode: z.number().int().nullable(),
    })
    .strict(),
);

/** Provider-owned execution identity and acknowledged output cursors. These
 * values are retained by the control plane, never recovered from sandbox files. */
export const ModalLegacyProviderCommand = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.literal("modal-control-v1"),
      sandboxId: z.string().min(1).max(200),
      taskId: z.string().min(1).max(200),
      execId: z.string().min(1).max(200),
      pty: primitives.optionalBoolean,
      streams: z.object({ stdout: ModalOutputCursor, stderr: ModalOutputCursor }).strict(),
    })
    .strict(),
);
export type ModalLegacyProviderCommand = z.infer<typeof ModalLegacyProviderCommand>;

const ModalByteCursor = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      byteOffset: primitives.nonnegativeInteger.safe(),
      utf8Remainder: z
        .string()
        .max(8)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
      eof: primitives.boolean,
      exitCode: z.number().int().nullable(),
    })
    .strict()
    .refine((cursor) => cursor.exitCode === null || cursor.eof, {
      message: "A terminal output cursor must have reached EOF",
    }),
);

export const CommandSupervisionDescriptor = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      protocol: z.literal("native-subreaper-v1"),
      invocationId: primitives.uuid,
      nonce: primitives.string.regex(/^[a-f0-9]{64}$/u),
      controlPath: primitives.string.regex(/^\/tmp\/opengeni-supervision\/[a-f0-9-]{36}\.sock$/u),
    })
    .strict(),
);
export type CommandSupervisionDescriptor = z.infer<typeof CommandSupervisionDescriptor>;

export const CommandSupervisionReceipt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      protocol: z.literal("native-subreaper-v1"),
      invocationId: primitives.uuid,
      receiptId: primitives.uuid,
      leaderExitCode: z.number().int(),
    })
    .strict(),
);
export type CommandSupervisionReceipt = z.infer<typeof CommandSupervisionReceipt>;

export const ModalRouterProviderCommand = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.literal("modal-router-v1"),
      sandboxId: z.string().min(1).max(200),
      taskId: z.string().min(1).max(200),
      execId: primitives.uuid,
      pty: primitives.optionalBoolean,
      supervision: CommandSupervisionDescriptor.optional(),
      streams: z.object({ stdout: ModalByteCursor, stderr: ModalByteCursor }).strict(),
    })
    .strict(),
);
export type ModalRouterProviderCommand = z.infer<typeof ModalRouterProviderCommand>;

/** Legacy locators are read-only compatibility for already launched commands;
 * new starts use authenticated task-router byte offsets, never batch indices. */
export const SandboxProviderCommand = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [ModalLegacyProviderCommand, ModalRouterProviderCommand]),
);
export type SandboxProviderCommand = z.infer<typeof SandboxProviderCommand>;
