import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/index";

function actorOf(client: OpenGeniClient): Promise<unknown> {
  return new Promise((resolve) => {
    const scoped = client as unknown as {
      requestJson(method: string, path: string): Promise<unknown>;
    };
    void scoped.requestJson("GET", "/v1/access/me").then(resolve);
  });
}

function service(seen: (string | null)[]) {
  return new OpenGeniClient({
    baseUrl: "https://api.example",
    apiKey: "fixture-key",
    fetch: async (_url, init) => {
      seen.push(new Headers(init?.headers).get("x-opengeni-external-actor"));
      return Response.json({});
    },
  });
}

test("asUser without display details sends exactly today's actor header", async () => {
  const seen: (string | null)[] = [];
  await actorOf(service(seen).asUser("auth0|66b45b"));
  await actorOf(service(seen).asUser("auth0|66b45b", { source: "kontali" }));
  // Recorded from main before display details existed.
  expect(seen).toEqual([
    "%7B%22mode%22%3A%22external%22%2C%22identity%22%3A%7B%22externalId%22%3A%22auth0%7C66b45b%22%2C%22source%22%3A%22default%22%7D%7D",
    "%7B%22mode%22%3A%22external%22%2C%22identity%22%3A%7B%22externalId%22%3A%22auth0%7C66b45b%22%2C%22source%22%3A%22kontali%22%7D%7D",
  ]);
});

test("asUser sends display details with the identity; blank ones are left out", async () => {
  const seen: (string | null)[] = [];
  await actorOf(
    service(seen).asUser("u-1", {
      displayName: " Ada Lovelace ",
      email: "ada@example.com",
      membership: { permissions: ["sessions:read"] },
    }),
  );
  await actorOf(service(seen).asUser("u-1", { displayName: "  ", email: "ada@example.com" }));
  await actorOf(
    service(seen).asLinkedUser("u-1", {
      linkId: "6f1c2d4e-7a3b-4c5d-8e9f-0a1b2c3d4e5f",
      expectedLinkRevision: 2,
      displayName: "Ada",
    }),
  );
  expect(seen.map((header) => JSON.parse(decodeURIComponent(header!)))).toEqual([
    {
      mode: "external",
      identity: {
        externalId: "u-1",
        source: "default",
        displayName: "Ada Lovelace",
        email: "ada@example.com",
      },
      membership: { permissions: ["sessions:read"] },
    },
    {
      mode: "external",
      identity: { externalId: "u-1", source: "default", email: "ada@example.com" },
    },
    {
      mode: "linked_native",
      identity: { externalId: "u-1", source: "default", displayName: "Ada" },
      linkId: "6f1c2d4e-7a3b-4c5d-8e9f-0a1b2c3d4e5f",
      expectedLinkRevision: 2,
    },
  ]);
});

test("the session proxy forwards the host's display details as the user's", async () => {
  const { createSessionProxyHandler } = await import("../src/index");
  const { WORKSPACE_ID } = await import("./helpers");
  const actors: unknown[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_org_key",
    fetch: async (input, init) => {
      const header = new Request(input, init).headers.get("x-opengeni-external-actor");
      actors.push(header ? JSON.parse(decodeURIComponent(header)) : null);
      return Response.json({ id: "33333333-3333-4333-8333-333333333333" }, { status: 201 });
    },
  });
  const run = async (resolution: Record<string, unknown>) => {
    const handler = createSessionProxyHandler(client, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42", ...resolution }),
    });
    await handler(
      new Request(
        `https://product.example.test/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ initialMessage: "Hi", idempotencyKey: crypto.randomUUID() }),
        },
      ),
    );
  };
  await run({});
  await run({ displayName: "Ada Lovelace", email: "ada@example.com" });
  expect(actors).toEqual([
    { mode: "external", identity: { externalId: "u_42", source: "default" } },
    {
      mode: "external",
      identity: {
        externalId: "u_42",
        source: "default",
        displayName: "Ada Lovelace",
        email: "ada@example.com",
      },
    },
  ]);
});
