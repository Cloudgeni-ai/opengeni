/*
 * Deleting the signed-in account from the app (GET and POST
 * /v1/me/account-deletion): what closes and what the person leaves, what
 * blocks it, the typed confirmation, and how each refusal reads. No React
 * Native here, so it is tested on its own; `app/delete-account.tsx` draws it.
 */
import { OpenGeniApiError } from "@opengeni/sdk";

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE";
export const LAST_ORGANIZATION_OWNER = "LAST_ORGANIZATION_OWNER";

/** What the server tells people once deletion has started (and on its confirmation screen). */
export const ACCOUNT_DELETION_STARTED_COPY =
  "You'll be signed out on all devices immediately. Deletion usually takes a few minutes and can take up to 30 days. We'll email you when it's complete.";

export type AccountDeletionOrganization = { organizationId: string; name: string };

export type AccountDeletionRetention = { mode: "retain" | "delete_after"; days: number | null };

export type AccountDeletionBlocker = {
  code: typeof LAST_ORGANIZATION_OWNER | (string & {});
  organizationId: string;
  name: string;
};

export type AccountDeletionRequest = {
  id: string;
  operationId: string;
  status: "pending" | "running" | "blocked" | "completed";
  requestedAt: string;
  completedAt: string | null;
};

export type AccountDeletionPreview = {
  closeOrganizations: AccountDeletionOrganization[];
  leaveOrganizations: (AccountDeletionOrganization & { retention: AccountDeletionRetention })[];
  blockers: AccountDeletionBlocker[];
  request: AccountDeletionRequest | null;
};

export interface AccountDeletionApi {
  read(): Promise<AccountDeletionPreview>;
  /** Start deletion; the same `operationId` again is the same request. */
  request(operationId: string): Promise<AccountDeletionRequest>;
}

type ApiFetcher = { fetchApi(input: string, init?: RequestInit): Promise<Response> };

async function json<T>(response: Response, mutation: boolean): Promise<T> {
  const body = await response.text();
  if (!response.ok) {
    throw new OpenGeniApiError(response.status, body, {
      mutation,
      correlationId: response.headers.get("x-request-id") ?? undefined,
    });
  }
  return JSON.parse(body) as T;
}

/** The account-deletion endpoints over the signed-in client's credential. */
export function accountDeletionApi(client: ApiFetcher): AccountDeletionApi {
  return {
    read: async () =>
      json<AccountDeletionPreview>(
        await client.fetchApi("/v1/me/account-deletion", {
          method: "GET",
          headers: { Accept: "application/json" },
        }),
        false,
      ),
    request: async (operationId) =>
      (
        await json<{ request: AccountDeletionRequest }>(
          await client.fetchApi("/v1/me/account-deletion", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: ACCOUNT_DELETION_CONFIRMATION, operationId }),
          }),
          true,
        )
      ).request,
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

/** What happens to what the person made in an organization they leave. */
export function retentionText(retention: AccountDeletionRetention): string {
  if (retention.mode === "retain") return "What you made there stays with the organization";
  if (retention.days === null || retention.days <= 0) return "What you made there is deleted";
  return retention.days === 1
    ? "What you made there is deleted after 1 day"
    : `What you made there is deleted after ${retention.days} days`;
}

export type AccountDeletionFailure =
  /** Someone must become an owner first; the server's current blockers. */
  | { kind: "blocked"; message: string; blockers: AccountDeletionBlocker[] }
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
  return blockers.filter(
    (each): each is AccountDeletionBlocker =>
      typeof each === "object" &&
      each !== null &&
      typeof (each as AccountDeletionBlocker).organizationId === "string" &&
      typeof (each as AccountDeletionBlocker).name === "string",
  );
}

/** A refused read or request, in the person's terms. */
export function accountDeletionFailure(error: unknown): AccountDeletionFailure {
  if (!(error instanceof OpenGeniApiError)) {
    return {
      kind: "failed",
      message: "Couldn't reach Opengeni. Check your connection and try again.",
    };
  }
  if (error.status === 409 && error.details?.code === LAST_ORGANIZATION_OWNER) {
    return {
      kind: "blocked",
      message: "Transfer ownership before deleting your account.",
      blockers: blockersFrom(error),
    };
  }
  if (error.status === 401) {
    return {
      kind: "signedOut",
      message: "You've been signed out. Sign in again to delete your account.",
    };
  }
  if (error.status === 404 || error.status === 405 || error.status === 503) {
    return {
      kind: "unavailable",
      message:
        error.status === 503
          ? "Account deletion isn't available right now. Try again later."
          : "This Opengeni server doesn't support deleting your account from the app. You can delete it on the web.",
    };
  }
  return { kind: "failed", message: "Your account wasn't deleted. Try again." };
}
