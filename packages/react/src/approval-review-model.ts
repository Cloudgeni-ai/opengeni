// What a pending tool approval says to the person before they decide: a
// readable title, the account it acts on, its plain consequence and its
// fields, with the answer buttons in their words. Renderer-neutral, so the
// web approval card and the React Native one read the same; no DOM here.
import { toolReviewAction, toolReviewFields, type ToolActionReview } from "@opengeni/sdk";
import { decodeReviewArguments } from "@opengeni/contracts/tool-review-presentation";
import type { PendingApproval } from "./approvals";
import type { OpenGeniText } from "./messages/runtime";
import { toolDisplayName } from "./timeline/tool-display-name";
import { builtInToolStep } from "./timeline/tool-steps";

/** The tool a settings-through-chat action calls; its card asks a plain question. */
export const APP_ACTION_TOOL_NAME = "admin_action_call";

/** Fields that only identify the selection; the count, examples and details cover them. */
const SELECTION_PATHS = new Set([
  "/messageIds",
  "/messageId",
  "/threadId",
  "/addLabelIds",
  "/removeLabelIds",
  "/labelIds",
]);
/** Long argument lists stay readable; the full set is one tap away in details. */
export const VISIBLE_REVIEW_FIELDS = 6;

/**
 * The full arguments behind a card's details, indented for reading. Arguments
 * that arrive JSON-encoded are decoded once, so details never show an escaped
 * string; anything else is shown as it came.
 */
export function approvalArgumentsText(approval: PendingApproval): string {
  const value = approval.arguments ?? approval.raw ?? {};
  const decoded = decodeReviewArguments(value);
  if (decoded) return JSON.stringify(decoded, null, 2);
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * The facts a review card lists: its selection field (when it acts on a
 * counted selection), the fields shown, how many more sit in details, and the
 * effects the title does not already name.
 */
export function reviewFacts(review: ToolActionReview) {
  const selection =
    review.selectionCount === undefined
      ? undefined
      : review.fields.find((field) =>
          ["/messageIds", "/messageId", "/threadId"].includes(field.path),
        );
  const fields = selection
    ? review.fields.filter((field) => !SELECTION_PATHS.has(field.path))
    : review.fields;
  const shown = fields.slice(0, VISIBLE_REVIEW_FIELDS);
  return {
    selection,
    shown,
    hiddenFields: fields.length - shown.length + review.moreFields,
    // The title already names the main effect; list only the remaining ones.
    effects: review.effects.filter(
      (effect) => effect !== review.approveLabel && !review.title.startsWith(effect),
    ),
  };
}

/** A tool's readable name: "batch_modify_messages" → "Modify messages". */
export function formatApprovalToolName(t: OpenGeniText, name: string): string {
  return name.includes("__") || /^[a-f0-9]{64}$/.test(name) || builtInToolStep(name)
    ? toolDisplayName(t, name, undefined, "running")
    : humanToolName(name.replaceAll("_", " ").replaceAll(".", " › "));
}

/** "batch modify messages" → "Modify messages": how a call is grouped is not what it does. */
function humanToolName(name: string): string {
  const phrase = name.replace(/^batch\s+/i, "").trim();
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : name;
}

/** The tool the approval is for, as the runtime displays it. */
export function approvalToolName(approval: PendingApproval): string {
  return approval.display?.toolName ?? approval.name;
}

/**
 * An app action's card asks the person a plain question ("Invite … to your
 * organization?"), so its buttons answer it: Allow or Cancel. Null for other
 * tools, which keep the host's approve and decline words.
 */
export function approvalAnswerLabels(
  t: OpenGeniText,
  toolName: string,
): { approve: string; reject: string } | null {
  return toolName === APP_ACTION_TOOL_NAME
    ? { approve: t("approvalSurface.allow"), reject: t("approvalSurface.cancel") }
    : null;
}

/**
 * The review a pending approval shows from its own arguments, before (or
 * without) the server's versioned review. It never changes what is approved.
 */
export function pendingApprovalReview(
  approval: PendingApproval,
  options: { formatToolName: (name: string) => string; approveLabel: string },
): ToolActionReview {
  const toolName = approvalToolName(approval);
  const action = toolReviewAction(toolName, approval.arguments, {
    kind: "generic",
    title: approval.display?.title ?? options.formatToolName(toolName),
  });
  return {
    version: 1,
    id: approval.id,
    actionDigest: "",
    revision: "legacy",
    status: "pending",
    ...action,
    ...(approval.display?.accountLabel ? { accountLabel: approval.display.accountLabel } : {}),
    ...toolReviewFields(approval.arguments, undefined, toolName),
    reason: "",
    createdAt: "",
    updatedAt: "",
    approveLabel: options.approveLabel,
    availableActions: approval.arguments === undefined ? [] : ["approve", "reject"],
    detailsAvailable: approval.arguments !== undefined,
  };
}
