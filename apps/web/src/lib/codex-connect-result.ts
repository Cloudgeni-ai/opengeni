import { toast } from "sonner";
import { subscriptionPlanLabel } from "@opengeni/react/app/lib/subscription-accounts";

/** The plan as ChatGPT names it ("ChatGPT Plus", "ChatGPT Business"). */
export function planLabel(plan: string | null | undefined, provider: string): string {
  return subscriptionPlanLabel("codex", plan) ?? `${provider} plan`;
}

/**
 * The connect result: which plan, and which Opengeni models the account
 * offers. An account that offers none says so now, not at Send.
 */
export function showCodexConnected(
  title: string,
  result: { plan?: string | null; models?: ReadonlyArray<{ label: string }> },
): void {
  const plan = result.plan ? ` (${planLabel(result.plan, "ChatGPT")})` : "";
  if (result.models && result.models.length === 0) {
    toast.warning(`${title}${plan}`, {
      description: "This account offers no models Opengeni can use. Connect another account.",
    });
    return;
  }
  toast.success(
    `${title}${plan}`,
    result.models ? { description: result.models.map((model) => model.label).join(", ") } : {},
  );
}
