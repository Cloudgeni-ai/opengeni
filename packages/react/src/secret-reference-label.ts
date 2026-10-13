import type { SecretReferenceLike } from "./secrets-ui";

/* Pure (no DOM): shared by the web chips and non-DOM renderers. */

export type SecretReferenceLabel = {
  /** The part that truncates: the item name (or "Secret" for an ID reference). */
  primary: string;
  /** The field, one-time code and previous markers; never truncated. */
  suffix: string;
};

/**
 * "GitHub · password": the last path segments (the vault, when named, stays in
 * the tooltip); an ID reference reads "Secret · field"; `/otp` adds
 * "· one-time code" and `#previous` adds "(previous)".
 */
export function secretReferenceLabel(reference: SecretReferenceLike): SecretReferenceLabel {
  const target = reference.target;
  let primary: string;
  let field: string | null;
  if (target.form === "id") {
    primary = "Secret";
    field = target.field;
  } else {
    const segments = target.segments;
    if (segments.length >= 3) {
      primary = segments[segments.length - 2]!;
      field = segments[segments.length - 1]!;
    } else {
      primary = segments[0] ?? "Secret";
      field = segments[1] ?? null;
    }
  }
  let suffix = field ? ` · ${field}` : "";
  if (reference.otp) suffix += " · one-time code";
  if (reference.previous) suffix += " (previous)";
  return { primary, suffix };
}

export function secretReferenceLabelText(reference: SecretReferenceLike): string {
  const label = secretReferenceLabel(reference);
  return `${label.primary}${label.suffix}`;
}
