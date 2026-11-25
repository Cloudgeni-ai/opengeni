import type { CreditOffer, CreditOfferStatus } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withAccountRls, type Database } from "./database";

/** A credit_offers row as the definers return it (to_jsonb). */
type CreditOfferRow = {
  id: string;
  account_id: string;
  label: string;
  amount_micros: number | string;
  eligible_model_ids: string[];
  valid_days: number;
  activate_by: string | null;
  activated_at: string | null;
  expires_at: string | null;
  expired_at: string | null;
  revoked_at: string | null;
};

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

export function creditOfferStatus(row: CreditOfferRow, now = new Date()): CreditOfferStatus {
  if (row.activated_at) {
    return row.expired_at || new Date(row.expires_at!) <= now ? "ended" : "active";
  }
  if (row.revoked_at) return "withdrawn";
  return row.activate_by && new Date(row.activate_by) <= now ? "lapsed" : "available";
}

function toCreditOffer(row: CreditOfferRow, now = new Date()): CreditOffer {
  return {
    id: row.id,
    accountId: row.account_id,
    label: row.label,
    amountMicros: Number(row.amount_micros),
    eligibleModelIds: row.eligible_model_ids,
    validDays: row.valid_days,
    activateBy: iso(row.activate_by),
    status: creditOfferStatus(row, now),
    activatedAt: iso(row.activated_at),
    expiresAt: iso(row.expires_at),
  };
}

/** The organization's offers, newest first. */
export async function listCreditOffers(db: Database, accountId: string): Promise<CreditOffer[]> {
  return await withAccountRls(db, accountId, async (tx) => {
    const rows = await rawRows<{ offer: CreditOfferRow }>(
      tx,
      sql`select to_jsonb(offer) as offer from credit_offers offer
        where offer.account_id = ${accountId}::uuid
        order by offer.created_at desc, offer.id`,
    );
    const now = new Date();
    return rows.map((row) => toCreditOffer(row.offer, now));
  });
}

const ACTIVATE_ROUTINE = "opengeni_private.activate_credit_offer_v1(uuid, uuid, text)";

/**
 * Whether this connection's role may activate offers. Migration 1563 withholds
 * the runtime's EXECUTE for one release; until a later migration grants it,
 * operators activate offers.
 */
export async function creditOfferSelfServeActivation(db: Database): Promise<boolean> {
  const [row] = await rawRows<{ allowed: boolean }>(
    db,
    sql`select coalesce(has_function_privilege(to_regprocedure(${ACTIVATE_ROUTINE}), 'EXECUTE'), false) as allowed`,
  );
  return row?.allowed === true;
}

/**
 * Activate an offer: one scoped grant that expires `validDays` later. A replay
 * returns the activated offer. Refused (SQLSTATE 55000) after withdrawal or
 * the activation deadline; P0002 for an offer of another organization; 42501
 * while the caller's role may not activate (creditOfferSelfServeActivation).
 */
export async function activateCreditOffer(
  db: Database,
  input: { accountId: string; offerId: string; subjectId: string },
): Promise<CreditOffer> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await rawRows<{ offer: CreditOfferRow }>(
      tx,
      sql`select opengeni_private.activate_credit_offer_v1(${input.accountId}::uuid, ${input.offerId}::uuid, ${input.subjectId}) as offer`,
    );
    return toCreditOffer(row!.offer);
  });
}

export type AssignCreditOfferInput = {
  accountId: string;
  label: string;
  amountMicros: number;
  eligibleModelIds: string[];
  validDays: number;
  activateBy?: Date | null;
  operator: string;
  reason: string;
};

/** Operator only: the database owner's connection (scripts/operator/credit-offers.ts). */
export async function assignCreditOffer(
  ownerDb: Database,
  input: AssignCreditOfferInput,
): Promise<CreditOffer> {
  return await withAccountRls(ownerDb, input.accountId, async (tx) => {
    const [row] = await rawRows<{ offer: CreditOfferRow }>(
      tx,
      sql`select assign_credit_offer(${input.accountId}::uuid, ${input.label}, ${input.amountMicros}::bigint,
        ${sql`array[${sql.join(
          input.eligibleModelIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]`}, ${input.validDays}::integer,
        ${input.activateBy?.toISOString() ?? null}::timestamptz, ${input.operator}, ${input.reason}) as offer`,
    );
    return toCreditOffer(row!.offer);
  });
}

/** Operator only. Withdraws an offer; an active one expires now. */
export async function revokeCreditOffer(
  ownerDb: Database,
  input: { accountId: string; offerId: string; operator: string; reason: string },
): Promise<CreditOffer> {
  return await withAccountRls(ownerDb, input.accountId, async (tx) => {
    const [row] = await rawRows<{ offer: CreditOfferRow }>(
      tx,
      sql`select revoke_credit_offer(${input.accountId}::uuid, ${input.offerId}::uuid, ${input.operator}, ${input.reason}) as offer`,
    );
    return toCreditOffer(row!.offer);
  });
}
