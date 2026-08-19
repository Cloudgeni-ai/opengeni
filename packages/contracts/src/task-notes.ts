import { z } from "zod";

export const TASK_NOTE_TEXT_MAX_BYTES = 4_096;
export const TASK_NOTE_REASON_MAX_BYTES = 2_048;
export const TASK_NOTE_MAX_LIFETIME_DAYS = 90;
export const TASK_NOTE_ACTIVE_RECORD_CAP = 500;
export const TASK_NOTE_LIST_DEFAULT_LIMIT = 10;
export const TASK_NOTE_LIST_MAX_LIMIT = 20;
export const TASK_NOTE_LIST_RESPONSE_MAX_BYTES = 96 * 1_024;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export function boundedTaskNoteText(maxBytes: number, label: string) {
  return z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      if (value !== value.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not have leading or trailing whitespace`,
        });
      }
      if (utf8Bytes(value) > maxBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be at most ${maxBytes} UTF-8 bytes`,
        });
      }
    });
}

export const TaskNoteText = boundedTaskNoteText(TASK_NOTE_TEXT_MAX_BYTES, "task note text");
export const TaskNoteReason = boundedTaskNoteText(
  TASK_NOTE_REASON_MAX_BYTES,
  "task note archive reason",
);

export const TaskNoteKind = z.enum([
  "finding",
  "decision",
  "blocker",
  "ownership",
  "artifact",
  "handoff",
]);
export type TaskNoteKind = z.infer<typeof TaskNoteKind>;

export const TaskNoteStatus = z.enum(["active", "archived"]);
export type TaskNoteStatus = z.infer<typeof TaskNoteStatus>;

export const TaskNoteActorKind = z.enum(["human", "service"]);
export type TaskNoteActorKind = z.infer<typeof TaskNoteActorKind>;

export const TaskNote = z.object({
  id: z.string().uuid(),
  rootSessionId: z.string().uuid(),
  kind: TaskNoteKind,
  text: TaskNoteText,
  status: TaskNoteStatus,
  version: z.number().int().positive(),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
  provenance: z.object({
    actorKind: TaskNoteActorKind,
    sourceSessionId: z.string().uuid(),
    sourceTurnId: z.string().uuid(),
  }),
});
export type TaskNote = z.infer<typeof TaskNote>;

export const TaskNoteMutationResult = z.object({
  note: TaskNote,
  replayed: z.boolean(),
});
export type TaskNoteMutationResult = z.infer<typeof TaskNoteMutationResult>;

/** Atomic correction lineage: archive one exact v1 note and create one v1 replacement. */
export const TaskNoteReplacementResult = z.object({
  operationId: z.string().uuid(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  replaces: z.object({
    noteId: z.string().uuid(),
    archivedVersion: z.literal(2),
  }),
  replacement: TaskNote,
  replayed: z.boolean(),
});
export type TaskNoteReplacementResult = z.infer<typeof TaskNoteReplacementResult>;

export const TaskNoteListResponse = z
  .object({
    notes: z.array(TaskNote).max(TASK_NOTE_LIST_MAX_LIMIT),
  })
  .superRefine((value, ctx) => {
    if (utf8Bytes(JSON.stringify(value)) > TASK_NOTE_LIST_RESPONSE_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `task note list response must be at most ${TASK_NOTE_LIST_RESPONSE_MAX_BYTES} UTF-8 bytes`,
      });
    }
  });
export type TaskNoteListResponse = z.infer<typeof TaskNoteListResponse>;
