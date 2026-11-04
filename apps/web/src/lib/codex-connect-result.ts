import { toast } from "sonner";

/** Plans come back lowercase ("pro"); show them as the plan name. */
export function planLabel(plan: string | null | undefined, provider: string): string {
  if (!plan) return `${provider} plan`;
  return `${provider} ${plan.charAt(0).toLocaleUpperCase()}${plan.slice(1)}`;
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
