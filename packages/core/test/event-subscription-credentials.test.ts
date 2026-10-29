import { afterEach, expect, spyOn, test } from "bun:test";
import { OPENGENI_SIGNATURE_HEADER, OPENGENI_TEST_REQUEST_NIL_ID } from "@opengeni/contracts";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import {
  eventSubscriptionCredentialHeaders,
  type EventSubscriptionCredentialDeps,
} from "../src/domain/event-triggers/event-subscription-credentials";
import { EventSourceBlockedError } from "../src/domain/event-triggers/status-reason";

// A workspace MCP event source that listens by URL is signed in by the
// workspace credential provider with a request that is not a run.

const settings = testSettings({
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function provider(enabled = true) {
  const resolve = spyOn(db, "resolveWorkspaceCredentialProvider").mockResolvedValue({
    enabled,
    url: "https://provider.example/credentials",
    secretEncrypted: "sealed",
    timeoutMs: 5_000,
    workspaceId: "22222222-2222-4222-8222-222222222222",
  } as never);
  const decrypt = spyOn(db, "decryptEnvironmentValue").mockReturnValue("provider-secret");
  restores.push(
    () => resolve.mockRestore(),
    () => decrypt.mockRestore(),
  );
}

function target() {
  return {
    sourceId: crypto.randomUUID(),
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    serverId: "product",
    serverUrl: "https://product.example/mcp",
  };
}

function deps(answer: unknown, requests: Array<{ body: unknown; headers: Headers }>) {
  const providerFetch = (async (_url: string | URL, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json(answer);
  }) as unknown as NonNullable<EventSubscriptionCredentialDeps["providerFetch"]>;
  return { db: {} as db.Database, settings, providerFetch };
}

test("asks with an event_subscription request and keeps the headers until they expire", async () => {
  provider();
  const requests: Array<{ body: unknown; headers: Headers }> = [];
  const answer = {
    status: "ok",
    mcp: [
      {
        url: "https://product.example/mcp",
        headers: { Authorization: "Bearer listening" },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  };
  const source = target();
  const first = await eventSubscriptionCredentialHeaders(deps(answer, requests), source, false);
  expect(first).toEqual({ Authorization: "Bearer listening" });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get(OPENGENI_SIGNATURE_HEADER)).toBeTruthy();
  expect(requests[0]!.body).toMatchObject({
    type: "credentials.request",
    purpose: "event_subscription",
    forceRefresh: false,
    sessionId: OPENGENI_TEST_REQUEST_NIL_ID,
    turnId: OPENGENI_TEST_REQUEST_NIL_ID,
    initiator: { kind: "service", subjectId: "event_subscription" },
    mcpServers: [{ id: "product", url: "https://product.example/mcp" }],
    eventSubscription: { sourceId: source.sourceId, serverUrl: "https://product.example/mcp" },
  });

  await eventSubscriptionCredentialHeaders(deps(answer, requests), source, false);
  expect(requests).toHaveLength(1);
  await eventSubscriptionCredentialHeaders(deps(answer, requests), source, true);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.body).toMatchObject({ forceRefresh: true });
});

test("blocks the source when the provider signs nothing in or is off", async () => {
  provider();
  const requests: Array<{ body: unknown; headers: Headers }> = [];
  const refused = eventSubscriptionCredentialHeaders(
    deps({ status: "not_applicable" }, requests),
    target(),
    false,
  );
  await expect(refused).rejects.toBeInstanceOf(EventSourceBlockedError);
  await expect(refused).rejects.toMatchObject({ reason: { code: "reconnect" } });

  restores.pop()!();
  restores.pop()!();
  provider(false);
  await expect(
    eventSubscriptionCredentialHeaders(deps({ status: "ok" }, requests), target(), false),
  ).rejects.toMatchObject({ reason: { code: "reconnect" } });
  expect(requests).toHaveLength(1);
});
