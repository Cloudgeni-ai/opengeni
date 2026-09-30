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
  let bundle: unknown;
  try {
    bundle = JSON.parse(key);
  } catch {
    bundle = null;
  }
  if (!ClaudeSubscriptionCredential.safeParse(bundle).success)
    throw new HTTPException(422, {
      message: "Enter a Claude setup token with its account and device identity.",
    });
}
