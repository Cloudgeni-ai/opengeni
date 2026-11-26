import {
  API_CREDITS_REQUIRED_CODE,
  BYOK_PAID_CREDIT_REQUIRED_CODE,
  SANDBOX_CARD_REQUIRED_CODE,
  SUBSCRIPTION_PLAN_REQUIRED_CODE,
  byokRefusalAction,
} from "@opengeni/contracts";
import { managedHumanClientForAccessContext, requireAccessContext } from "@opengeni/core";
import type { Context } from "hono";

/** The authenticated app session, not a request header or the hosted page marker. */
export async function isNativeIosRequest(
  c: Context,
  deps: Parameters<typeof requireAccessContext>[1],
): Promise<boolean> {
  const access = await requireAccessContext(c, deps).catch(() => null);
  const client = access && managedHumanClientForAccessContext(access);
  return client?.authMethod === "native_bearer" && client.platform === "ios";
}

type PurchaseRefusalSurface = "model" | "voice input" | "live voice" | "transcription";

/** Only known purchase-refusal codes have alternate client-facing copy. */
export function purchaseRefusalMessage(
  code: string,
  original: string,
  surface: PurchaseRefusalSurface,
  ios: boolean,
): string {
  return ios ? (neutralPurchaseRefusalMessage(code, original, surface) ?? original) : original;
}

export function neutralPurchaseRefusalMessage(
  code: string,
  original: string,
  surface: PurchaseRefusalSurface,
): string | null {
  switch (code) {
    case "insufficient_credits":
      return surface === "model"
        ? "No credits are available for this model."
        : `No credits are available for ${surface}.`;
    case API_CREDITS_REQUIRED_CODE:
      return "No credits are available for API use.";
    case BYOK_PAID_CREDIT_REQUIRED_CODE:
      return byokRefusalAction(original).type === "upgrade_plan"
        ? "Your current plan doesn't include models connected with your own key."
        : "No eligible credits are available for this model.";
    case SUBSCRIPTION_PLAN_REQUIRED_CODE:
      return "Your current plan doesn't include connected subscriptions.";
    case SANDBOX_CARD_REQUIRED_CODE:
      return "Sandboxes aren't available for this organization.";
    default:
      return null;
  }
}
