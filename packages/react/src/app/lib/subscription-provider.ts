// A subscription provider's display name and billing class, kept in its own
// module so the chat page can name a provider (for example in the pinned
// account wait notice) without loading the account menu and usage code.
import type { PickerBillingClass } from "../../model-policy";

const PROVIDER: Record<string, { name: string; billingClass: PickerBillingClass }> = {
  codex: { name: "Codex", billingClass: "codex_subscription" },
  claude: { name: "Claude", billingClass: "claude_subscription" },
  xai: { name: "SuperGrok", billingClass: "supergrok_subscription" },
};

export function subscriptionProviderPresentation(provider: string): {
  name: string;
  billingClass: PickerBillingClass;
} {
  return PROVIDER[provider] ?? { name: "Subscription", billingClass: "external" };
}
