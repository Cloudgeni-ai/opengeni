import { z } from "zod";

const ModalOutputCursor = z
  .object({
    batchIndex: z.number().int().nonnegative().safe(),
    utf8Remainder: z
      .string()
      .max(8)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
    exitCode: z.number().int().nullable(),
  })
  .strict();

/** Provider-owned execution identity and acknowledged output cursors. These
 * values are retained by the control plane, never recovered from sandbox files. */
export const ModalLegacyProviderCommand = z
  .object({
    kind: z.literal("modal-control-v1"),
    sandboxId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    execId: z.string().min(1).max(200),
    pty: z.boolean().optional(),
    streams: z.object({ stdout: ModalOutputCursor, stderr: ModalOutputCursor }).strict(),
  })
  .strict();
export type ModalLegacyProviderCommand = z.infer<typeof ModalLegacyProviderCommand>;

const ModalByteCursor = z
  .object({
    byteOffset: z.number().int().nonnegative().safe(),
    utf8Remainder: z
      .string()
      .max(8)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
    eof: z.boolean(),
    exitCode: z.number().int().nullable(),
  })
  .strict()
  .refine((cursor) => cursor.exitCode === null || cursor.eof, {
    message: "A terminal output cursor must have reached EOF",
  });

export const ModalRouterProviderCommand = z
  .object({
    kind: z.literal("modal-router-v1"),
    sandboxId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    execId: z.string().uuid(),
    pty: z.boolean().optional(),
    streams: z.object({ stdout: ModalByteCursor, stderr: ModalByteCursor }).strict(),
  })
  .strict();
export type ModalRouterProviderCommand = z.infer<typeof ModalRouterProviderCommand>;

/** Legacy locators are read-only compatibility for already launched commands;
 * new starts use authenticated task-router byte offsets, never batch indices. */
export const SandboxProviderCommand = z.discriminatedUnion("kind", [
  ModalLegacyProviderCommand,
  ModalRouterProviderCommand,
]);
export type SandboxProviderCommand = z.infer<typeof SandboxProviderCommand>;
