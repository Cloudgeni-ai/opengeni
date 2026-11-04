import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { BILLING_ORIGINS, storedBillingOrigin, type BillingOrigin } from "@opengeni/contracts";
import { rawRows, withRlsContext, type Database } from "./database";

const creditDebitAttributionContext = new AsyncLocalStorage<CreditDebitAttribution>();
const billingOriginOverrideContext = new AsyncLocalStorage<BillingOrigin>();

/**
 * Trusted in-process dispatch only: everything inside `fn` is billed as
 * `origin`, whatever credential the dispatched request carries. An agent's
 * organization action runs as its person but keeps its chat's origin; an
 * outside agent's runs stay API. Never call it with caller-supplied input.
 */
export function withBillingOriginOverride<T>(origin: BillingOrigin, fn: () => Promise<T>) {
  return billingOriginOverrideContext.run(origin, fn);
}

/** The funding origin a trusted outer scope fixed for this work, if any. */
export function ambientBillingOrigin(): BillingOrigin | null {
  const attribution = creditDebitAttributionContext.getStore();
  return (
    billingOriginOverrideContext.getStore() ??
    (attribution && attribution.kind !== "unknown" ? attribution.billingOrigin : undefined) ??
    null
  );
}

/**
 * Who pays for a schedule's runs; a task from before origins is app. A task
 * this caller cannot see is never billed to plan credit.
 */
export async function readScheduledTaskBillingOrigin(
  db: Database,
  input: { accountId: string; workspaceId: string; taskId: string },
): Promise<BillingOrigin> {
  return await withRlsContext(db, input, async (tx) => {
    const [task] = await rawRows<{ billingOrigin: string | null }>(
      tx,
      sql`SELECT billing_origin AS "billingOrigin" FROM scheduled_tasks
        WHERE account_id=${input.accountId}::uuid AND workspace_id=${input.workspaceId}::uuid
          AND id=${input.taskId}::uuid`,
    );
    return task ? storedBillingOrigin(task.billingOrigin) : "api";
  });
}

/**
 * Once an API caller edits or triggers a schedule, its runs are billed as API
 * from then on, so a key cannot spend plan credit through a task set up in
 * the app. A task is never turned back from API into app.
 */
export async function markScheduledTaskApiBilled(
  db: Database,
  input: { accountId: string; workspaceId: string; taskId: string },
): Promise<void> {
  await withRlsContext(db, input, async (tx) => {
    await tx.execute(
      sql`UPDATE scheduled_tasks SET billing_origin = 'api'
        WHERE account_id=${input.accountId}::uuid AND workspace_id=${input.workspaceId}::uuid
          AND id=${input.taskId}::uuid AND billing_origin IS DISTINCT FROM 'api'`,
    );
  });
}

/**
 * Who pays for a run a caller starts by hand: API when the caller or the
 * task is API, else the task's app origin.
 */
export async function manualScheduledTaskRunBillingOrigin(
  db: Database,
  input: { accountId: string; workspaceId: string; taskId: string; callerOrigin: BillingOrigin },
): Promise<BillingOrigin> {
  if (input.callerOrigin === "api") return "api";
  return await readScheduledTaskBillingOrigin(db, input);
}

/**
 * The origin a chat's next machine turn (a goal continuation, a resume)
 * inherits: its latest decided turn's, else its parent chat's, else app.
 * Mirrors the session_turns insert trigger, so admission and charge agree.
 */
export async function readSessionBillingOrigin(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<BillingOrigin> {
  return await withRlsContext(db, input, async (tx) => {
    const [row] = await rawRows<{ billingOrigin: string | null }>(
      tx,
      sql`SELECT coalesce(
          (SELECT turn.billing_origin FROM session_turns turn
            WHERE turn.workspace_id=${input.workspaceId}::uuid AND turn.session_id=${input.sessionId}::uuid
              AND turn.billing_origin IS NOT NULL
            ORDER BY turn.created_at DESC, turn.id DESC LIMIT 1),
          (SELECT turn.billing_origin FROM sessions child JOIN session_turns turn
              ON turn.workspace_id = child.workspace_id AND turn.session_id = child.parent_session_id
            WHERE child.workspace_id=${input.workspaceId}::uuid AND child.id=${input.sessionId}::uuid
              AND turn.billing_origin IS NOT NULL
            ORDER BY turn.created_at DESC, turn.id DESC LIMIT 1)) AS "billingOrigin"`,
    );
    return storedBillingOrigin(row?.billingOrigin);
  });
}

/** One accepted turn's frozen funding origin; null when it is not visible. */
export async function readTurnBillingOrigin(
  db: Database,
  input: { accountId: string; workspaceId: string; turnId: string },
): Promise<BillingOrigin | null> {
  return await withRlsContext(db, input, async (tx) => {
    const [turn] = await rawRows<{ billingOrigin: string | null }>(
      tx,
      sql`SELECT billing_origin AS "billingOrigin" FROM session_turns
        WHERE account_id=${input.accountId}::uuid AND workspace_id=${input.workspaceId}::uuid
          AND id=${input.turnId}::uuid`,
    );
    return turn ? storedBillingOrigin(turn.billingOrigin) : null;
  });
}

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
    const [turn] = await rawRows<{
      initiatingHumanSubjectId: string | null;
      billingOrigin: string | null;
    }>(
      tx,
      sql`SELECT initiating_human_subject_id AS "initiatingHumanSubjectId",
          billing_origin AS "billingOrigin"
        FROM session_turns WHERE account_id=${input.accountId}::uuid
          AND workspace_id=${input.workspaceId}::uuid AND id=${input.turnId}::uuid`,
    );
    if (!turn) throw new Error("Paid credit debit initiating turn is unavailable");
    return CreditDebitAttribution.parse({
      kind: "turn",
      turnId: input.turnId,
      initiatingHumanSubjectId: turn.initiatingHumanSubjectId,
      billingOrigin: storedBillingOrigin(turn.billingOrigin),
    });
  });
}

/**
 * Trusted admission facts, not an access grant. Unknown is deliberately
 * distinct from pure service: old jobs/leases cannot prove a human initiator.
 */
/** Funding origin of the work (`BillingOrigin`); omitted when not yet known. */
const attributionBillingOrigin = z.enum(BILLING_ORIGINS).optional();

export const CreditDebitAttribution = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn"),
    turnId: z.uuid(),
    initiatingHumanSubjectId: z.string().min(1).max(1024).nullable(),
    billingOrigin: attributionBillingOrigin,
  }),
  z.object({
    kind: z.literal("human"),
    initiatingHumanSubjectId: z.string().min(1).max(1024),
    billingOrigin: attributionBillingOrigin,
  }),
  z.object({ kind: z.literal("service"), billingOrigin: attributionBillingOrigin }),
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
        ...(attribution.billingOrigin ? { billingOrigin: attribution.billingOrigin } : {}),
      };
    case "human":
      return {
        initiatingHumanSubjectId: attribution.initiatingHumanSubjectId,
        ...(attribution.billingOrigin ? { billingOrigin: attribution.billingOrigin } : {}),
      };
    case "service":
      return attribution.billingOrigin ? { billingOrigin: attribution.billingOrigin } : {};
    case "unknown":
      throw new Error("Paid credit debit has no frozen initiating attribution");
  }
}
