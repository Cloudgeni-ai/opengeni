import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, run, setTracingDisabled } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  accessTokenExpiry,
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  CODEX_PROVIDER_BASE_URL,
  CODEX_PROVIDER_ID,
  codexRequestStorage,
  type CodexRequestContext,
  type CodexTokenSnapshot,
  parseIdToken,
} from "@opengeni/codex";
import { buildModelInstance, buildProviderClient } from "../src/index";

// Live end-to-end: drives a real @openai/agents turn through the production code
// path — buildProviderClient (codex branch) -> codexSubscriptionFetch -> ALS ->
// OpenAIResponsesModel -> the ChatGPT backend — using the stored ~/.codex/auth.json
// token. Read-only: never refreshes/mutates the token. Skips if absent or expired.

function loadAuth(): { token: CodexTokenSnapshot; plan: string | null } | null {
  try {
    const p = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "auth.json") : join(homedir(), ".codex", "auth.json");
    const j = JSON.parse(readFileSync(p, "utf8")) as { tokens?: { access_token?: string; id_token?: string; account_id?: string } };
    const accessToken = j.tokens?.access_token ?? "";
    const exp = accessTokenExpiry(accessToken);
    if (!accessToken || !exp || exp.getTime() <= Date.now()) return null;
    const id = parseIdToken(j.tokens?.id_token ?? "");
    return {
      token: { accessToken, chatgptAccountId: id.chatgptAccountId ?? j.tokens?.account_id ?? null, isFedramp: id.isFedramp },
      plan: id.planType,
    };
  } catch {
    return null;
  }
}

describe("codex subscription live E2E (requires a valid ~/.codex/auth.json)", () => {
  test("an @openai/agents turn streams through codexSubscriptionFetch to the ChatGPT backend", async () => {
    const auth = loadAuth();
    if (!auth) {
      console.warn("[codex-live] no valid ~/.codex/auth.json — skipping live E2E");
      return;
    }
    setTracingDisabled(true); // don't try to export traces to api.openai.com

    const provider: ResolvedModelProvider = {
      id: CODEX_PROVIDER_ID,
      label: "Codex",
      kind: "codex-subscription",
      api: "responses",
      builtin: false,
      baseUrl: CODEX_PROVIDER_BASE_URL,
      compactionMode: "client",
    };
    const settings = testSettings({ codexSubscriptionEnabled: true });
    const client = buildProviderClient(provider, settings);
    const model = buildModelInstance(provider, client, "codex/gpt-5.5"); // namespaced; fetch strips the prefix
    const agent = new Agent({ name: "CodexLiveCheck", instructions: "You are a helpful assistant.", model });

    const ctx: CodexRequestContext = {
      clientVersion: CODEX_CLIENT_VERSION,
      getToken: async () => auth.token,
      refresh: async () => auth.token,
      resolveModel: buildModelResolver(CODEX_FALLBACK_MODEL_SLUGS, "gpt-5.5"),
    };

    const result = await codexRequestStorage.run(ctx, () => run(agent, "Reply with exactly: codex-e2e-ok", { maxTurns: 1 }));
    const text = String(result.finalOutput ?? "");
    console.log(`[codex-live] non-streaming finalOutput=${JSON.stringify(text)}`);
    expect(text.toLowerCase()).toContain("codex-e2e-ok");

    // Streaming path (what production's runStream uses): raw SSE passthrough to
    // the SDK's own stream parser. This is the path real agent turns take.
    const streamed = await codexRequestStorage.run(ctx, async () => {
      const s = await run(agent, "Reply with exactly: codex-stream-ok", { stream: true, maxTurns: 1 });
      await s.completed;
      return s;
    });
    const streamedText = String(streamed.finalOutput ?? "");
    console.log(`[codex-live] streaming finalOutput=${JSON.stringify(streamedText)}`);
    expect(streamedText.toLowerCase()).toContain("codex-stream-ok");
  }, 120_000);
});
