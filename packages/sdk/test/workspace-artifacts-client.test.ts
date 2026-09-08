import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/artifact-client";

test("Site display fetches version-pinned HTML without downloading retained source", async () => {
  let called: URL | undefined;
  let actor: string | null = null;
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      called = new URL(String(url));
      actor = new Headers(init?.headers).get("x-opengeni-external-actor");
      return new Response("<p>Site</p>");
    },
  }).asUser("viewer");
  expect(
    await client.getWorkspaceArtifactHtml("space/one", "site/one", { versionId: "version/one" }),
  ).toBe("<p>Site</p>");
  expect(called!.pathname).toBe("/v1/workspaces/space%2Fone/published-artifacts/site%2Fone/html");
  expect(called!.searchParams.get("versionId")).toBe("version/one");
  expect(actor).not.toBeNull();
});

test("Site lifecycle uses published artifact routes and preserves actor, version, and idempotency", async () => {
  const calls: { url: URL; method: string | undefined; body: unknown; actor: string | null }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      calls.push({
        url: new URL(String(url)),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
      });
      return Response.json({});
    },
  }).asUser("site-owner");
  await client.listWorkspaceArtifacts("space/one", {
    status: "archived",
    cursor: "opaque+/%",
    limit: 12,
  });
  await client.getWorkspaceArtifact("space/one", "site/one");
  await client.getWorkspaceArtifactContent("space/one", "site/one", { versionId: "version/one" });
  const created = {
    title: "Site",
    html: "<!doctype html><p>Site</p>",
    idempotencyKey: "create-once",
  };
  await client.createWorkspaceArtifact("space/one", created);
  const published = {
    html: created.html,
    expectedCurrentVersionId: "current",
    idempotencyKey: "publish-once",
  };
  await client.publishWorkspaceArtifactVersion("space/one", "site/one", published);
  const rollback = {
    versionId: "old",
    expectedCurrentVersionId: "current",
    reason: "Restore reviewed version",
    idempotencyKey: "rollback-once",
  };
  await client.rollbackWorkspaceArtifact("space/one", "site/one", rollback);
  const status = {
    status: "archived" as const,
    expectedCurrentVersionId: "current",
    reason: "Archive",
    idempotencyKey: "archive-once",
  };
  await client.setWorkspaceArtifactStatus("space/one", "site/one", status);
  const root = "/v1/workspaces/space%2Fone/published-artifacts";
  expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
    ["GET", root],
    ["GET", `${root}/site%2Fone`],
    ["GET", `${root}/site%2Fone/content`],
    ["POST", root],
    ["POST", `${root}/site%2Fone/versions`],
    ["POST", `${root}/site%2Fone/rollback`],
    ["PATCH", `${root}/site%2Fone/status`],
  ]);
  expect(calls[0]!.url.searchParams.get("cursor")).toBe("opaque+/%");
  expect(calls[2]!.url.searchParams.get("versionId")).toBe("version/one");
  expect(calls.slice(3).map((call) => call.body)).toEqual([created, published, rollback, status]);
  expect(calls.every((call) => call.actor === calls[0]!.actor && call.actor !== null)).toBe(true);
  const abort = new AbortController();
  abort.abort();
  await expect(
    client.setWorkspaceArtifactStatus("space/one", "site/one", status, { signal: abort.signal }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(7);
});
