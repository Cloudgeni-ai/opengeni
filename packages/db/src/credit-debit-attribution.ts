import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

const creditDebitAttributionContext = new AsyncLocalStorage<CreditDebitAttribution>();

export function currentCreditDebitAttribution(): CreditDebitAttribution {
  return creditDebitAttributionContext.getStore() ?? { kind: "unknown" };
}

/** Scope trusted HTTP/MCP admission facts across nested sandbox calls. */
export function withCreditDebitAttribution<T>(
  attribution: CreditDebitAttribution,
  fn: () => Promise<T>,
): Promise<T> {
  return creditDebitAttributionContext.run(
    Object.freeze(CreditDebitAttribution.parse(attribution)),
    fn,
  );
}

/** Read one immutable turn, rejecting a missing receipt rather than service. */
export async function creditDebitAttributionForTurn(
  db: Database,
  input: { accountId: string; workspaceId: string; turnId: string },
): Promise<CreditDebitAttribution> {
  return withRlsContext(db, input, async (tx) => {
    const [turn] = await rawRows<{ initiatingHumanSubjectId: string | null }>(
      tx,
      sql`SELECT initiating_human_subject_id AS "initiatingHumanSubjectId"
        FROM session_turns WHERE account_id=${input.accountId}::uuid
          AND workspace_id=${input.workspaceId}::uuid AND id=${input.turnId}::uuid`,
    );
    if (!turn) throw new Error("Paid credit debit initiating turn is unavailable");
    return CreditDebitAttribution.parse({
      kind: "turn",
      turnId: input.turnId,
      initiatingHumanSubjectId: turn.initiatingHumanSubjectId,
    });
  });
}

/**
 * Trusted admission facts, not an access grant. Unknown is deliberately
 * distinct from pure service: old jobs/leases cannot prove a human initiator.
 */
export const CreditDebitAttribution = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn"),
    turnId: z.uuid(),
    initiatingHumanSubjectId: z.string().min(1).max(1024).nullable(),
  }),
  z.object({
    kind: z.literal("human"),
    initiatingHumanSubjectId: z.string().min(1).max(1024),
  }),
  z.object({ kind: z.literal("service") }),
  z.object({ kind: z.literal("unknown") }),
]);
export type CreditDebitAttribution = z.infer<typeof CreditDebitAttribution>;

export function creditDebitAttributionMetadata(
  attribution: CreditDebitAttribution,
): Record<string, string> {
  switch (attribution.kind) {
    case "turn":
      return {
        turnId: attribution.turnId,
        ...(attribution.initiatingHumanSubjectId
          ? { initiatingHumanSubjectId: attribution.initiatingHumanSubjectId }
          : {}),
      };
    case "human":
      return { initiatingHumanSubjectId: attribution.initiatingHumanSubjectId };
    case "service":
      return {};
    case "unknown":
      throw new Error("Paid credit debit has no frozen initiating attribution");
  }
}
