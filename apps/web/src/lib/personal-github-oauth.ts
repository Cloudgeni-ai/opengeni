export type PersonalGitHubOAuthReturn = {
  outcome: "success" | "error";
  reason: string | null;
  cleanedSearch: string;
};

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
      return "Your OpenGeni access changed. Sign in again and retry.";
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
