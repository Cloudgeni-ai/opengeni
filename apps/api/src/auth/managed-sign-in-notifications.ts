import type { ManagedEmailTransport } from "@opengeni/core";
import type { Database } from "@opengeni/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

const Claim = z.object({
  operationId: z.string().uuid(),
  leaseId: z.string().uuid(),
  email: z.string().email(),
  provider: z.enum(["password", "google", "github"]),
  sender: z.string(),
});
const started = new WeakSet<object>();

export async function deliverManagedSignInNotification(
  db: Database,
  transport: ManagedEmailTransport,
  operationId: string | null = null,
): Promise<"sent" | "failed" | "outcome_unknown"> {
  try {
    const result = await db.execute(
      sql`select claim_managed_sign_in_notification(${operationId}::uuid,${transport.sender},${transport.idempotency.scope},${transport.idempotency.retentionSeconds}::integer) as claim`,
    );
    const row = (Array.isArray(result) ? result : result.rows)[0] as { claim: unknown } | undefined;
    if (!row?.claim) return "outcome_unknown";
    const claim = Claim.parse(row.claim);
    let status: "sent" | "failed" | "outcome_unknown" = "outcome_unknown";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        transport.send({
          kind: "sign_in_method_changed",
          from: claim.sender,
          to: claim.email,
          idempotencyKey: `sign-in-method:${claim.operationId}`,
          subject: "Your OpenGeni sign-in methods changed",
          text: `Your OpenGeni ${claim.provider} sign-in method changed. If this was not you, reset your password and contact your administrator.`,
          html: `<p>Your OpenGeni ${claim.provider} sign-in method changed. If this was not you, reset your password and contact your administrator.</p>`,
        }),
        new Promise<{ status: "outcome_unknown" }>((resolve) => {
          timer = setTimeout(() => resolve({ status: "outcome_unknown" }), 5_000);
        }),
      ]);
      status = response.status;
    } catch {
      /* Retain the durable unknown claim for idempotent retry. */
    } finally {
      if (timer) clearTimeout(timer);
    }
    await db.execute(
      sql`select settle_managed_sign_in_notification(${claim.operationId}::uuid,${claim.leaseId}::uuid,${status})`,
    );
    return status;
  } catch {
    // Security state is already committed. A failed claim/ack must never be
    // reported as a failed method change; its durable obligation remains live.
    return "outcome_unknown";
  }
}

export function startManagedSignInNotificationDelivery(
  db: Database,
  transport: ManagedEmailTransport,
): void {
  if (started.has(db as object)) return;
  started.add(db as object);
  let active = false;
  const drain = async () => {
    if (active) return;
    active = true;
    try {
      for (let count = 0; count < 10; count++)
        if ((await deliverManagedSignInNotification(db, transport)) === "outcome_unknown") break;
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => void drain(), 60_000);
  (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  void drain();
}
