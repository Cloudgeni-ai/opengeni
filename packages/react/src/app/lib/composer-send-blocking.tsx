import type { ReactNode } from "react";
import { Button } from "../../ui/button";
import { Notice } from "../../ui/notice";
import type { LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import {
  effortOptionsForModel,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "../../model-policy";

/**
 * Why Send cannot run right now: the one source of truth shared by the new
 * chat and open chat composers. Every blocker either shows one short visible
 * line (composerSendBlockerNotice) or is explained by a surface the host
 * already renders. A disabled Send button is never the only signal.
 */
export type ComposerSendBlocker =
  | "upload"
  | "repository"
  | "policy"
  | "personal_decision"
  | "machine_permission"
  | "personal_loading"
  /** Something Send needs is still loading; an early Send waits for it. */
  | "loading"
  | "model_catalog"
  | "no_model"
  | "model_not_connected"
  | "model_unavailable"
  | "private_session"
  | "accounts"
  /** The person may not read the chat's connected accounts; an admin must grant it. */
  | "accounts_denied"
  /** Opengeni is briefly unreachable; the page reconnects on its own. */
  | "updating"
  | "account_choice"
  | "resources"
  | "compute";

export function getComposerSendBlocker(input: {
  uploadPending: boolean;
  repositoryError: string | null;
  policyValid: boolean;
  personalDecision: boolean;
  personalLoading: boolean;
  /**
   * Something Send needs failed to load (the chat's connected accounts):
   * a failure Retry may fix, a permission denial, or a brief outage the page
   * reconnects from by itself.
   */
  loadFailed?: false | "failed" | "denied" | "updating" | undefined;
  machineAccessDenied?: boolean | undefined;
}): ComposerSendBlocker | null {
  if (input.uploadPending) return "upload";
  if (input.repositoryError !== null) return "repository";
  if (!input.policyValid) return "policy";
  if (input.machineAccessDenied) return "machine_permission";
  if (input.personalDecision) return "personal_decision";
  if (input.personalLoading) return "personal_loading";
  if (input.loadFailed === "denied") return "accounts_denied";
  if (input.loadFailed === "updating") return "updating";
  if (input.loadFailed) return "accounts";
  return null;
}

/** Whether a model choice can run: the row is selectable and offers the effort and speed. */
export function pickerPolicyRunnable(
  row: PickerModelRow | null | undefined,
  effort: ReasoningEffort,
  latencyMode: LatencyMode,
): boolean {
  return Boolean(
    row?.selectable &&
    effortOptionsForModel(row.catalog).includes(effort) &&
    (latencyMode === "standard" || runnableLatencyModesForModel(row.catalog).includes(latencyMode)),
  );
}

/** Everything the new-chat composer's Send depends on, apart from the text. */
export type NewSessionSendState = {
  /** A failed create left a session to retry into. */
  created: boolean;
  /** A voice launch does not bind connected-tool accounts. */
  voice?: boolean | undefined;
  draftLoading: boolean;
  catalogLoading: boolean;
  catalogFailed: boolean;
  /** The composer is switching away from an unavailable model. */
  replacingModel: boolean;
  policyValid: boolean;
  anyModelSelectable: boolean;
  selectedModelNotConnected: boolean;
  selectedModelSelectable: boolean;
  /** Whether this workspace can create the chat's private visibility is still loading. */
  privateSessionLoading?: boolean | undefined;
  privateSessionUnavailable: boolean;
  toolsLoading: boolean;
  accountsLoading: boolean;
  accountsFailed: boolean;
  accountChoice: boolean;
  resourcesLoading: boolean;
  resourcesResolved: boolean;
  uploadPending: boolean;
  computeLoading: boolean;
  computeReady: boolean;
};

/**
 * The new-chat Send guard. Send's enabled state, the guard Send runs, the
 * early-Send hold and the visible line all read this one answer, so a Send
 * that looks available can never do nothing.
 */
export function getNewSessionSendBlocker(input: NewSessionSendState): ComposerSendBlocker | null {
  if (input.draftLoading || input.catalogLoading || input.replacingModel) return "loading";
  if (!input.policyValid) {
    // A failed refresh keeps the last good list; only a choice it can't
    // confirm is blocked by it.
    if (input.catalogFailed) return "model_catalog";
    if (!input.anyModelSelectable) return "no_model";
    if (input.selectedModelNotConnected) return "model_not_connected";
    return input.selectedModelSelectable ? "policy" : "model_unavailable";
  }
  // Unknown is not unavailable: an early Send waits for the answer.
  if (input.privateSessionLoading) return "loading";
  if (input.privateSessionUnavailable) return "private_session";
  if (input.toolsLoading) return "loading";
  // A session already created by a failed attempt keeps its accounts,
  // environment, files and compute: only the checks above still apply.
  if (input.created) return null;
  if (!input.voice) {
    if (input.accountsLoading) return "loading";
    if (input.accountsFailed) return "accounts";
    if (input.accountChoice) return "account_choice";
  }
  if (input.resourcesLoading) return "loading";
  if (!input.resourcesResolved) return "resources";
  if (input.uploadPending) return "upload";
  if (input.computeLoading) return "loading";
  if (!input.computeReady) return "compute";
  return null;
}

/** Blockers that clear on their own once loading finishes. */
export function composerSendBlockerIsLoading(blocker: ComposerSendBlocker | null): boolean {
  return blocker === "loading" || blocker === "personal_loading";
}

/** The one action a blocker's line may offer. */
export type ComposerSendBlockerAction = "fix_model_settings" | "retry";

/**
 * One short line for a blocker, with at most one action. Blockers whose own
 * surface always explains them (the upload chip, the personal access card,
 * the machine access notice, the picker's Connect state) and loading return
 * null; a host that explains another one itself passes it as explained.
 */
export function composerSendBlockerNotice(
  blocker: ComposerSendBlocker | null,
): { message: string; action: { kind: ComposerSendBlockerAction; label: string } | null } | null {
  switch (blocker) {
    case "policy":
      return {
        message: "This model can't run with the selected reasoning level or speed.",
        action: { kind: "fix_model_settings", label: "Use supported settings" },
      };
    case "model_not_connected":
      return { message: "Connect this model or choose another one.", action: null };
    case "model_unavailable":
      return { message: "This model isn't available. Choose another one.", action: null };
    case "model_catalog":
      return { message: "Couldn't load models.", action: { kind: "retry", label: "Retry" } };
    case "accounts":
      return {
        message: "Couldn't load your connected accounts.",
        action: { kind: "retry", label: "Retry" },
      };
    case "accounts_denied":
      return {
        message: "You can't view this chat's accounts. Ask a workspace admin.",
        action: null,
      };
    case "updating":
      return { message: "Reconnecting. Send will work again in a moment.", action: null };
    case "repository":
      return { message: "Check the selected repositories to send.", action: null };
    case "private_session":
      return { message: "Private chats aren't available here.", action: null };
    case "resources":
      return { message: "The selected environment isn't available. Choose another.", action: null };
    case "compute":
      return { message: "Choose where this chat runs.", action: null };
    default:
      return null;
  }
}

/**
 * The analytics reason for a blocked new-chat Send. Reasons recorded before
 * this guard existed keep their names; blockers that were not recorded before
 * (for example accounts, account_choice and resources) report their own name,
 * and the order of checks changed (private chat comes before uploads).
 */
export function newSessionStartBlockerReason(blocker: ComposerSendBlocker | null): string | null {
  switch (blocker) {
    case null:
    case "loading":
    case "personal_loading":
      return null;
    case "model_catalog":
      return "model_catalog_unavailable";
    case "no_model":
      return "no_model_connected";
    case "model_not_connected":
      return "selected_model_not_connected";
    case "policy":
    case "model_unavailable":
      return "model_policy_unavailable";
    case "private_session":
      return "private_session_unavailable";
    case "upload":
      return "attachments_pending";
    case "compute":
      return "compute_unavailable";
    default:
      return blocker;
  }
}

/** The visible line under a composer whose Send is blocked. */
export function ComposerSendBlockerNotice({
  blocker,
  explained,
  onAction,
  className,
}: {
  blocker: ComposerSendBlocker | null;
  /** Blockers another surface on this page already explains. */
  explained?: readonly ComposerSendBlocker[] | undefined;
  onAction?: ((action: ComposerSendBlockerAction) => void) | undefined;
  className?: string | undefined;
}): ReactNode {
  const notice =
    blocker && explained?.includes(blocker) ? null : composerSendBlockerNotice(blocker);
  if (!notice) return null;
  const action = notice.action && onAction ? notice.action : null;
  return (
    <div role="status" className={className}>
      <Notice
        tone="waiting"
        action={
          action ? (
            <Button variant="outline" size="sm" onClick={() => onAction?.(action.kind)}>
              {action.label}
            </Button>
          ) : undefined
        }
      >
        {notice.message}
      </Notice>
    </div>
  );
}

/**
 * A new chat the server refused to start. The chat does not exist yet, so the
 * line under the composer is the only place that can say why; a toast alone
 * disappears before it is read and leaves the person looking at nothing. The
 * line stays until the person changes what they send (text, model, reasoning
 * level or speed), sends successfully, or dismisses it.
 */
export type NewSessionCreateFailure = {
  workspaceId: string;
  /** What was sent when the start was refused (see newSessionSendSignature). */
  signature: string;
  message: string;
};

/** What a Send carries that a refusal is about: the text and the model choice. */
export function newSessionSendSignature(input: {
  text: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
}): string {
  return JSON.stringify([input.text, input.model, input.reasoningEffort, input.latencyMode]);
}

/** The refusal message to show now, or null once the person changed what they send. */
export function visibleNewSessionCreateFailure(
  failure: NewSessionCreateFailure | null,
  current: { workspaceId: string; signature: string },
): string | null {
  if (!failure) return null;
  if (failure.workspaceId !== current.workspaceId) return null;
  return failure.signature === current.signature ? failure.message : null;
}

/**
 * The refusal to keep under the composer, or null when the composer no longer
 * holds what was sent (typing or a model change landed while the start was in
 * flight). On null the caller keeps its toast, so a refused start is never
 * silent.
 */
export function newSessionCreateFailureRecord(input: {
  workspaceId: string;
  /** newSessionSendSignature of the values the request actually carried. */
  sent: string;
  /** newSessionSendSignature of what the composer holds now. */
  current: string;
  message: string;
}): NewSessionCreateFailure | null {
  if (input.sent !== input.current) return null;
  return { workspaceId: input.workspaceId, signature: input.sent, message: input.message };
}

/** The persistent line for a refused new chat. */
export function NewSessionCreateFailureNotice({
  message,
  onDismiss,
  className,
}: {
  message: string | null;
  onDismiss?: (() => void) | undefined;
  className?: string | undefined;
}): ReactNode {
  if (!message) return null;
  return (
    <div role="alert" className={className}>
      <Notice tone="failed" {...(onDismiss ? { onDismiss } : {})}>
        {message}
      </Notice>
    </div>
  );
}
