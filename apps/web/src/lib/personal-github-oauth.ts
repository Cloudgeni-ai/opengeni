import { PERSONAL_GITHUB_SETUP_QUERY_VALUE } from "@opengeni/contracts/personal-github";

export type PersonalGitHubOAuthReturn = {
  outcome: "success" | "error";
  reason: string | null;
  cleanedSearch: string;
};

/** How long a started connect may wait to open the repository chooser. */
const CHOOSER_INTENT_MAX_AGE_MS = 30 * 60 * 1000;

function chooserIntentKey(workspaceId: string): string {
  return `opengeni:github-personal-choose-repos:${workspaceId}`;
}

/**
 * Remember that the person started connecting their GitHub here, so the
 * repository chooser opens as soon as the connection is active on return.
 */
export function markPersonalGitHubRepositoryChooser(workspaceId: string, now = Date.now()): void {
  try {
    window.sessionStorage.setItem(chooserIntentKey(workspaceId), String(now));
  } catch {
    // Storage may be unavailable; the chooser is then one click away.
  }
}

/** Consume a recent connect intent: true once, within its time window. */
export function takePersonalGitHubRepositoryChooser(
  workspaceId: string,
  now = Date.now(),
): boolean {
  try {
    const key = chooserIntentKey(workspaceId);
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return false;
    window.sessionStorage.removeItem(key);
    const startedAt = Number(raw);
    return (
      Number.isFinite(startedAt) &&
      now - startedAt >= 0 &&
      now - startedAt <= CHOOSER_INTENT_MAX_AGE_MS
    );
  } catch {
    return false;
  }
}

/**
 * The `github=personal` deep link (see `personalGitHubSetupPath`): whether it
 * is present, and the search string without it.
 */
export function personalGitHubSetupLink(search: string): { cleanedSearch: string } | null {
  const params = new URLSearchParams(search);
  if (params.get("github") !== PERSONAL_GITHUB_SETUP_QUERY_VALUE) return null;
  params.delete("github");
  const cleaned = params.toString();
  return { cleanedSearch: cleaned ? `?${cleaned}` : "" };
}

export function personalGitHubOAuthReturn(search: string): PersonalGitHubOAuthReturn | null {
  const params = new URLSearchParams(search);
  const outcome = params.get("github_personal_oauth");
  if (outcome !== "success" && outcome !== "error") return null;
  const reason = params.get("reason");
  params.delete("github_personal_oauth");
  params.delete("connectionId");
  params.delete("reason");
  const cleaned = params.toString();
  return { outcome, reason, cleanedSearch: cleaned ? `?${cleaned}` : "" };
}

export function personalGitHubOAuthFailureMessage(reason: string | null): string {
  switch (reason) {
    case "provider_denied":
      return "GitHub authorization was cancelled.";
    case "account_mismatch":
      return "Reconnect with the same GitHub account, or disconnect it first.";
    case "not_authorized":
      return "Your Opengeni access changed. Sign in again and retry.";
    case "client_changed":
      return "The GitHub sign-in configuration changed. Start again.";
    case "disabled":
      return "Personal GitHub sign-in is unavailable for this deployment.";
    case "scope_not_granted":
      return "GitHub did not grant the required repository access.";
    case "identity_failed":
    case "token_exchange_failed":
      return "GitHub could not verify this account. Try again.";
    case "invalid_state":
    case "state_replayed":
    case "missing_code":
      return "This GitHub sign-in link expired. Start again.";
    case "connection_conflict":
    default:
      return "The GitHub connection changed. Refresh and try again.";
  }
}
