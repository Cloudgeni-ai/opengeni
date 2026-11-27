/*
 * Deleting the signed-in account from the app (GET and POST
 * /v1/me/account-deletion): what closes and what the person leaves, what
 * blocks it, the typed confirmation, and how each refusal reads. No React
 * Native here, so it is tested on its own; `app/delete-account.tsx` draws it.
 */
import {
  ACCOUNT_DELETION_LAST_OWNER,
  type AccountDeletionBlocker,
  type AccountDeletionPreview,
  type AccountDeletionRequest,
} from "@opengeni/contracts";
import { OpenGeniApiError, type OpenGeniClient } from "@opengeni/sdk";

export type { AccountDeletionBlocker, AccountDeletionPreview, AccountDeletionRequest };

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE";
/** A retryable 409: the account is changing at that moment. */
export const ACCOUNT_DELETION_BUSY = "ACCOUNT_DELETION_BUSY";
/** The 503 while this deployment hasn't switched account deletion on. */
export const ACCOUNT_DELETION_UNAVAILABLE = "ACCOUNT_DELETION_UNAVAILABLE";

/** What the server tells people once deletion has started (and on its confirmation screen). */
export const ACCOUNT_DELETION_STARTED_COPY =
  "You'll be signed out on all devices immediately. Deletion usually takes a few minutes and can take up to 30 days. We'll email you when it's complete.";

export type AccountDeletionRetention =
  AccountDeletionPreview["leaveOrganizations"][number]["retention"];

export interface AccountDeletionApi {
  read(): Promise<AccountDeletionPreview>;
  /** Start deletion; the same `operationId` again is the same request. */
  request(operationId: string): Promise<AccountDeletionRequest>;
}

/** The account-deletion endpoints over the signed-in client's credential. */
export function accountDeletionApi(
  client: Pick<OpenGeniClient, "getAccountDeletion" | "requestAccountDeletion">,
): AccountDeletionApi {
  return {
    read: () => client.getAccountDeletion(),
    request: async (operationId) =>
      (await client.requestAccountDeletion({ confirm: ACCOUNT_DELETION_CONFIRMATION, operationId }))
        .request,
  };
}

/** The confirmation is typed in full, in capitals; spaces around it don't count. */
export function isDeletionConfirmed(typed: string): boolean {
  return typed.trim() === ACCOUNT_DELETION_CONFIRMATION;
}

/** Deletion already asked for (on another device, or before the app was closed). */
export function deletionUnderway(preview: AccountDeletionPreview): boolean {
  const status = preview.request?.status;
  return status === "pending" || status === "running" || status === "completed";
}

export function canRequestDeletion(input: {
  preview: AccountDeletionPreview;
  typed: string;
  submitting: boolean;
}): boolean {
  return (
    !input.submitting &&
    input.preview.blockers.length === 0 &&
    !deletionUnderway(input.preview) &&
    isDeletionConfirmed(input.typed)
  );
}

/**
 * What happens to the person's own workspace in an organization they leave.
 * Shared chats and files stay with the organization either way.
 */
export function retentionText(retention: AccountDeletionRetention): string {
  if (retention.mode === "retain") return "Your personal workspace there is kept";
  // Without a number the organization's own retention decides when; it isn't at once.
  if (retention.days === null || retention.days <= 0) {
    return "Your personal workspace there is deleted later";
  }
  return retention.days === 1
    ? "Your personal workspace there is deleted after 1 day"
    : `Your personal workspace there is deleted after ${retention.days} days`;
}

export type AccountDeletionFailure =
  /** Someone must become an owner first; the server's current blockers. */
  | { kind: "blocked"; message: string; blockers: AccountDeletionBlocker[] }
  /** The account was changing; the same request can be sent again in a moment. */
  | { kind: "busy"; message: string }
  /**
   * The request went out but no answer came back, so deletion may have
   * started. Sending it again with the same operation ID is safe.
   */
  | { kind: "unconfirmed"; message: string }
  /** The session ended: sign in again to delete the account. */
  | { kind: "signedOut"; message: string }
  /** This deployment can't delete accounts from the app (yet, or at the moment). */
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

/** The refusal's blockers, from its body: the SDK's bounded `details` keeps only flat values. */
function blockersFrom(error: OpenGeniApiError): AccountDeletionBlocker[] {
  let blockers: unknown;
  try {
    const parsed = JSON.parse(error.body) as { error?: { details?: { blockers?: unknown } } };
    blockers = parsed.error?.details?.blockers;
  } catch {
    return [];
  }
  if (!Array.isArray(blockers)) return [];
  return blockers
    .filter(
      (each): each is { organizationId: string; name: string } =>
        typeof each === "object" &&
        each !== null &&
        typeof (each as AccountDeletionBlocker).organizationId === "string" &&
        typeof (each as AccountDeletionBlocker).name === "string",
    )
    .map(({ organizationId, name }) => ({
      code: ACCOUNT_DELETION_LAST_OWNER,
      organizationId,
      name,
    }));
}

/**
 * A refused read or request, in the person's terms. `afterUnconfirmed` is
 * set when an earlier request got no answer: an ended session then most
 * likely means deletion started, since starting it signs every device out.
 */
export function accountDeletionFailure(
  error: unknown,
  options: { afterUnconfirmed?: boolean } = {},
): AccountDeletionFailure {
  if (!(error instanceof OpenGeniApiError)) {
    return {
      kind: "failed",
      message: "Couldn't reach Opengeni. Check your connection and try again.",
    };
  }
  const code = error.details?.code;
  if (error.status === 409 && code === ACCOUNT_DELETION_LAST_OWNER) {
    return {
      kind: "blocked",
      message: "Transfer ownership before deleting your account.",
      blockers: blockersFrom(error),
    };
  }
  if (error.status === 409 && code === ACCOUNT_DELETION_BUSY) {
    return { kind: "busy", message: "Your account is busy. Wait a moment and try again." };
  }
  if (error.status === 401) {
    return {
      kind: "signedOut",
      message: options.afterUnconfirmed
        ? "You've been signed out, which happens on every device once deletion starts. If it started, we'll email you when it's complete. If you don't get an email, sign in again to check."
        : "You've been signed out. Sign in again to delete your account.",
    };
  }
  if (error.status === 503 && code === ACCOUNT_DELETION_UNAVAILABLE) {
    return {
      kind: "unavailable",
      message: "Account deletion isn't available yet. Try again later.",
    };
  }
  if (error.status === 404 || error.status === 405) {
    return {
      kind: "unavailable",
      message:
        "This Opengeni server doesn't support deleting your account from the app. You can delete it on the web.",
    };
  }
  if (error.outcomeUnknown) {
    return {
      kind: "unconfirmed",
      message: "We couldn't confirm that deletion started. Check your connection and try again.",
    };
  }
  return { kind: "failed", message: "Your account wasn't deleted. Try again." };
}
