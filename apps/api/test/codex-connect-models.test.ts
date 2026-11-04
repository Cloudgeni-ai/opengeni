import { describe, expect, test } from "bun:test";
import type { CodexFetch } from "@opengeni/codex";
import { testSettings } from "@opengeni/testing/settings";
import { codexConnectOfferedModels } from "../src/routes/codex-connect-models";

const settings = testSettings({ codexSubscriptionEnabled: true });

function modelsFetch(status: number, body: unknown, seen: string[] = []): CodexFetch {
  return (async (input: string | URL | Request) => {
    seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as CodexFetch;
}

const tokens = { accessToken: "access", chatgptAccountId: "account", isFedramp: false };

describe("the models a just-connected Codex account offers", () => {
  test("a Free plan's list offers GPT-6 Luna only", async () => {
    const seen: string[] = [];
    const offered = await codexConnectOfferedModels({
      settings,
      ...tokens,
      // As the backend lists it for a Free sign-in: Luna, flagged as not for
      // API keys, which a ChatGPT sign-in still uses (as the Codex CLI does).
      fetchImpl: modelsFetch(
        200,
        { models: [{ slug: "gpt-6-luna", supported_in_api: false, visibility: "list" }] },
        seen,
      ),
    });
    expect(offered).toEqual([{ id: "codex/gpt-6-luna", label: "GPT-6 Luna" }]);
    // The backend applies minimal_client_version from the client version sent.
    expect(seen[0]).toContain("/models?client_version=");
  });

  test("an account that offers none of Opengeni's models gets an empty list", async () => {
    expect(
      await codexConnectOfferedModels({
        settings,
        ...tokens,
        fetchImpl: modelsFetch(200, { models: [{ slug: "some-other-model" }] }),
      }),
    ).toEqual([]);
  });

  test("a failed read says nothing rather than guessing", async () => {
    expect(
      await codexConnectOfferedModels({
        settings,
        ...tokens,
        fetchImpl: modelsFetch(500, {}),
      }),
    ).toBeNull();
    expect(
      await codexConnectOfferedModels({
        settings,
        ...tokens,
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as CodexFetch,
      }),
    ).toBeNull();
  });
});
