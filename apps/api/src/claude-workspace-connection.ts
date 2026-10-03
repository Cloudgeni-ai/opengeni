import { createHmac } from "node:crypto";
import { requireEnvironmentEncryption } from "@opengeni/core";
import { ClaudeSubscriptionCredential, type Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";

/** Validate the canonical model lane before it bypasses integration acquisition. */
export function assertClaudeWorkspaceCredential(
  settings: Pick<Settings, "claudeSubscriptionEnabled">,
  input: {
    subjectId: string | null;
    providerDomain: string;
    kind: string;
    metadata?: Record<string, unknown>;
    credential: unknown;
  },
): void {
  const role = input.metadata?.credentialRole;
  if (role !== "anthropic" && role !== "claude_subscription") return;
  if (role === "claude_subscription" && !settings.claudeSubscriptionEnabled)
    throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
  if (role === "claude_subscription")
    throw new HTTPException(410, { message: "Use individual Claude subscription accounts." });
  if (
    input.subjectId !== null ||
    input.providerDomain !== "api.anthropic.com" ||
    input.kind !== "api_key"
  )
    throw new HTTPException(422, {
      message: "Claude model connections must belong to this workspace",
    });
  const credential = input.credential;
  const key =
    credential && typeof credential === "object" && "apiKey" in credential
      ? credential.apiKey
      : null;
  if (typeof key !== "string")
    throw new HTTPException(422, { message: "Claude connection credential is required" });
  if (role === "anthropic") {
    if (!/^sk-ant-api[0-9]+-\S+$/.test(key))
      throw new HTTPException(422, {
        message: "Enter an Anthropic API key. Use Claude subscription for setup tokens.",
      });
    return;
  }
}

/** Stable installation identity; setup tokens do not grant profile access. */
export function prepareClaudeSubscriptionCredential(
  settings: Settings,
  scope: string,
  token: string,
  identity?: { accountUuid: string; deviceId: string },
): string {
  if (!settings.claudeSubscriptionEnabled)
    throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
  if (!/^sk-ant-oat[0-9]+-\S+$/.test(token))
    throw new HTTPException(422, { message: "Enter the setup token from claude setup-token." });
  return JSON.stringify(
    ClaudeSubscriptionCredential.parse({
      version: 1,
      token,
      identity: identity ?? {
        accountUuid: "",
        deviceId: createHmac("sha256", requireEnvironmentEncryption(settings))
          .update("claude-device:" + scope)
          .digest("hex"),
      },
    }),
  );
}

export function prepareClaudeWorkspaceCredential(
  settings: Settings,
  workspaceId: string,
  metadata: Record<string, unknown> | undefined,
  credential: Record<string, unknown>,
): Record<string, unknown> {
  if (metadata?.credentialRole !== "claude_subscription") return credential;
  if (!settings.claudeSubscriptionEnabled)
    throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
  throw new HTTPException(410, { message: "Use individual Claude subscription accounts." });
}
