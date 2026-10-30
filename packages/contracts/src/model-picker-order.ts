export type ModelPickerBillingClass =
  // Legacy public identifier for the Opengeni presentation group, including
  // free deployment models. Never use this UI grouping to decide settlement.
  | "opengeni_credits"
  | "external"
  | "codex_subscription"
  | "supergrok_subscription"
  | "claude_subscription"
  | "byok"
  | "organization_byok";

// Every closed billing class has a unique first character. Keeping the order
// as initials avoids duplicating the full public labels in browser bundles.
const MODEL_PICKER_BILLING_CLASS_ORDER: readonly ModelPickerBillingClass[] = [
  "opengeni_credits",
  "external",
  "codex_subscription",
  "supergrok_subscription",
  "claude_subscription",
  "byok",
  "organization_byok",
];

export type ModelPickerBillingCandidate = {
  provider?: string | undefined;
  providerId?: string | undefined;
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
  if (
    model.provider === "workspace-claude-subscription" ||
    model.providerId === "workspace-claude-subscription" ||
    model.provider === "organization-claude-subscription" ||
    model.providerId === "organization-claude-subscription"
  )
    return "claude_subscription";
  if (model.cost === "credits" || model.cost === "free") return "opengeni_credits";
  if (model.cost === "workspace") return "byok";
  if (model.cost === "organization") return "organization_byok";
  const source = model.source;
  const credential = model.credentialSource;
  const payer = model.billing?.upstreamPayer;
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

/** A processing geography that names a place a person can choose by. */
export type ModelLabelGeography = "eu" | "us" | "global";

/** What tells one model apart from others listed under the same name. */
export type ModelLabelDistinction = {
  geography?: ModelLabelGeography | undefined;
  providerLabel?: string | undefined;
};

export type ModelLabelCandidate = {
  id: string;
  label: string;
  /** Models in different groups (for example payment groups) never collide. */
  group?: string | undefined;
  providerLabel?: string | undefined;
  residency?: { geography?: string | undefined } | null | undefined;
};

function nameableGeography(model: ModelLabelCandidate): ModelLabelGeography | undefined {
  const geography = model.residency?.geography;
  return geography === "eu" || geography === "us" || geography === "global" ? geography : undefined;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.values()];
}

/**
 * What tells apart models listed under the same name in the same group, by
 * model id. Only a model whose name another listed model shares gets an entry:
 * its known processing geography (from the residency record, never the name)
 * when the twins differ by it, then its provider when twins still differ by
 * that. A model that matches its twins on both gets none.
 */
export function modelLabelDistinctions(
  models: readonly ModelLabelCandidate[],
): Map<string, ModelLabelDistinction> {
  const distinctions = new Map<string, ModelLabelDistinction>();
  const twinGroups = groupBy(
    models,
    (model) => `${model.group ?? ""}\u0000${model.label.trim().toLowerCase()}`,
  ).filter((twins) => twins.length > 1);
  for (const twins of twinGroups) {
    const geographies = new Set(twins.map(nameableGeography));
    const byGeography =
      geographies.size > 1 ? groupBy(twins, (model) => nameableGeography(model) ?? "") : [twins];
    for (const sameGeography of byGeography) {
      const geography = geographies.size > 1 ? nameableGeography(sameGeography[0]!) : undefined;
      const providers = new Set(sameGeography.map((model) => model.providerLabel ?? ""));
      for (const model of sameGeography) {
        const providerLabel =
          sameGeography.length > 1 && providers.size > 1 && model.providerLabel
            ? model.providerLabel
            : undefined;
        if (geography || providerLabel) {
          distinctions.set(model.id, {
            ...(geography ? { geography } : {}),
            ...(providerLabel ? { providerLabel } : {}),
          });
        }
      }
    }
  }
  return distinctions;
}
