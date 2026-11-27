import { normalizeMcpOutput } from "@opengeni/sdk";
import {
  presentedAppActionId,
  SESSION_EVENT_PRESENTED_APP_ACTIONS,
  type PresentedAppActionPage,
} from "@opengeni/contracts/session-history";
import { parseToolArgs } from "./parsers";
import type { ToolCallItem } from "./types";

/*
 * A payment page an app action opened in the chat (Stripe Checkout or the
 * billing portal). Kept free of React so the projection can tell it's primary
 * output, like a published image.
 */

export type PaymentPageKind = PresentedAppActionPage;

export type PaymentPage = {
  kind: PaymentPageKind;
  /** The page, exactly as the API returned it (Checkout needs its #fragment). */
  url: string;
  /** Set for a credits checkout, whose payment the chat confirms. */
  checkoutSessionId?: string | undefined;
  amountUsd?: number | undefined;
  /** The organization the call named, when it named one. */
  accountId?: string | undefined;
  /** When the call ran (ms since epoch), for a link that expires; unknown when absent. */
  createdAt?: number | undefined;
};

/** The Opengeni server's own app-action tool; another server's tool of that name is not trusted. */
export const TRUSTED_APP_ACTION_CALL_NAMES: readonly string[] = [
  "admin_action_call",
  "opengeni__admin_action_call",
  "mcp__opengeni__admin_action_call",
];

const OTHER_PURCHASE_ACTIONS = new Set([
  "createBillingAutoTopUpSetupSession",
  "POST /v1/billing/auto-top-up/setup",
  "createBillingCardVerificationSession",
  "POST /v1/billing/card-verification/setup",
  "changeBillingSubscription",
  "POST /v1/billing/subscription/change",
  "upgradeBillingSubscription",
  "POST /v1/billing/subscription/upgrade",
  "updateBillingAutoTopUp",
  "PUT /v1/billing/auto-top-up",
]);

function billingActionOf(item: ToolCallItem) {
  if (!TRUSTED_APP_ACTION_CALL_NAMES.includes(item.name)) return null;
  return presentedAppActionId(parseToolArgs(item.arguments).id) ?? null;
}

export function isBillingAppAction(item: ToolCallItem): boolean {
  if (!TRUSTED_APP_ACTION_CALL_NAMES.includes(item.name)) return false;
  const id = parseToolArgs(item.arguments).id;
  return (
    Boolean(presentedAppActionId(id)) ||
    (typeof id === "string" && OTHER_PURCHASE_ACTIONS.has(id.trim()))
  );
}

/** A secure page, or a local one while developing. */
function openableUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return value;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "http:" && local ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The payment page a completed app-action call opened, or null for any other call. */
export function paymentPageOf(item: ToolCallItem): PaymentPage | null {
  if (item.kind !== "tool-call" || item.status !== "complete") return null;
  // The same classification that keeps the call in a reloaded history.
  const action = billingActionOf(item);
  if (!action) return null;
  const kind = SESSION_EVENT_PRESENTED_APP_ACTIONS[action].page;
  const output = normalizeMcpOutput(item.output);
  if (output.isError) return null;
  let result: Record<string, unknown> | null;
  try {
    result = record(JSON.parse(output.text));
  } catch {
    return null;
  }
  const status = result?.status;
  const body = record(result?.body);
  if (typeof status !== "number" || status < 200 || status >= 300 || !body) return null;
  const url = openableUrl(body.url);
  if (!url) return null;
  const sent = record(parseToolArgs(item.arguments).body);
  const checkoutSessionId =
    kind === "credits" &&
    typeof body.checkoutSessionId === "string" &&
    /^cs_[A-Za-z0-9_]{1,250}$/.test(body.checkoutSessionId)
      ? body.checkoutSessionId
      : undefined;
  const createdAt = item.occurredAt ? Date.parse(item.occurredAt) : Number.NaN;
  return {
    kind,
    url,
    ...(checkoutSessionId ? { checkoutSessionId } : {}),
    ...(typeof body.amountUsd === "number" && Number.isFinite(body.amountUsd)
      ? { amountUsd: body.amountUsd }
      : {}),
    ...(typeof sent?.accountId === "string" ? { accountId: sent.accountId } : {}),
    ...(Number.isFinite(createdAt) ? { createdAt } : {}),
  };
}
