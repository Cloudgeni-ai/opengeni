import { normalizeMcpOutput } from "@opengeni/sdk";
import { parseToolArgs } from "./parsers";
import type { ToolCallItem } from "./types";

/*
 * A payment page an app action opened in the chat (Stripe Checkout or the
 * billing portal). Kept free of React so the projection can tell it's primary
 * output, like a published image.
 */

export type PaymentPageKind = "credits" | "subscription" | "portal";

export type PaymentPage = {
  kind: PaymentPageKind;
  /** The page, exactly as the API returned it (Checkout needs its #fragment). */
  url: string;
  /** Set for a credits checkout, whose payment the chat confirms. */
  checkoutSessionId?: string | undefined;
  amountUsd?: number | undefined;
  /** The organization the call named, when it named one. */
  accountId?: string | undefined;
};

const PAYMENT_PAGE_ACTIONS: Readonly<Record<string, PaymentPageKind>> = {
  createBillingCheckout: "credits",
  "POST /v1/billing/checkout": "credits",
  createSubscriptionCheckout: "subscription",
  "POST /v1/billing/subscription/checkout": "subscription",
  createBillingPortalSession: "portal",
  "POST /v1/billing/portal": "portal",
  createSubscriptionPortalSession: "portal",
  "POST /v1/billing/subscription/portal": "portal",
};

/** The Opengeni server's own app-action tool; another server's tool of that name is not trusted. */
export const TRUSTED_APP_ACTION_CALL_NAMES: readonly string[] = [
  "admin_action_call",
  "opengeni__admin_action_call",
  "mcp__opengeni__admin_action_call",
];

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
  if (!TRUSTED_APP_ACTION_CALL_NAMES.includes(item.name)) return null;
  const args = parseToolArgs(item.arguments);
  const kind = typeof args.id === "string" ? PAYMENT_PAGE_ACTIONS[args.id.trim()] : undefined;
  if (!kind) return null;
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
  const sent = record(args.body);
  const checkoutSessionId =
    kind === "credits" &&
    typeof body.checkoutSessionId === "string" &&
    /^cs_[A-Za-z0-9_]{1,250}$/.test(body.checkoutSessionId)
      ? body.checkoutSessionId
      : undefined;
  return {
    kind,
    url,
    ...(checkoutSessionId ? { checkoutSessionId } : {}),
    ...(typeof body.amountUsd === "number" && Number.isFinite(body.amountUsd)
      ? { amountUsd: body.amountUsd }
      : {}),
    ...(typeof sent?.accountId === "string" ? { accountId: sent.accountId } : {}),
  };
}
