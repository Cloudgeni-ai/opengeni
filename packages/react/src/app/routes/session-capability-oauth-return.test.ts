import { expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem } from "../types";
import { finishMcpCapabilityOAuthReturn } from "./session-capability-oauth-return";

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
    async (..._args: Parameters<OpenGeniBrowserClient["continueAfterCapabilitySetup"]>) => {
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
  } as unknown as OpenGeniBrowserClient;
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
