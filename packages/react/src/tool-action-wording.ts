import type { ToolActionReview } from "@opengeni/sdk";
import type { OpenGeniText, ToolActionMessageKey } from "./messages/runtime";

type ToolReviewReasonCode = NonNullable<ToolActionReview["reasonCode"]>;

/** A host message without an English default: an unset key comes back as itself. */
function hostText(t: OpenGeniText, key: ToolActionMessageKey): string | undefined {
  const value = (t as unknown as (key: string) => string)(key).trim();
  return value && value !== key ? value : undefined;
}

/** A tool's name without its server prefix (`server__create_event` → `create_event`). */
function leaf(toolName: string): string {
  const boundary = toolName.indexOf("__");
  return boundary >= 0 ? toolName.slice(boundary + 2) : toolName;
}

/** The host's title for a tool action (`toolAction.<toolName>.title`), when it set one. */
export function toolActionTitle(t: OpenGeniText, toolName: string | undefined): string | undefined {
  return toolName ? hostText(t, `toolAction.${leaf(toolName)}.title`) : undefined;
}

/**
 * The host's label for one argument of a tool action: that action's own
 * (`toolAction.<toolName>.field.<argument>`), else the one for every tool
 * (`toolField.<argument>`).
 */
export function toolActionFieldLabel(
  t: OpenGeniText,
  toolName: string | undefined,
  argument: string | undefined,
): string | undefined {
  if (!argument) return undefined;
  return (
    (toolName ? hostText(t, `toolAction.${leaf(toolName)}.field.${argument}`) : undefined) ??
    hostText(t, `toolField.${argument}`)
  );
}

function reasonText(t: OpenGeniText, code: ToolReviewReasonCode): string {
  switch (code) {
    case "asks_by_setting":
      return t("toolActionReview.reason.asksBySetting");
    case "asks_by_default":
      return t("toolActionReview.reason.asksByDefault");
    case "blocked_by_setting":
      return t("toolActionReview.yourPermissionSettingsBlockThis");
    case "blocked_by_conflict":
      return t("toolActionReview.reason.blockedByConflict");
    case "blocked_by_default":
      return t("toolActionReview.reason.blockedByDefault");
  }
}

/**
 * A review in the host's words: its own title and field labels for the
 * action when it set them, and the catalog's text for the reason, plain
 * yes or no values and the plain approve button. Wording only: what is
 * approved never changes.
 */
export function wordedToolActionReview(
  review: ToolActionReview,
  t: OpenGeniText,
): ToolActionReview {
  const title = toolActionTitle(t, review.toolName);
  const approveLabel =
    review.approveLabelCode === "approve_action"
      ? t("approvalSurface.approveAction")
      : review.approveLabelCode === "allow"
        ? t("approvalSurface.allow")
        : review.approveLabel;
  let fieldsChanged = false;
  const fields = review.fields.map((field) => {
    const label = toolActionFieldLabel(t, review.toolName, field.key) ?? field.label;
    const preview =
      field.booleanValue === undefined
        ? field.preview
        : t(field.booleanValue ? "toolActionReview.yes" : "toolActionReview.no");
    if (label === field.label && preview === field.preview) return field;
    fieldsChanged = true;
    return { ...field, label, preview };
  });
  const reason = review.reasonCode ? reasonText(t, review.reasonCode) : review.reason;
  if (!title && approveLabel === review.approveLabel && !fieldsChanged && reason === review.reason)
    return review;
  return {
    ...review,
    ...(title ? { title } : {}),
    approveLabel,
    fields: fieldsChanged ? fields : review.fields,
    reason,
  };
}
