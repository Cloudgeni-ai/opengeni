/** Callback reasons are display hints only. Never grant authority or echo arbitrary query text. */
export function slackInstallFeedback(reason: string | null): {
  title: string;
  description: string;
  retryable: boolean;
} {
  if (reason === "http_409")
    return {
      title: "Slack is already linked to another installation",
      description:
        "An existing connection needs to be resolved before this one can finish. Ask your organization owner to review the Slack connection. Repeating setup will not resolve this conflict.",
      retryable: false,
    };
  if (reason === "http_403")
    return {
      title: "Your permission to connect Slack changed",
      description: "Ask a workspace admin for connection management access, then try again.",
      retryable: false,
    };
  if (reason === "provider_denied")
    return {
      title: "Slack setup was cancelled",
      description: "Allow OpenGeni in Slack to finish connecting your workspace.",
      retryable: true,
    };
  return {
    title: "Slack setup did not finish",
    description:
      "Try connecting again. If it still fails, ask your organization owner to review the existing Slack installation.",
    retryable: true,
  };
}

export function clearSlackInstallResult() {
  const url = new URL(window.location.href);
  url.searchParams.delete("slack");
  url.searchParams.delete("reason");
  url.searchParams.delete("connectionId");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
