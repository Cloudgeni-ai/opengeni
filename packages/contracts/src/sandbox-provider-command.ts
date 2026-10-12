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

export const CommandSupervisionProtocol = z.enum([
  "native-subreaper-v1",
  "native-subreaper-pty-v1",
]);
export type CommandSupervisionProtocol = z.infer<typeof CommandSupervisionProtocol>;

export const CommandSupervisionDescriptor = z
  .object({
    protocol: CommandSupervisionProtocol,
    invocationId: z.string().uuid(),
    nonce: z.string().regex(/^[a-f0-9]{64}$/u),
    controlPath: z.string().regex(/^\/tmp\/opengeni-supervision\/[a-f0-9-]{36}\.sock$/u),
  })
  .strict();
export type CommandSupervisionDescriptor = z.infer<typeof CommandSupervisionDescriptor>;

/** Initial-process broker ownership is not the mutable-path router protocol.
 * Do not add these values to CommandSupervisionDescriptor or its path schema. */
export const NativeBrokerCommandProtocol = z.enum([
  "native-subreaper-broker-channel-v1",
  "native-subreaper-broker-channel-pty-v1",
]);
export type NativeBrokerCommandProtocol = z.infer<typeof NativeBrokerCommandProtocol>;

export const CommandSupervisionReceipt = z
  .object({
    protocol: z.union([CommandSupervisionProtocol, NativeBrokerCommandProtocol]),
    invocationId: z.string().uuid(),
    receiptId: z.string().uuid(),
    leaderExitCode: z.number().int(),
  })
  .strict();
export type CommandSupervisionReceipt = z.infer<typeof CommandSupervisionReceipt>;

export const ModalRouterProviderCommand = z
  .object({
    kind: z.literal("modal-router-v1"),
    sandboxId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    execId: z.string().uuid(),
    pty: z.boolean().optional(),
    supervision: CommandSupervisionDescriptor.optional(),
    streams: z.object({ stdout: ModalByteCursor, stderr: ModalByteCursor }).strict(),
  })
  .strict();
export type ModalRouterProviderCommand = z.infer<typeof ModalRouterProviderCommand>;

const NativeBrokerUuid = z.uuid().refine((value) => value === value.toLowerCase(), {
  message: "Native broker identities must be canonical lowercase UUIDs",
});
export const NativeBrokerCommandDescriptor = z
  .object({
    protocol: NativeBrokerCommandProtocol,
    invocationId: NativeBrokerUuid,
    brokerId: NativeBrokerUuid,
    launchRequestId: NativeBrokerUuid,
    launchEpoch: z.number().int().positive().safe(),
  })
  .strict();
export type NativeBrokerCommandDescriptor = z.infer<typeof NativeBrokerCommandDescriptor>;

/** Durable locator for one command within one authenticated initial process.
 * execId is the native command UUID, never a Modal TaskExec identity. Physical
 * creation/artifact authority remains the exact broker's immutable DB binding.
 * Output EOF and the independently reaped supervisor exit are separate facts. */
export const ModalBrokerProviderCommand = z
  .object({
    kind: z.literal("modal-broker-v1"),
    sandboxId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    execId: NativeBrokerUuid,
    pty: z.boolean(),
    supervision: NativeBrokerCommandDescriptor,
    capture: z
      .object({
        sequence: z.number().int().nonnegative().safe(),
        receiptAckObserved: z.boolean(),
      })
      .strict(),
    streams: z.object({ stdout: ModalByteCursor, stderr: ModalByteCursor }).strict(),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      command.supervision.invocationId !== command.execId ||
      command.supervision.protocol !==
        (command.pty
          ? "native-subreaper-broker-channel-pty-v1"
          : "native-subreaper-broker-channel-v1")
    )
      context.addIssue({ code: "custom", message: "Broker command identity or mode differs" });
    const { stdout, stderr } = command.streams;
    if (
      stdout.exitCode !== stderr.exitCode ||
      (stdout.exitCode !== null &&
        (stdout.exitCode !== 0 ||
          !command.capture.receiptAckObserved ||
          !stdout.eof ||
          !stderr.eof))
    )
      context.addIssue({
        code: "custom",
        message: "Broker supervisor exit requires both EOFs and exact receipt ACK",
      });
    for (const stream of [stdout, stderr])
      if (stream.eof && stream.utf8Remainder !== "")
        context.addIssue({ code: "custom", message: "Broker EOF must flush its UTF-8 suffix" });
  });
export type ModalBrokerProviderCommand = z.infer<typeof ModalBrokerProviderCommand>;

/** Legacy locators are read-only compatibility for already launched commands;
 * new starts use authenticated task-router byte offsets, never batch indices. */
export const SandboxProviderCommand = z.discriminatedUnion("kind", [
  ModalLegacyProviderCommand,
  ModalRouterProviderCommand,
  ModalBrokerProviderCommand,
]);
export type SandboxProviderCommand = z.infer<typeof SandboxProviderCommand>;
