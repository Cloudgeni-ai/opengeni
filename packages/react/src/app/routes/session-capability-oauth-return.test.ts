import { expect, mock, test } from "bun:test";
import type { ChatClient } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem } from "../types";
import { beginDriveConnect, DRIVE_MCP_URL } from "../lib/drive-connect-return";
import {
  finishDriveConnectReturnInChat,
  finishMcpCapabilityOAuthReturn,
} from "./session-capability-oauth-return";

const service = {
  id: "service",
  kind: "mcp",
  name: "Example service",
  enabled: false,
  connectionRef: null,
  tools: [{ kind: "mcp", id: "service" }],
} as unknown as CapabilityCatalogItem;

function harness(enabledScope: "workspace" | "subject" | null) {
  const calls: string[] = [];
  const continueAfter = mock(
    async (
      ..._args: Parameters<ChatClient<OpenGeniBrowserClient>["continueAfterCapabilitySetup"]>
    ) => {
      calls.push("continueAfterCapabilitySetup");
      return { outcome: "queued" as const, updateId: "update" };
    },
  );
  const client = {
    enableCapability: async () => {
      calls.push("enableCapability");
    },
    listCapabilities: async () => ({
      items: [
        {
          ...service,
          enabled: enabledScope !== null,
          connectionRef: enabledScope
            ? {
                providerDomain: "service.example",
                kind: "oauth2",
                subjectScope: enabledScope,
                connectionId: "account",
              }
            : null,
        },
      ],
    }),
    getSession: async () => ({
      tools: [],
      firstPartyMcpTools: [],
      toolPolicy: { mode: "explicit" },
      toolPolicyVersion: 2,
      effectiveToolPolicy: { effectiveIds: [], mandatoryIds: [], idsTruncated: false },
    }),
    updateSessionToolPolicy: async () => {
      calls.push("updateSessionToolPolicy");
      return {};
    },
    continueAfterCapabilitySetup: continueAfter,
  } as unknown as ChatClient<OpenGeniBrowserClient>;
  return { client, calls, continueAfter };
}

const params = new URLSearchParams({
  connectionId: "account",
  providerDomain: "service.example",
  ownership: "workspace",
});

async function finish(h: ReturnType<typeof harness>, query = params) {
  const result = await finishMcpCapabilityOAuthReturn({
    client: h.client,
    workspaceId: "w",
    sessionId: "s",
    capabilityId: "service",
    params: query,
    catalog: [service],
    refreshCatalog: async () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return result;
}

test("an OAuth redirect back into the chat continues the agent after its tools are attached", async () => {
  const h = harness("workspace");
  expect(await finish(h)).toEqual({ name: "Example service", needsPersonalReview: false });
  expect(h.calls).toEqual([
    "enableCapability",
    "updateSessionToolPolicy",
    "continueAfterCapabilitySetup",
  ]);
  expect(h.continueAfter.mock.calls).toEqual([["w", "s", { capabilityId: "service" }]]);
});

test("a personal account waits for its card review before the agent continues", async () => {
  const h = harness("subject");
  expect(await finish(h)).toEqual({ name: "Example service", needsPersonalReview: true });
  expect(h.continueAfter).not.toHaveBeenCalled();
});

test("an unverified OAuth return never continues the agent", async () => {
  const h = harness(null);
  await expect(finish(h)).rejects.toThrow("could not be verified");
  await expect(finish(harness("workspace"), new URLSearchParams())).rejects.toThrow(
    "could not be resolved",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.continueAfter).not.toHaveBeenCalled();
});

test("a Google Drive connect started in a chat finishes there with the exact Connect account", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const drive = {
    ...service,
    id: "drive",
    name: "Google Drive",
    mcpUrl: DRIVE_MCP_URL,
  } as unknown as CapabilityCatalogItem;
  const calls: unknown[] = [];
  let enabled = false;
  let enabledRef: unknown = null;
  let mcpUrl = "https://elsewhere.example/mcp";
  const client = {
    beginConnect: async () => ({ id: "attempt", revision: 1, state: "credential_input" }),
    connectTransport: () => ({
      advance: async () => ({
        id: "attempt",
        nextAction: { type: "authorize", url: "https://connect.example/" },
      }),
      get: async () => ({
        id: "attempt",
        providerId: "google-drive",
        ownership: "personal",
        state: "complete",
        credentialsCommitted: true,
        account: { id: "drive-account", providerId: "google-drive", ownership: "personal" },
      }),
    }),
    listCapabilities: async () => ({
      items: [
        {
          ...drive,
          mcpUrl,
          enabled,
          connectionRef: enabledRef,
        },
      ],
    }),
    enableCapability: async (...args: unknown[]) => {
      calls.push(["enableCapability", ...args]);
      enabled = true;
      enabledRef = (args[2] as { connectionRef: unknown }).connectionRef;
    },
    getSession: async () => ({
      tools: [],
      firstPartyMcpTools: [],
      toolPolicy: { mode: "explicit" },
      toolPolicyVersion: 2,
      effectiveToolPolicy: { effectiveIds: [], mandatoryIds: [], idsTruncated: false },
    }),
    updateSessionToolPolicy: async () => {
      calls.push("updateSessionToolPolicy");
      return {};
    },
    continueAfterCapabilitySetup: async (...args: unknown[]) => {
      calls.push(["continueAfterCapabilitySetup", ...args]);
      return { outcome: "queued", updateId: "update" };
    },
  } as unknown as ChatClient<OpenGeniBrowserClient>;
  await beginDriveConnect({
    client,
    workspaceId: "w",
    itemId: "drive",
    returnUrl: "https://app.test/workspaces/w/sessions/s?capability_auth=drive",
    storage,
  });
  const nonce = JSON.parse([...values.values()][0]!).nonce as string;

  // An entry that no longer points at Drive is never enabled.
  await expect(
    finishDriveConnectReturnInChat({
      client,
      workspaceId: "w",
      sessionId: "s",
      nonce,
      storage,
      refreshCatalog: async () => {},
    }),
  ).rejects.toThrow("connector changed");
  expect(calls).toEqual([]);
  mcpUrl = DRIVE_MCP_URL;

  // Another attempt's nonce never finishes this one.
  await expect(
    finishDriveConnectReturnInChat({
      client,
      workspaceId: "w",
      sessionId: "s",
      nonce: "other",
      storage,
      refreshCatalog: async () => {},
    }),
  ).rejects.toThrow("could not be matched");
  expect(calls).toEqual([]);

  expect(
    await finishDriveConnectReturnInChat({
      client,
      workspaceId: "w",
      sessionId: "s",
      nonce,
      storage,
      refreshCatalog: async () => {},
    }),
  ).toEqual({ name: "Google Drive", needsPersonalReview: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Drive is personal: it is turned on for the person, and the chat's card
  // asks them to allow it here before the agent continues.
  expect(calls).toEqual([
    [
      "enableCapability",
      "w",
      "drive",
      {
        connectionRef: {
          kind: "oauth2",
          providerDomain: "drivemcp.googleapis.com",
          subjectScope: "subject",
          accountSelection: "all_eligible",
        },
      },
    ],
  ]);
  // The saved return is consumed.
  expect(values.size).toBe(0);
});
