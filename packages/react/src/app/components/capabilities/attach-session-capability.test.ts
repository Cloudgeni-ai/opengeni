import { t } from "../../lib/console-text";
import { expect, mock, test } from "bun:test";
import { CapabilityCatalogItem as CapabilityCatalogItemSchema } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem } from "../../types";
import {
  attachSessionCapability,
  completeSessionCapabilityOAuth,
  continueAfterCapabilitySetup,
} from "./attach-session-capability";
const item = { kind: "mcp", tools: [{ kind: "mcp", id: "new" }] } as CapabilityCatalogItem;
function harness(mode = "explicit", selectedIds = ["old"], idsTruncated = false) {
  const updateSessionToolPolicy = mock(
    async (..._args: Parameters<OpenGeniBrowserClient["updateSessionToolPolicy"]>) => ({}),
  );
  const continueAfter = mock(
    async (..._args: Parameters<OpenGeniBrowserClient["continueAfterCapabilitySetup"]>) => ({
      outcome: "queued" as const,
      updateId: "update",
    }),
  );
  const client = {
    continueAfterCapabilitySetup: continueAfter,
    getSession: async () => ({
      tools: [{ kind: "mcp", id: "old" }],
      firstPartyMcpTools: ["session_pause"],
      toolPolicyVersion: 7,
      toolPolicy: { mode },
      effectiveToolPolicy: {
        selectedIds: mode === "workspace_default" ? [] : selectedIds,
        effectiveIds: [...selectedIds, "opengeni"],
        mandatoryIds: ["opengeni"],
        idsTruncated,
      },
    }),
    updateSessionToolPolicy,
  } as unknown as OpenGeniBrowserClient;
  return { client, updateSessionToolPolicy, continueAfter };
}
test("adding a connection preserves tools and first-party restrictions with CAS", async () => {
  const h = harness();
  await attachSessionCapability(t, h.client, "w", "s", item);
  expect(h.updateSessionToolPolicy.mock.calls[0]?.[2]).toEqual({
    mode: "explicit",
    tools: [
      { kind: "mcp", id: "old" },
      { kind: "mcp", id: "new" },
    ],
    firstPartyMcpTools: ["session_pause"],
    expectedVersion: 7,
  });
});
test("a default that already includes the new integration stays a default", async () => {
  const h = harness("workspace_default", ["old", "new"]);
  await attachSessionCapability(t, h.client, "w", "s", item);
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
test("a lazily discovered integration attaches its installed server before reporting success", async () => {
  const h = harness("workspace_default", ["old"]);
  await attachSessionCapability(t, h.client, "w", "s", {
    ...item,
    tools: [],
    runtime: { mcpServerId: "installed-server", available: true, notes: null },
  } as CapabilityCatalogItem);
  expect(h.updateSessionToolPolicy.mock.calls[0]?.[2]).toMatchObject({
    tools: [
      { kind: "mcp", id: "old" },
      { kind: "mcp", id: "installed-server" },
    ],
    expectedVersion: 7,
  });
});
test("mandatory runtime servers are not echoed into the explicit tool selection", async () => {
  const h = harness();
  const read = h.client.getSession;
  h.client.getSession = async (...args) => {
    const session = await read(...args);
    return {
      ...session,
      tools: [...session.tools, { kind: "mcp", id: "opengeni" }],
      effectiveToolPolicy: { ...session.effectiveToolPolicy!, mandatoryIds: ["opengeni"] },
    };
  };
  await attachSessionCapability(t, h.client, "w", "s", item);
  expect(h.updateSessionToolPolicy.mock.calls[0]?.[2]).toMatchObject({
    mode: "explicit",
    tools: [
      { kind: "mcp", id: "old" },
      { kind: "mcp", id: "new" },
    ],
  });
});
test("a restricted default is preserved when adding just the requested integration", async () => {
  const h = harness("workspace_default", ["allowed"]);
  await attachSessionCapability(t, h.client, "w", "s", item);
  expect(h.updateSessionToolPolicy.mock.calls[0]?.[2]).toMatchObject({
    tools: [
      { kind: "mcp", id: "allowed" },
      { kind: "mcp", id: "new" },
    ],
  });
});
test("a truncated default cannot silently drop tools", async () => {
  const h = harness("workspace_default", ["old"], true);
  await expect(attachSessionCapability(t, h.client, "w", "s", item)).rejects.toThrow(
    "full session tool selection",
  );
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});

test("native OAuth return attaches freshly enabled tools and first-party names", async () => {
  const h = harness("explicit", ["old"]);
  h.client.listCapabilities = async () =>
    ({
      installations: [],
      items: [
        CapabilityCatalogItemSchema.parse({
          kind: "api",
          id: "api:fiken",
          name: "Fiken",
          source: "built_in",
          surfaceType: "first_party_fiken",
          tools: [{ kind: "mcp", id: "opengeni" }],
          enabled: true,
          metadata: { firstPartyMcpTools: ["fiken_companies_list", "fiken_invoices_list"] },
        }),
      ],
    }) as Awaited<ReturnType<OpenGeniBrowserClient["listCapabilities"]>>;
  await completeSessionCapabilityOAuth(t, h.client, "w", "s", "api:fiken");
  expect(h.updateSessionToolPolicy.mock.calls[0]?.[2]).toMatchObject({
    tools: [{ kind: "mcp", id: "old" }],
    firstPartyMcpTools: ["session_pause", "fiken_companies_list", "fiken_invoices_list"],
    expectedVersion: 7,
  });
  await Promise.resolve();
  expect(h.continueAfter.mock.calls).toEqual([["w", "s", { capabilityId: "api:fiken" }]]);
});
test("native OAuth return cannot claim success for an unresolved or disabled integration", async () => {
  const h = harness();
  h.client.listCapabilities = async () =>
    ({ items: [], installations: [] }) as Awaited<
      ReturnType<OpenGeniBrowserClient["listCapabilities"]>
    >;
  await expect(completeSessionCapabilityOAuth(t, h.client, "w", "s", null)).rejects.toThrow(
    "identified",
  );
  await expect(completeSessionCapabilityOAuth(t, h.client, "w", "s", "missing")).rejects.toThrow(
    "verified",
  );
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(h.continueAfter).not.toHaveBeenCalled();
});
test("a native OAuth return whose chat attach fails never continues the agent", async () => {
  const h = harness();
  h.client.listCapabilities = async () =>
    ({
      items: [{ ...item, id: "service", enabled: true }],
      installations: [],
    }) as unknown as Awaited<ReturnType<OpenGeniBrowserClient["listCapabilities"]>>;
  h.updateSessionToolPolicy.mockImplementationOnce(async () => {
    throw new Error("Version conflict");
  });
  await expect(completeSessionCapabilityOAuth(t, h.client, "w", "s", "service")).rejects.toThrow(
    "Version conflict",
  );
  await Promise.resolve();
  expect(h.continueAfter).not.toHaveBeenCalled();
});
test("continuing after setup never fails the setup the person just finished", async () => {
  const rejected = harness();
  rejected.continueAfter.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  expect(() => continueAfterCapabilitySetup(rejected.client, "w", "s", "service")).not.toThrow();
  // An older client without the method behaves the same way.
  const older = { ...harness().client, continueAfterCapabilitySetup: undefined };
  expect(() =>
    continueAfterCapabilitySetup(older as unknown as OpenGeniBrowserClient, "w", "s", "service"),
  ).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(rejected.continueAfter.mock.calls).toEqual([["w", "s", { capabilityId: "service" }]]);
});
