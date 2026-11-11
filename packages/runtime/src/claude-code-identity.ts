import { createHash, randomUUID } from "node:crypto";
import type { ModelRequest } from "@openai/agents";
import type { ClaudeSubscriptionIdentity } from "@opengeni/config";

/** One pinned Claude Code release, as seen on the wire. */
export type ClaudeCodeClient = {
  version: string;
  agentSdkVersion: string;
  stainlessPackageVersion: string;
};

// Locally inspected Claude Code 2.1.285 / Agent SDK 0.3.276 captures.
export const CLAUDE_CODE_2_1_285: ClaudeCodeClient = {
  version: "2.1.285",
  agentSdkVersion: "0.3.276",
  stainlessPackageVersion: "0.127.0",
};
// Claude Code 2.1.321 / Agent SDK 0.3.321 (2026-11-09): same billing fingerprint
// salt and algorithm as 2.1.285 in the published binary; bundled Stainless SDK 0.128.0.
export const CLAUDE_CODE_2_1_321: ClaudeCodeClient = {
  version: "2.1.321",
  agentSdkVersion: "0.3.321",
  stainlessPackageVersion: "0.128.0",
};

/**
 * Anthropic refuses a model the presented Claude Code release doesn't know
 * ("version 2.1.290 or newer is required" for Claude Fable 5.2). A model added
 * later names the first pinned release that supports it. Every other model
 * keeps 2.1.285: the version is part of the billing system block that starts
 * every cached prefix, so changing it would rewrite text that running
 * sessions already sent.
 */
const CLAUDE_CODE_CLIENT_BY_MODEL: Readonly<Record<string, ClaudeCodeClient>> = {
  "claude-fable-5-2": CLAUDE_CODE_2_1_321,
};
export function claudeCodeClient(model: string | undefined): ClaudeCodeClient {
  return model !== undefined && Object.hasOwn(CLAUDE_CODE_CLIENT_BY_MODEL, model)
    ? CLAUDE_CODE_CLIENT_BY_MODEL[model]!
    : CLAUDE_CODE_2_1_285;
}

// These are compatibility wire values, not a claim about Opengeni's host runtime.
export function claudeCodeHeaders(client: ClaudeCodeClient = CLAUDE_CODE_2_1_285) {
  return {
    "user-agent": `claude-cli/${client.version} (external, sdk-ts, agent-sdk/${client.agentSdkVersion})`,
    "x-app": "cli",
    "x-stainless-lang": "js",
    "x-stainless-package-version": client.stainlessPackageVersion,
    "x-stainless-os": "MacOS",
    "x-stainless-arch": "arm64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v26.3.0",
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-dispatch-id": "v2d",
  } as const;
}
export const CLAUDE_CODE_HEADERS = claudeCodeHeaders(CLAUDE_CODE_2_1_285);

export function claudeCodeFingerprint(
  input: ModelRequest["input"],
  version: string = CLAUDE_CODE_2_1_285.version,
): string {
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
  return createHash("sha256").update(`59cf53e54c78${sample}${version}`).digest("hex").slice(0, 3);
}

export type ClaudeCodeRequestIdentity = {
  sessionId: string;
  promptId: string;
  previousRequestId?: string | undefined;
  /** Upstream model id; picks the Claude Code release presented. */
  model?: string | undefined;
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
  const client = claudeCodeClient(identity.model);
  for (const [name, value] of Object.entries(claudeCodeHeaders(client))) headers.set(name, value);
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
  const billing = `x-anthropic-billing-header: cc_version=${client.version}.${claudeCodeFingerprint(request.input, client.version)}; cc_entrypoint=sdk-ts;${previous} cc_prompt_id=${identity.promptId}; cc_turn_origin=sdk;`;
  body.system = [{ type: "text", text: billing }, ...(body.system ?? [])];
}
