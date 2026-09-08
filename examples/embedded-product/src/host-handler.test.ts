import { expect, test } from "bun:test";
import { OpenGeniClient } from "@opengeni/sdk";
import { createHostHandler } from "./host-handler";

test("Edit with Geni checks the Site version and creates an ordinary actor-scoped session", async () => {
  const versionId = "137c36e1-f68c-4461-b6f4-dd1c91f199db";
  const calls: { path: string; body: unknown; actor: string | null }[] = [];
  const service = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
      });
      if (path.endsWith("/published-artifacts/site"))
        return Response.json({
          artifact: {
            id: "site",
            title: "My Site",
            status: "active",
            currentVersion: { id: versionId },
          },
        });
      if (path.endsWith("/new-session-draft"))
        return Response.json({ model: "fixture-model", reasoningEffort: "medium" });
      if (path.endsWith("/sessions")) return Response.json({ id: "new-session" });
      throw new Error("Unexpected upstream path");
    },
  });
  const handler = createHostHandler({
    service,
    authenticate: async () => ({
      externalId: "host-user",
      source: "host",
      workspaceId: "safe-workspace",
    }),
    authorizeMutation: async () => true,
    returnUrl: () => "https://host.example",
    siteHref: (_actor, site) => `https://host.example/sites/${site}`,
  });
  const request = (expectedCurrentVersionId: string) =>
    new Request("https://host.example/api/sites/site/edit-session", {
      method: "POST",
      body: JSON.stringify({
        expectedCurrentVersionId,
        idempotencyKey: "6a61f123-f7e5-42fa-a73c-4fd3b31da7a2",
      }),
    });
  expect((await handler(request("6b7b215c-8e0f-45fb-aedc-ad8155ae5333"))).status).toBe(409);
  expect(calls).toHaveLength(1);
  expect((await handler(request(versionId))).status).toBe(200);
  const creation = calls.at(-1)!;
  expect(creation.body).toMatchObject({
    model: "fixture-model",
    firstPartyMcpPermissions: ["artifacts:read", "artifacts:publish"],
    firstPartyMcpTools: ["artifacts_get_source", "artifacts_publish"],
    idempotencyKey: "6a61f123-f7e5-42fa-a73c-4fd3b31da7a2",
  });
  expect(JSON.stringify(creation.body)).toContain("https://host.example/sites/site");
  expect(decodeURIComponent(creation.actor!)).toContain("host-user");
});

test("host derives scope and exact return URL instead of forwarding browser authority", async () => {
  const calls: { url: string; body: unknown; actor: string | null }[] = [];
  const service = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
      });
      return Response.json({});
    },
  });
  const exact = "https://HOST.example:443/finish?x=%2f#unchanged";
  const handler = createHostHandler({
    service,
    authenticate: async () => ({
      externalId: "host-user",
      source: "host",
      workspaceId: "safe-workspace",
    }),
    authorizeMutation: async (request) => request.headers.get("x-csrf") === "ok",
    returnUrl: () => exact,
  });
  const body = {
    providerId: "google-drive",
    ownership: "personal",
    idempotencyKey: "once",
    returnUrl: "https://attacker.invalid",
    workspaceId: "other",
  };
  const denied = await handler(
    new Request("https://host.example/api/connect/attempts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  expect(denied.status).toBe(403);
  expect(calls).toHaveLength(0);
  delete (body as { workspaceId?: string }).workspaceId;
  const result = await handler(
    new Request("https://host.example/api/connect/attempts", {
      method: "POST",
      headers: { "x-csrf": "ok", "x-opengeni-external-actor": "forged" },
      body: JSON.stringify(body),
    }),
  );
  expect(result.status).toBe(200);
  expect(calls[0]!.url).toContain("/safe-workspace/");
  expect(calls[0]!.body).toMatchObject({ returnUrl: exact });
  expect(calls[0]!.actor).not.toBe("forged");
  expect(decodeURIComponent(calls[0]!.actor!)).toContain("host-user");
  const unknown = await handler(
    new Request("https://host.example/api/proxy?url=https://attacker.invalid"),
  );
  expect(unknown.status).toBe(404);
  expect(calls).toHaveLength(1);
});

test("unauthenticated users never reach upstream and upstream diagnostics are redacted", async () => {
  let calls = 0;
  const service = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async () => {
      calls++;
      return Response.json({ message: "synthetic-sensitive-upstream-diagnostic" }, { status: 403 });
    },
  });
  const base = {
    service,
    returnUrl: () => "https://host.example",
    authorizeMutation: async () => true,
  };
  const denied = await createHostHandler({ ...base, authenticate: async () => null })(
    new Request("https://host.example/api/sites"),
  );
  expect(denied.status).toBe(401);
  expect(calls).toBe(0);
  const response = await createHostHandler({
    ...base,
    authenticate: async () => ({ externalId: "actor", source: "host", workspaceId: "space" }),
  })(new Request("https://host.example/api/sites"));
  expect(response.status).toBe(403);
  expect(calls).toBe(1);
  expect(await response.text()).not.toContain("synthetic-sensitive");
});
