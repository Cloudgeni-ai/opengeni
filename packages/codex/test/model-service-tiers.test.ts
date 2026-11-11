import { expect, test } from "bun:test";
import { CODEX_CLIENT_VERSION } from "../src/constants";
import { fetchCodexModels } from "../src/api-client";

const auth = {
  accessToken: "synthetic",
  chatgptAccountId: "synthetic-account",
  isFedramp: false,
  clientVersion: CODEX_CLIENT_VERSION,
};

test("an account's advertised service tiers are recorded next to its model slugs", async () => {
  const result = await fetchCodexModels(auth, async () =>
    Response.json({
      models: [
        {
          slug: "gpt-6.1-sol",
          service_tiers: [
            { id: "priority", name: "Fast" },
            { id: "ultrafast", name: "Ultrafast" },
          ],
        },
        { slug: "gpt-6-luna", service_tiers: [{ id: "priority" }] },
        { slug: "gpt-6-astra" },
      ],
    }),
  );
  expect(result).toEqual({
    ok: true,
    status: 200,
    slugs: [
      "gpt-6.1-sol",
      "gpt-6.1-sol@priority",
      "gpt-6.1-sol@ultrafast",
      "gpt-6-luna",
      "gpt-6-luna@priority",
      "gpt-6-astra",
    ],
  });
});

test("malformed slugs and tiers are ignored", async () => {
  const result = await fetchCodexModels(auth, async () =>
    Response.json({
      models: [
        { slug: "spoof@ultrafast" },
        { slug: 7, service_tiers: [{ id: "ultrafast" }] },
        {
          slug: "gpt-6.1-sol",
          service_tiers: [{ id: "Ultra Fast" }, { id: 3 }, null, "ultrafast"],
        },
        { slug: "gpt-6-astra", service_tiers: "ultrafast" },
      ],
    }),
  );
  expect(result.slugs).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
});
