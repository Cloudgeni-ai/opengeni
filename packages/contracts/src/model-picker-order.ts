export type ModelPickerBillingClass =
  | "opengeni_credits"
  | "external"
  | "codex_subscription"
  | "supergrok_subscription"
  | "byok"
  | "organization_byok";

// Every closed billing class has a unique first character. Keeping the order
// as initials avoids duplicating the full public labels in browser bundles.
const MODEL_PICKER_BILLING_CLASS_ORDER: readonly ModelPickerBillingClass[] = [
  "opengeni_credits",
  "external",
  "codex_subscription",
  "supergrok_subscription",
  "byok",
  "organization_byok",
];

export type ModelPickerBillingCandidate = {
  source?: string | undefined;
  cost?: "free" | "credits" | "subscription" | "workspace" | "organization" | undefined;
  billing?:
    | {
        upstreamPayer?: string | undefined;
        metering?: string | undefined;
      }
    | undefined;
  credentialSource?:
    | {
        kind?: string | undefined;
        provider?: string | undefined;
      }
    | undefined;
};

export function modelPickerBillingClassFor(
  model: ModelPickerBillingCandidate,
): ModelPickerBillingClass {
  if (model.cost === "credits") return "opengeni_credits";
  if (model.cost === "workspace") return "byok";
  if (model.cost === "organization") return "organization_byok";
  const source = model.source;
  const credential = model.credentialSource;
  const payer = model.billing?.upstreamPayer;
  if (model.billing?.metering === "external" && payer === "deployment") {
    return "external";
  }
  if (
    source === "supergrok" ||
    (credential?.kind === "connected_subscription" && credential.provider === "xai")
  ) {
    return "supergrok_subscription";
  }
  if (
    source === "codex" ||
    credential?.kind === "connected_subscription" ||
    payer === "connected_subscription"
  ) {
    return "codex_subscription";
  }
  if (
    source === "workspace_gateway" ||
    credential?.kind === "workspace_connection" ||
    payer === "workspace"
  ) {
    return "byok";
  }
  if (credential?.kind === "organization_connection" || payer === "organization") {
    return "organization_byok";
  }
  return "opengeni_credits";
}

export function compareModelPickerOrder(
  left: { billingClass: ModelPickerBillingClass; selectable: boolean; label: string },
  right: { billingClass: ModelPickerBillingClass; selectable: boolean; label: string },
): number {
  const classDelta =
    MODEL_PICKER_BILLING_CLASS_ORDER.indexOf(left.billingClass) -
    MODEL_PICKER_BILLING_CLASS_ORDER.indexOf(right.billingClass);
  return (
    classDelta ||
    +right.selectable - +left.selectable ||
    (left.label < right.label ? -1 : left.label > right.label ? 1 : 0)
  );
}
