export type ModelPickerBillingClass =
  | "opengeni_credits"
  | "external"
  | "codex_subscription"
  | "supergrok_subscription"
  | "byok";

const MODEL_PICKER_BILLING_CLASS_ORDER: readonly ModelPickerBillingClass[] = [
  "opengeni_credits",
  "external",
  "codex_subscription",
  "supergrok_subscription",
  "byok",
];

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
  if (model.billing?.metering === "external" && model.billing.upstreamPayer === "deployment") {
    return "external";
  }
  if (model.source === "supergrok") {
    return "supergrok_subscription";
  }
  if (model.source === "codex") {
    return "codex_subscription";
  }
  if (model.source === "workspace_gateway") {
    return "byok";
  }
  if (model.credentialSource?.kind === "connected_subscription") {
    return model.credentialSource.provider === "xai"
      ? "supergrok_subscription"
      : "codex_subscription";
  }
  if (model.credentialSource?.kind === "workspace_connection") {
    return "byok";
  }
  if (model.billing?.upstreamPayer === "connected_subscription") {
    return "codex_subscription";
  }
  if (model.billing?.upstreamPayer === "workspace") {
    return "byok";
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
    classDelta || +right.selectable - +left.selectable || left.label.localeCompare(right.label)
  );
}
