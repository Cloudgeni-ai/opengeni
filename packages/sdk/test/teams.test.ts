import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { teamsApi } from "../src/teams";

test("Teams requests preserve exact workspace and carry proofs only in mutation bodies", async () => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://opengeni.example",
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const api = teamsApi(client, "workspace/encoded");
  await api.getBot();
  await api.installBot("setup-proof");
  await api.linkAccount("link-proof");
  await api.unlinkAccount();
  await api.disconnectBot();
  expect(requests.map((r) => [new URL(r.url).pathname, r.method])).toEqual([
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot", "GET"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot", "PUT"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/link", "POST"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/link", "DELETE"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot", "DELETE"],
  ]);
  expect(requests[1]?.body).toEqual({ setupToken: "setup-proof" });
  expect(requests[2]?.body).toEqual({ token: "link-proof" });
  expect(requests.every((r) => !r.url.includes("proof"))).toBe(true);
});
