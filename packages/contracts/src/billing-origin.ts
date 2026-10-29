import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Who a turn's usage is billed as. Frozen on every accepted turn
 * (`session_turns.billing_origin`) and on every debit it causes
 * (`credit_ledger_entries.usage_origin`). Unlike the analytics-only turn
 * surface, this is a funding fact; it never grants or narrows access.
 *
 * - `app`: a signed-in person in Opengeni's own web, desktop or mobile apps,
 *   and work set up there (Slack and Teams bots, published Sites, schedules
 *   and automations). Plan credit pays first, then other credit.
 * - `api`: organization, personal and configured API keys, products built on
 *   the SDK acting for their people, and outside agents over MCP. Paid only
 *   from credits; plan credit never pays for it.
 *
 * Sub-agents, tools and continuations inherit the origin of the work they run
 * in. A null stored value predates this column and is billed as `app`.
 */
export const BILLING_ORIGINS = ["app", "api"] as const;
export const BillingOrigin = /* @__PURE__ */ defineSchema(() => z.enum(BILLING_ORIGINS));
export type BillingOrigin = z.infer<typeof BillingOrigin>;

/** A stored value, with legacy null (and anything unrecognized) billed as app. */
export function storedBillingOrigin(value: unknown): BillingOrigin {
  return value === "api" ? "api" : "app";
}

/** Refusal of API-origin work when no credits remain (plan credit never pays). */
export const API_CREDITS_REQUIRED_CODE = "api_credits_required";
export const API_CREDITS_REQUIRED_MESSAGE = "API usage uses credits, not your plan credit.";

/** Where a person adds credits; the public refusal action for credit stops. */
export const ADD_CREDITS_ACTION = Object.freeze({ type: "add_credits", href: "/billing" } as const);

/** Where a person on the Free plan upgrades; the refusal action when only a paid plan helps. */
export const UPGRADE_PLAN_ACTION = Object.freeze({
  type: "upgrade_plan",
  href: "/billing",
} as const);
/**
 * Bring-your-own-key use (the person's own provider keys, or their own
 * Claude, Codex or SuperGrok subscription) pays a platform fee on the
 * list-price equivalent of each call. The fee is payable only from paid
 * credit: a paid plan's credit (app use) and credits that were paid for.
 */
export const BYOK_PLATFORM_FEE_TYPE = "byok_platform_fee";
export const BYOK_PAID_CREDIT_REQUIRED_CODE = "byok_paid_credit_required";
export const BYOK_PAID_CREDIT_REQUIRED_MESSAGE = "Add credits to use your own key.";
