import { describe, expect, test } from "bun:test";
import { CODEX_CLIENT_VERSION, fetchCodexModels } from "../src";

const auth = {
  accessToken: "server-only-token",
  chatgptAccountId: "acct_123",
  isFedramp: false,
  clientVersion: "0.153.0",
};

describe("Codex API client", () => {
  test("uses the latest verified official Codex client version", () => {
    expect(CODEX_CLIENT_VERSION).toBe("0.153.0");
  });

  test("returns only picker-visible models from the live catalog", async () => {
    expect(
      await fetchCodexModels(auth, async () =>
        Response.json({
          models: [
            { slug: "gpt-current", visibility: "list" },
            { slug: "gpt-future-hidden", visibility: "hide" },
            { slug: "gpt-internal", visibility: "none" },
            { slug: "gpt-missing-visibility" },
          ],
        }),
      ),
    ).toEqual({ ok: true, status: 200, slugs: ["gpt-current"] });
  });
});
