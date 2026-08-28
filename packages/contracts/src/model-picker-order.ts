export type ModelPickerBillingClass =
  | "opengeni_credits"
  | "external"
  | "codex_subscription"
  | "supergrok_subscription"
  | "byok";

// Every closed billing class has a unique first character. Keeping the order
// as initials avoids duplicating the full public labels in browser bundles.
const MODEL_PICKER_BILLING_CLASS_INITIAL_ORDER = "oecsb";

export type ModelPickerBillingCandidate = {
  source?: string | undefined;
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
  return "opengeni_credits";
}

export function compareModelPickerOrder(
  left: { billingClass: ModelPickerBillingClass; selectable: boolean; label: string },
  right: { billingClass: ModelPickerBillingClass; selectable: boolean; label: string },
): number {
  const classDelta =
    MODEL_PICKER_BILLING_CLASS_INITIAL_ORDER.indexOf(left.billingClass[0]!) -
    MODEL_PICKER_BILLING_CLASS_INITIAL_ORDER.indexOf(right.billingClass[0]!);
  return (
    classDelta || +right.selectable - +left.selectable || left.label.localeCompare(right.label)
  );
}
