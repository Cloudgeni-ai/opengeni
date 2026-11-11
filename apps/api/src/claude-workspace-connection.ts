import { createHmac } from "node:crypto";
import { requireEnvironmentEncryption } from "@opengeni/core";
import { ClaudeSubscriptionCredential, type Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";

const ANTHROPIC_API_KEY_EMPTY_MESSAGE = "Enter an Anthropic API key.";
const ANTHROPIC_API_KEY_MESSAGE =
  "Enter an Anthropic API key. Use Claude subscription for setup tokens.";
const ANTHROPIC_ADMIN_KEY_MESSAGE =
  "This is an Anthropic Admin API key, which can't run models. Create an API key in the Anthropic Console and connect that instead.";
const ANTHROPIC_API_KEY_INCOMPLETE_MESSAGE =
  "This doesn't look like a complete Anthropic API key. Copy the full key from the Anthropic Console and paste it again.";

const QUOTES = "\"'`\u2018\u2019\u201C\u201D";
const LEADING_QUOTES = new RegExp(`^[${QUOTES}]+`, "u");
const TRAILING_QUOTES = new RegExp(`[${QUOTES}]+$`, "u");

/**
 * Clean up a pasted Anthropic API key. Keys never contain whitespace,
 * invisible format characters or quotes, so invisible characters, an env-file
 * line (`export ANTHROPIC_API_KEY="…"`), a line break from a wrapped copy,
 * (smart) quotes at either end and any label before `sk-ant-` (`Bearer `,
 * `x-api-key: `) are removed instead of failing the connection.
 */
export function normalizeAnthropicApiKey(apiKey: string): string {
  let value = apiKey
    .replace(/\p{Cf}+/gu, "")
    .trim()
    .replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*/u, "")
    .replace(/\s+/gu, "");
  const start = value.search(/sk-ant-/iu);
  if (start > 0) value = value.slice(start);
  return value.replace(LEADING_QUOTES, "").replace(TRAILING_QUOTES, "");
}

/**
 * Accept any plausible Anthropic API key (`sk-ant-api…`, personal `sk-ant-usr…`,
 * service-account `sk-ant-svc…` or a future kind); Anthropic itself decides
 * whether it works, and a rejected key surfaces at use. Only credentials that
 * clearly cannot run models through an API key are refused here: an empty
 * value, Claude subscription OAuth access/refresh tokens (`sk-ant-oat…`,
 * `sk-ant-ort…`), Admin API keys (`sk-ant-admin…`) and values with characters
 * an HTTP header can never carry (such as `…` from a masked copy), which would
 * otherwise fail at use before reaching Anthropic.
 */
export function assertAnthropicApiKey(apiKey: string): string {
  const key = normalizeAnthropicApiKey(apiKey);
  if (!key) throw new HTTPException(422, { message: ANTHROPIC_API_KEY_EMPTY_MESSAGE });
  if (/^sk-ant-o(?:at|rt)/iu.test(key))
    throw new HTTPException(422, { message: ANTHROPIC_API_KEY_MESSAGE });
  if (/^sk-ant-admin/iu.test(key))
    throw new HTTPException(422, { message: ANTHROPIC_ADMIN_KEY_MESSAGE });
  if (/[^\x21-\x7E]/u.test(key))
    throw new HTTPException(422, { message: ANTHROPIC_API_KEY_INCOMPLETE_MESSAGE });
  return key;
}

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
    assertAnthropicApiKey(key);
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
  if (metadata?.credentialRole === "anthropic" && typeof credential.apiKey === "string")
    return { ...credential, apiKey: normalizeAnthropicApiKey(credential.apiKey) };
  if (metadata?.credentialRole !== "claude_subscription") return credential;
  if (!settings.claudeSubscriptionEnabled)
    throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
  throw new HTTPException(410, { message: "Use individual Claude subscription accounts." });
}
