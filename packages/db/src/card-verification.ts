import { sql } from "drizzle-orm";

import { rawRows, withAccountRls, type Database } from "./database";

/**
 * Card verification gate (migration 1494, docs/signup-abuse-protection.md,
 * "Card verification"). While the deployment-wide switch is on, an unpaid
 * organization (Free or plan-less, never bought credit, no Stripe
 * subscription) needs a card its owner verified with a Stripe SetupIntent
 * before it starts a sandbox box or receives Free credit. Paid, Enterprise and
 * host-provisioned organizations are never gated.
 */
export type BillingCardVerification = {
  accountId: string;
  subjectId: string;
  provider: "stripe:test" | "stripe:live";
  brand: string;
  last4: string;
  verifiedAt: Date;
};

export type RecordCardVerificationInput = {
  accountId: string;
  subjectId: string;
  provider: "stripe:test" | "stripe:live";
  customerId: string;
  paymentMethodId: string;
  setupIntentId: string;
  /** The SetupIntent's creation time: an older one never replaces a newer card. */
  setupIntentCreatedAt: Date;
  fingerprint: string;
  brand: string;
  last4: string;
};

/** The switch is read on every unpaid admission; reuse it briefly per process. */
const CARD_VERIFICATION_GATE_TTL_MS = 15_000;
let cardVerificationGateCache: { at: number; value: Promise<boolean> } | null = null;

/** Forget the cached switch (tests, and right after an operator change). */
export function resetCardVerificationGateCache(): void {
  cardVerificationGateCache = null;
}

/** Whether the gate is on. Fails open: a failed read (including a database
 * that predates migration 1494) leaves it off. */
export async function readCardVerificationGate(db: Database): Promise<boolean> {
  const now = Date.now();
  if (
    cardVerificationGateCache &&
    now - cardVerificationGateCache.at < CARD_VERIFICATION_GATE_TTL_MS
  ) {
    return await cardVerificationGateCache.value;
  }
  const value = rawRows<{ enabled: boolean }>(
    db,
    sql`select gate.enabled from card_verification_gate_revisions gate
      order by gate.revision desc limit 1`,
  ).then(
    ([row]) => row?.enabled === true,
    (error: unknown) => {
      console.warn("card verification gate read failed; the gate stays off", {
        error: error instanceof Error ? error.message : String(error),
      });
      cardVerificationGateCache = null;
      return false;
    },
  );
  cardVerificationGateCache = { at: now, value };
  return await value;
}

function cardVerificationFromRow(row: {
  account_id: string;
  subject_id: string;
  provider: "stripe:test" | "stripe:live";
  brand: string;
  last4: string;
  verified_at: Date | string;
}): BillingCardVerification {
  return {
    accountId: row.account_id,
    subjectId: row.subject_id,
    provider: row.provider,
    brand: row.brand,
    last4: row.last4,
    verifiedAt: row.verified_at instanceof Date ? row.verified_at : new Date(row.verified_at),
  };
}

/** The organization's verified card, read inside its account RLS context. */
export async function readCardVerificationInTransaction(
  tx: Database,
  accountId: string,
): Promise<BillingCardVerification | null> {
  const [row] = await rawRows<{
    account_id: string;
    subject_id: string;
    provider: "stripe:test" | "stripe:live";
    brand: string;
    last4: string;
    verified_at: Date | string;
  }>(
    tx,
    sql`select account_id, subject_id, provider, brand, last4, verified_at
      from billing_card_verifications where account_id = ${accountId}::uuid`,
  );
  return row ? cardVerificationFromRow(row) : null;
}

export async function readCardVerification(
  db: Database,
  accountId: string,
): Promise<BillingCardVerification | null> {
  return await withAccountRls(db, accountId, (tx) =>
    readCardVerificationInTransaction(tx, accountId),
  );
}

/** Whether `subjectId` verified the card of this organization (read inside
 * its account RLS context). */
export async function subjectVerifiedCardInTransaction(
  tx: Database,
  accountId: string,
  subjectId: string,
): Promise<boolean> {
  const [row] = await rawRows<{ verified: boolean }>(
    tx,
    sql`select exists (select 1 from billing_card_verifications
      where account_id = ${accountId}::uuid and subject_id = ${subjectId}) as verified`,
  );
  return row?.verified === true;
}

/** Records (or replaces) the organization's verified card. Idempotent for the
 * same SetupIntent; a late webhook for an older SetupIntent leaves the newer
 * card in place (and returns it). */
export async function recordCardVerification(
  db: Database,
  input: RecordCardVerificationInput,
): Promise<BillingCardVerification> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await rawRows<{
      account_id: string;
      subject_id: string;
      provider: "stripe:test" | "stripe:live";
      brand: string;
      last4: string;
      verified_at: Date | string;
    }>(
      tx,
      sql`insert into billing_card_verifications (account_id, subject_id, provider, customer_id,
          payment_method_id, setup_intent_id, setup_intent_created_at, fingerprint, brand, last4)
        values (${input.accountId}::uuid, ${input.subjectId}, ${input.provider}, ${input.customerId},
          ${input.paymentMethodId}, ${input.setupIntentId},
          ${input.setupIntentCreatedAt.toISOString()}::timestamptz, ${input.fingerprint},
          ${input.brand.slice(0, 64) || "card"}, ${input.last4})
        on conflict (account_id) do update set subject_id = excluded.subject_id,
          provider = excluded.provider, customer_id = excluded.customer_id,
          payment_method_id = excluded.payment_method_id, setup_intent_id = excluded.setup_intent_id,
          setup_intent_created_at = excluded.setup_intent_created_at,
          fingerprint = excluded.fingerprint, brand = excluded.brand, last4 = excluded.last4,
          verified_at = case when billing_card_verifications.setup_intent_id = excluded.setup_intent_id
            then billing_card_verifications.verified_at else clock_timestamp() end
        where billing_card_verifications.setup_intent_id = excluded.setup_intent_id
          or billing_card_verifications.setup_intent_created_at <= excluded.setup_intent_created_at
        returning account_id, subject_id, provider, brand, last4, verified_at`,
    );
    if (row) return cardVerificationFromRow(row);
    const current = await readCardVerificationInTransaction(tx, input.accountId);
    if (!current) throw new Error("Card verification was not recorded");
    return current;
  });
}
