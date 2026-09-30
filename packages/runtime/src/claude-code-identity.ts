import { createHash, randomUUID } from "node:crypto";
import type { ModelRequest } from "@openai/agents";
import type { ClaudeSubscriptionIdentity } from "@opengeni/config";

// Pinned to locally inspected Claude Code 2.1.285 / Agent SDK 0.3.276 captures.
// These are compatibility wire values, not a claim about OpenGeni's host runtime.
export const CLAUDE_CODE_HEADERS = {
  "user-agent": "claude-cli/2.1.285 (external, sdk-ts, agent-sdk/0.3.276)",
  "x-app": "cli",
  "x-stainless-lang": "js",
  "x-stainless-package-version": "0.127.0",
  "x-stainless-os": "MacOS",
  "x-stainless-arch": "arm64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "600",
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-dispatch-id": "v2d",
} as const;

export function claudeCodeFingerprint(input: ModelRequest["input"]): string {
  const message =
    typeof input === "string"
      ? input
      : input.find(
          (item) =>
            (item.type === undefined || item.type === "message") &&
            "role" in item &&
            item.role === "user",
        );
  const content =
    typeof message === "string" ? message : message && "content" in message ? message.content : "";
  const first =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.find((block) => block.type === "input_text" || String(block.type) === "text")
        : undefined;
  const prompt =
    typeof first === "string" ? first : first && "text" in first ? String(first.text) : "";
  const sample = [4, 7, 20].map((index) => prompt[index] || "0").join("");
  return createHash("sha256").update(`59cf53e54c78${sample}2.1.285`).digest("hex").slice(0, 3);
}

export type ClaudeCodeRequestIdentity = {
  sessionId: string;
  promptId: string;
  previousRequestId?: string | undefined;
};

export function applyClaudeCodeIdentity(
  body: Record<string, any>,
  headers: Headers,
  url: URL,
  request: ModelRequest,
  account: ClaudeSubscriptionIdentity,
  identity: ClaudeCodeRequestIdentity,
): void {
  url.searchParams.set("beta", "true");
  for (const [name, value] of Object.entries(CLAUDE_CODE_HEADERS)) headers.set(name, value);
  headers.set("accept", "application/json");
  headers.set("x-claude-code-session-id", identity.sessionId);
  headers.set("x-claude-code-prompt-id", identity.promptId);
  headers.set("x-client-request-id", randomUUID());
  body.metadata = {
    user_id: JSON.stringify({
      device_id: account.deviceId,
      account_uuid: account.accountUuid,
      session_id: identity.sessionId,
    }),
  };
  const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").filter(Boolean));
  betas.add("claude-code-20250219");
  betas.add("oauth-2025-04-20");
  if (body.thinking) {
    betas.add("interleaved-thinking-2025-05-14");
    betas.add("thinking-token-count-2026-05-13");
    betas.add("effort-2025-11-24");
    betas.add("thinking-display-updates-2026-08-18");
    body.thinking.display = "summarized";
  }
  if (
    [
      ...(body.system ?? []),
      ...(body.tools ?? []),
      ...body.messages.flatMap((m: any) => m.content),
    ].some((block) => block.cache_control?.ttl === "1h")
  )
    betas.add("extended-cache-ttl-2025-04-11");
  headers.set("anthropic-beta", [...betas].join(","));
  const previous =
    identity.previousRequestId && /^req_[A-Za-z0-9_-]{1,36}$/.test(identity.previousRequestId)
      ? ` cc_prev_req=${identity.previousRequestId};`
      : "";
  // The version suffix is derived from the first user message. Never replay a
  // captured checksum. cch is deliberately omitted until its algorithm is verified.
  const billing = `x-anthropic-billing-header: cc_version=2.1.285.${claudeCodeFingerprint(request.input)}; cc_entrypoint=sdk-ts;${previous} cc_prompt_id=${identity.promptId}; cc_turn_origin=sdk;`;
  body.system = [{ type: "text", text: billing }, ...(body.system ?? [])];
}
