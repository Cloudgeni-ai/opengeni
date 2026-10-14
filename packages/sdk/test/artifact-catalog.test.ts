import { expect, test } from "bun:test";
import {
  OpenGeniClient,
  type ArtifactCatalogItem,
  type ArtifactCatalogListOptions,
  type ArtifactCatalogListResponse,
  type ArtifactPinResponse,
} from "../src";
import type {
  ArtifactCatalogItem as ContractItem,
  ArtifactCatalogListResponse as ContractResponse,
  ArtifactPinResponse as ContractPinResponse,
} from "@opengeni/contracts";

test("catalog SDK types agree with the shared contract", () => {
  const sdk: ArtifactCatalogListResponse = { items: [], nextCursor: null };
  const roundtrip: ContractResponse = sdk;
  const item = null as ArtifactCatalogItem | null;
  const other: ContractItem | null = item;
  expect(roundtrip).toEqual({ items: [], nextCursor: null });
  expect(other).toBeNull();
});

test("pin client sends a kind-qualified idempotent mutation and preserves actor and cancellation", async () => {
  const calls: Array<{
    url: URL;
    actor: string | null;
    method: string | undefined;
    body: unknown;
  }> = [];
  const expected: ArtifactPinResponse = {
    kind: "document",
    artifactId: "artifact/one",
    pinned: false,
  };
  const contract: ContractPinResponse = expected;
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      calls.push({
        url: new URL(String(url)),
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(expected);
    },
  }).asUser("viewer");
  expect(await client.updateArtifactPin("space/one", "document", "artifact/one", false)).toEqual(
    contract,
  );
  expect(calls[0]!.url.pathname).toBe(
    "/v1/workspaces/space%2Fone/artifact-catalog/document/artifact%2Fone/pin",
  );
  expect(calls[0]!.method).toBe("PUT");
  expect(calls[0]!.body).toEqual({ pinned: false });
  expect(calls[0]!.actor).not.toBeNull();
  const abort = new AbortController();
  abort.abort();
  await expect(
    client.updateArtifactPin("space", "site", "native", true, { signal: abort.signal }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
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
