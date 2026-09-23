import { SessionAdmissionBlock, SessionStatus } from "@opengeni/contracts";
import { z } from "zod";

export type SessionAdmissionFence = { lastSequence: number; controlVersion: number };
export const StoredSessionAdmissionBlock = SessionAdmissionBlock.extend({
  attemptId: z.string().uuid(),
  fence: z
    .object({
      lastSequence: z.number().int().nonnegative(),
      controlVersion: z.number().int().nonnegative(),
    })
    .strict(),
  previousStatus: SessionStatus.exclude(["failed", "cancelled"]),
}).strict();
export type StoredSessionAdmissionBlock = z.infer<typeof StoredSessionAdmissionBlock>;

/** Never expose internal attempt/fence identities through the public projection. */
export function projectSessionAdmissionBlock(
  value: StoredSessionAdmissionBlock | null | undefined,
): SessionAdmissionBlock | null {
  if (!value) return null;
  StoredSessionAdmissionBlock.parse(value);
  return SessionAdmissionBlock.parse({
    reason: value.reason,
    sqlState: value.sqlState,
    retryPolicy: value.retryPolicy,
    blockedAt: value.blockedAt,
  });
}
