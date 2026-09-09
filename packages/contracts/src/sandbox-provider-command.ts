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
export const SandboxProviderCommand = z
  .object({
    kind: z.literal("modal-control-v1"),
    sandboxId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    execId: z.string().min(1).max(200),
    streams: z.object({ stdout: ModalOutputCursor, stderr: ModalOutputCursor }).strict(),
  })
  .strict();
export type SandboxProviderCommand = z.infer<typeof SandboxProviderCommand>;
