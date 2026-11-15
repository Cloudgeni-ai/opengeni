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
  await api.startMicrosoftSignIn("setup-proof");
  await api.installBot("setup-proof", { code: "microsoft-code", state: "signed-state" });
  await api.linkAccount("link-proof");
  await api.unlinkAccount();
  await api.disconnectBot();
  await api.installBot(
    "setup-proof",
    { code: "microsoft-code", state: "signed-state" },
    { replaceOwnLink: true },
  );
  await api.startLinkSignIn("link-proof");
  await api.linkAccount("link-proof", { code: "microsoft-code", state: "signed-state" });
  expect(requests.map((r) => [new URL(r.url).pathname, r.method])).toEqual([
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot", "GET"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot", "PUT"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot/microsoft-sign-in", "POST"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot", "PUT"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/link", "POST"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/link", "DELETE"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot", "DELETE"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/bot", "PUT"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/link/microsoft-sign-in", "POST"],
    ["/v1/workspaces/workspace%2Fencoded/integrations/teams/link", "POST"],
  ]);
  expect(requests[1]?.body).toEqual({ setupToken: "setup-proof" });
  expect(requests[2]?.body).toEqual({ setupToken: "setup-proof" });
  expect(requests[3]?.body).toEqual({
    setupToken: "setup-proof",
    microsoft: { code: "microsoft-code", state: "signed-state" },
  });
  expect(requests[4]?.body).toEqual({ token: "link-proof" });
  expect(requests[7]?.body).toEqual({
    setupToken: "setup-proof",
    microsoft: { code: "microsoft-code", state: "signed-state" },
    replaceOwnLink: true,
  });
  expect(requests[8]?.body).toEqual({ token: "link-proof" });
  expect(requests[9]?.body).toEqual({
    token: "link-proof",
    microsoft: { code: "microsoft-code", state: "signed-state" },
  });
  expect(requests.every((r) => !r.url.includes("proof"))).toBe(true);
});
