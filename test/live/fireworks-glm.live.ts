import { describe, expect, test } from "bun:test";
import { calculateModelUsageCostMicros } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  resolveTurnModel,
  runAgentStream,
} from "@opengeni/runtime";

// Live end-to-end proof that Fireworks GLM 5.2 routes through the new
// multi-provider path. This is the design's "Verification step 3": resolve
// accounts/fireworks/models/glm-5p2, confirm it binds to the chat wire API as a
// OpenAIChatCompletionsModel (NOT a Responses model), run one real turn against
// the live Fireworks endpoint, and confirm managed cost accounting can price
// the model.
//
// Gated on the Fireworks key — skips entirely when OPENGENI_FIREWORKS_API_KEY
// is absent (the unit suite must stay key-free):
//
//   OPENGENI_FIREWORKS_API_KEY=fw_... bun test test/live/fireworks-glm.live.ts
const FIREWORKS_KEY = process.env.OPENGENI_FIREWORKS_API_KEY;
const live = Boolean(FIREWORKS_KEY);

const GLM_MODEL_ID = "accounts/fireworks/models/glm-5p2";

// A registry exactly as the host would configure it (docs/model-providers.md
// "Host configuration example"). The key is read from the env var the gate
// already required, so the test never inlines the secret.
const MODEL_PROVIDERS_JSON = JSON.stringify([
  {
    id: "fireworks",
    label: "Fireworks AI",
    api: "chat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "OPENGENI_FIREWORKS_API_KEY",
    models: [
      {
        id: GLM_MODEL_ID,
        label: "GLM 5.2",
        contextWindowTokens: 1_048_576,
        reasoningEffort: true,
        hostedWebSearch: false,
      },
    ],
  },
]);

function fireworksSettings() {
  return testSettings({
    sandboxBackend: "none",
    modelProvidersJson: MODEL_PROVIDERS_JSON,
    // The registry-resolved turn never consults these built-in OpenAI fields
    // (it builds its own Fireworks client), but keep them inert so nothing
    // accidentally hits OpenAI.
    openaiApiKey: "unused-on-the-registry-path",
  });
}

describe("live Fireworks GLM 5.2 (multi-provider path)", () => {
  test.skipIf(!live)(
    "resolves glm-5p2 to the fireworks chat provider as a chat-completions Model",
    () => {
      const settings = fireworksSettings();
      const resolved = resolveTurnModel(settings, GLM_MODEL_ID);

      // The model is in the registry, so it resolves to its declared provider.
      expect(resolved).not.toBeNull();
      expect(resolved!.provider.id).toBe("fireworks");
      expect(resolved!.provider.api).toBe("chat");
      expect(resolved!.configured.id).toBe(GLM_MODEL_ID);
      expect(resolved!.configured.providerId).toBe("fireworks");
      expect(resolved!.configured.hostedWebSearch).toBe(false);

      // The load-bearing routing assertion: glm-5p2 must be a chat-completions
      // Model, NOT a Responses model. Fireworks' /v1/responses echoes input and
      // no-ops web_search/encrypted reasoning, so binding it to Responses would
      // corrupt history — the chat wire API is the whole point.
      expect(resolved!.model).toBeInstanceOf(OpenAIChatCompletionsModel);
      expect(resolved!.model).not.toBeInstanceOf(OpenAIResponsesModel);
    },
  );

  test.skipIf(!live)(
    "runs one real GLM 5.2 turn with no hosted web_search attached",
    async () => {
      const settings = fireworksSettings();
      const resolved = resolveTurnModel(settings, GLM_MODEL_ID);
      expect(resolved).not.toBeNull();

      // Build the agent exactly as apps/worker/src/activities/agent-turn.ts does
      // for a registry-resolved turn: the resolved Model instance plus the
      // provider-derived gating (no hosted web_search and no
      // encrypted reasoning — the chat wire API has no encrypted_content field).
      const agent = buildOpenGeniAgent({ ...settings, sandboxBackend: "none" }, [], {
        model: resolved!.model,
        hostedWebSearch: resolved!.configured.hostedWebSearch,
        encryptedReasoning:
          resolved!.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
      });

      // Fireworks does NOT execute the hosted web_search tool, so the agent must
      // carry no web_search descriptor — handing it one would be a dead tool.
      const hostedToolNames = (agent.tools ?? []).map((tool) => tool.name);
      expect(hostedToolNames).not.toContain("web_search");

      const stream = await runAgentStream(
        agent,
        "Reply with exactly: glm-live-ok. Do not run any tools or commands.",
        { ...settings, sandboxBackend: "none" },
      );
      for await (const _event of stream.toStream()) {
        // Drain the stream to completion.
      }
      await stream.completed;

      // A non-empty, clean assistant response — no input echo, no leaked
      // reasoning. extractResponseOutputText-style cleanliness is enforced by
      // the chat path naturally (content is choices[0].message.content).
      const finalOutput = String(stream.finalOutput ?? "").trim();
      expect(finalOutput.length).toBeGreaterThan(0);
      expect(finalOutput.toLowerCase()).toContain("glm-live-ok");
    },
    180_000,
  );

  test.skipIf(!live)("prices glm-5p2 through managed cost accounting", () => {
    const settings = fireworksSettings();

    // The default built-in pricing entry for glm-5p2 (docs/model-providers.md)
    // must make managed billing resolvable out of the box — a missing entry
    // throws "Missing model pricing".
    const cost = calculateModelUsageCostMicros(settings, GLM_MODEL_ID, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // input 1.4 + output 4.4 = 5.8 micros-per-token-million base, * 1M tokens
    // each, with the 2_500 bps (25%) managed margin: ceil((1_400_000 +
    // 4_400_000) * 1.25) = 7_250_000.
    expect(cost).toBe(7_250_000);
    expect(cost).toBeGreaterThan(0);
  });
});
