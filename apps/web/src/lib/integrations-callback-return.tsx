import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { slackSettingsSearch } from "@/lib/slack-settings-search";

/**
 * Outcome parameters an integration callback (or a deep link into the
 * integrations page) may carry. Forwarding keeps exactly these, so a callback
 * that lands on `/integrations` or on the legacy `/capabilities` path still
 * shows its result on the Plugins page. Anything else, including bearer-shaped
 * values such as a `slack_link` token, is dropped rather than copied into a new
 * URL. Values are display hints only: each reader maps them to its own copy.
 */
const CALLBACK_KEYS = [
  "integration_oauth",
  "stage",
  "reason",
  "connect_item",
  "connectionId",
  "providerDomain",
  "ownership",
  "verification",
  "definitionId",
  "api_integration_definition",
  "api_integration_instance",
  "api_integration_name",
  "api_integration_ownership",
  "api_integration_expected",
  "social_oauth",
  "accountHandle",
  "atlassian",
  "fiken",
  "google_drive",
  "github_personal_oauth",
  "suggested_capability",
  "reconnect_domain",
] as const;

const MAX_CALLBACK_VALUE_LENGTH = 512;

/**
 * The workspace Plugins page href for a forwarded callback. Slack's own
 * parameters keep their existing sanitization; every other outcome parameter is
 * copied verbatim (bounded) so readers see exactly what the API sent.
 */
export function workspaceIntegrationsCallbackHref(
  workspaceId: string,
  search: string,
  section?: "skills",
): string {
  const incoming = new URLSearchParams(search);
  const outgoing = new URLSearchParams();
  if (section === "skills" || incoming.get("section") === "skills") {
    outgoing.set("section", "skills");
  }
  const slack = slackSettingsSearch(Object.fromEntries(incoming));
  for (const key of CALLBACK_KEYS) {
    // A Slack outcome owns `reason`/`connectionId`, already sanitized above.
    if (slack.slack && (key === "reason" || key === "connectionId")) continue;
    const value = incoming.get(key);
    if (value !== null && value.length <= MAX_CALLBACK_VALUE_LENGTH) outgoing.set(key, value);
  }
  for (const [key, value] of Object.entries(slack)) outgoing.set(key, value);
  const query = outgoing.toString();
  return `/workspaces/${encodeURIComponent(workspaceId)}/plugins${query ? `?${query}` : ""}`;
}

/**
 * Replaces the current location with an already-built href. Navigating by
 * `href` keeps each query value exactly as written; rebuilding it from a search
 * object would JSON-quote number-like strings such as a numeric account handle.
 */
export function ReplaceLocation({ href }: { href: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ href, replace: true });
  }, [href, navigate]);
  return null;
}
