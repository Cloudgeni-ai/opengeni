/**
 * Incident 2 (26 October 2026): a worker resolved a reference in a
 * session_create argument and the child stored the real value. The worker's
 * call names the values its arguments resolved to in `_meta`; the first-party
 * server then masks everything that call stores and returns
 * (docs/secrets.md, Masking).
 */
import { expect, test } from "bun:test";
import {
  FIRST_PARTY_SECRET_VALUES_META_KEY,
  type AccessGrant,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import { maskSecretValuesForStorage } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

// References are assembled so no tool on the way resolves them.
const TOKEN_REF = "\u007B\u007Bsecret:fake-vault/FAKE_GITHUB_TOKEN/value}}";
const FAKE_TOKEN = "ghp_fakeFAKEfake0000000000000000000000";

function grant(
  tools: FirstPartyMcpToolName[],
  principalKind: AccessGrant["principalKind"] = "agent_attempt",
): AccessGrant {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "worker:first-party-mcp",
    permissions: ["sessions:create"],
    principalKind,
    metadata: {
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      firstPartyMcpTools: tools,
    },
  };
}

/** Calls session_create; storage records what a write would store, then fails. */
async function createChild(
  meta: Record<string, unknown> | undefined,
  principalKind: AccessGrant["principalKind"] = "agent_attempt",
) {
  const stored: string[] = [];
  const deps = {
    settings: testSettings({ sandboxSelfhostedEnabled: true }),
    db: new Proxy(
      {},
      {
        get() {
          stored.push(maskSecretValuesForStorage(`initial message GH_TOKEN=${FAKE_TOKEN}`));
          throw new Error(`storage unavailable for GH_TOKEN=${FAKE_TOKEN}`);
        },
      },
    ),
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as unknown as ApiRouteDeps;
  const server = buildOpenGeniMcpServer(deps, grant(["session_create"], principalKind));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "first-party-secret-mask-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "session_create",
      arguments: { initialMessage: `Push with GH_TOKEN=${FAKE_TOKEN} and report back.` },
      ...(meta ? { _meta: meta } : {}),
    });
    return { stored, result: JSON.stringify(result) };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

test("a session_create call whose arguments resolved a value stores and returns the reference", async () => {
  const { stored, result } = await createChild({
    [FIRST_PARTY_SECRET_VALUES_META_KEY]: [{ value: FAKE_TOKEN, label: TOKEN_REF }],
  });
  expect(stored.length).toBeGreaterThan(0);
  for (const text of stored) {
    expect(text).toBe(`initial message GH_TOKEN=${TOKEN_REF}`);
  }
  expect(result).not.toContain(FAKE_TOKEN);
});

test("a call without resolved values is stored exactly as written", async () => {
  const { stored } = await createChild(undefined);
  expect(stored.length).toBeGreaterThan(0);
  for (const text of stored) {
    expect(text).toBe(`initial message GH_TOKEN=${FAKE_TOKEN}`);
  }
});

test("an error that quotes a resolved value carries the reference", async () => {
  const { result } = await createChild({
    [FIRST_PARTY_SECRET_VALUES_META_KEY]: [{ value: FAKE_TOKEN, label: TOKEN_REF }],
  });
  expect(result).not.toContain(FAKE_TOKEN);
});

test("resolved values in _meta are honoured only from an agent attempt", async () => {
  const { stored } = await createChild(
    { [FIRST_PARTY_SECRET_VALUES_META_KEY]: [{ value: FAKE_TOKEN, label: TOKEN_REF }] },
    "api_key",
  );
  expect(stored.length).toBeGreaterThan(0);
  for (const text of stored) {
    expect(text).toBe(`initial message GH_TOKEN=${FAKE_TOKEN}`);
  }
});
