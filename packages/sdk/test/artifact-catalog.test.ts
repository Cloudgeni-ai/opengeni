import { expect, test } from "bun:test";
import {
  OpenGeniClient,
  type ArtifactCatalogItem,
  type ArtifactCatalogListOptions,
  type ArtifactCatalogListResponse,
} from "../src";
import type {
  ArtifactCatalogItem as ContractItem,
  ArtifactCatalogListResponse as ContractResponse,
} from "@opengeni/contracts";

test("catalog SDK types agree with the shared contract", () => {
  const sdk: ArtifactCatalogListResponse = { items: [], nextCursor: null };
  const roundtrip: ContractResponse = sdk;
  const item = null as ArtifactCatalogItem | null;
  const other: ContractItem | null = item;
  expect(roundtrip).toEqual({ items: [], nextCursor: null });
  expect(other).toBeNull();
});

test("catalog client encodes every filter and carries external actor and cancellation", async () => {
  const calls: Array<{ url: URL; actor: string | null; method: string | undefined }> = [];
  const expected = { items: [], nextCursor: "encrypted" };
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      calls.push({
        url: new URL(String(url)),
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
        method: init?.method,
      });
      return Response.json(expected);
    },
  }).asUser("viewer");
  const options: ArtifactCatalogListOptions = {
    sourceSessionId: "session/one",
    q: "Budget & forecast",
    kind: "document",
    sort: "title",
    status: "archived",
    limit: 13,
    cursor: "opaque+/=%",
  };
  expect(await client.listArtifactCatalog("space/one", options)).toEqual(expected);
  expect(calls[0]!.url.pathname).toBe("/v1/workspaces/space%2Fone/artifact-catalog");
  expect(calls[0]!.method).toBe("GET");
  expect(calls[0]!.actor).not.toBeNull();
  for (const [key, value] of Object.entries(options))
    expect(calls[0]!.url.searchParams.get(key)).toBe(String(value));
  const abort = new AbortController();
  abort.abort();
  await expect(client.listArtifactCatalog("space", { signal: abort.signal })).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
