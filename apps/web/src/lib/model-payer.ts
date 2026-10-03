import type { PickerBillingClass } from "@opengeni/react/model-policy";

/**
 * The one payer hint shown next to a model outside the Models settings page,
 * only where it changes the decision: "ChatGPT plan" vs "Opengeni credits".
 * Which connection (organization or workspace) holds the key is a settings
 * fact and never appears here.
 */
export function modelPayerHint(row: {
  billingClass: PickerBillingClass | string;
  catalog?: { cost?: string | undefined } | undefined;
}): string {
  switch (row.billingClass) {
    case "codex_subscription":
      return "ChatGPT plan";
    case "claude_subscription":
      return "Claude plan";
    case "supergrok_subscription":
      return "SuperGrok plan";
    case "opengeni_credits":
      return row.catalog?.cost === "free" ? "Free" : "Opengeni credits";
    case "byok":
    case "organization_byok":
      return "API key";
    default:
      return "Provider account";
  }
}
