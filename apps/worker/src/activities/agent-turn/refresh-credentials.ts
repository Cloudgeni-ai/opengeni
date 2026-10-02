import type { AttemptToolDefinition } from "@opengeni/codemode";

export const REFRESH_CREDENTIALS_TOOL_NAME = "refresh_credentials";

export const REFRESH_CREDENTIALS_TOOL_DESCRIPTION =
  "Fetch fresh host-managed credentials for this sandbox now. Use it when a command fails because a token or credential file provided by the workspace has expired or been revoked. The environment variables and credential files that the host manages are replaced for the next command; commands that are already running keep what they started with.";

export function createRefreshCredentialsAttemptToolDefinition(input: {
  refresh: () => Promise<"completed" | "auth_needed" | "error" | "not_provisioned">;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: REFRESH_CREDENTIALS_TOOL_NAME },
    modelName: REFRESH_CREDENTIALS_TOOL_NAME,
    codemodePath: ["opengeni", REFRESH_CREDENTIALS_TOOL_NAME],
    title: "Refresh credentials",
    description: REFRESH_CREDENTIALS_TOOL_DESCRIPTION,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      title: "Refresh credentials",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      if (Object.keys(args).length !== 0) {
        throw new Error(`${REFRESH_CREDENTIALS_TOOL_NAME} accepts no arguments`);
      }
      const outcome = await input.refresh();
      const text = {
        completed: "Credentials refreshed. Retry the command that failed.",
        auth_needed:
          "The host returned credentials that need user attention (reconnect or grant access). Continue with what is available and tell the user which service needs reconnecting.",
        error:
          "The credential provider could not be reached. The previous credentials are still in place and a retry is scheduled.",
        not_provisioned:
          "Credentials are provisioned when the sandbox first starts; run a command and they will be fetched then.",
      }[outcome];
      return { isError: outcome === "error", content: [{ type: "text", text }] };
    },
  };
}
