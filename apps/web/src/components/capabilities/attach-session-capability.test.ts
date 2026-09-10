import { expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem } from "@/types";
import {
  attachSessionCapability,
  completeSessionCapabilityOAuth,
} from "./attach-session-capability";
const item = { kind: "mcp", tools: [{ kind: "mcp", id: "new" }] } as CapabilityCatalogItem;
function harness(mode = "explicit", selectedIds = ["old"], idsTruncated = false) {
  const updateSessionToolPolicy = mock(
    async (..._args: Parameters<OpenGeniBrowserClient["updateSessionToolPolicy"]>) => ({}),
  );
  const client = {
    getSession: async () => ({
      tools: [{ kind: "mcp", id: "old" }],
      firstPartyMcpTools: ["session_pause"],
      toolPolicyVersion: 7,
      toolPolicy: { mode },
      effectiveToolPolicy: { selectedIds, idsTruncated },
    }),
    updateSessionToolPolicy,
  } as unknown as OpenGeniBrowserClient;
  return { client, updateSessionToolPolicy };
}
test("adding a connection preserves tools and first-party restrictions with CAS", async () => {
  const h = harness();
  await attachSessionCapability(h.client, "w", "s", item);
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
  await attachSessionCapability(h.client, "w", "s", item);
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
test("a restricted default is preserved when adding just the requested integration", async () => {
  const h = harness("workspace_default", ["allowed"]);
  await attachSessionCapability(h.client, "w", "s", item);
  expect(h.updateSessionToolPolicy.mock.calls[0]?.[2]).toMatchObject({
    tools: [
      { kind: "mcp", id: "allowed" },
      { kind: "mcp", id: "new" },
    ],
  });
});
test("a truncated default cannot silently drop tools", async () => {
  const h = harness("workspace_default", ["old"], true);
  await expect(attachSessionCapability(h.client, "w", "s", item)).rejects.toThrow(
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
        {
          ...item,
          id: "fiken",
          enabled: true,
          metadata: { firstPartyMcpTools: ["fiken_list_companies"] },
        },
      ],
    }) as Awaited<ReturnType<OpenGeniBrowserClient["listCapabilities"]>>;
  await completeSessionCapabilityOAuth(h.client, "w", "s", "fiken");
  expect(h.updateSessionToolPolicy.mock.calls[0]?.[2]).toMatchObject({
    tools: [
      { kind: "mcp", id: "old" },
      { kind: "mcp", id: "new" },
    ],
    firstPartyMcpTools: ["session_pause", "fiken_list_companies"],
    expectedVersion: 7,
  });
});
test("native OAuth return cannot claim success for an unresolved or disabled integration", async () => {
  const h = harness();
  h.client.listCapabilities = async () =>
    ({ items: [], installations: [] }) as Awaited<
      ReturnType<OpenGeniBrowserClient["listCapabilities"]>
    >;
  await expect(completeSessionCapabilityOAuth(h.client, "w", "s", null)).rejects.toThrow(
    "identified",
  );
  await expect(completeSessionCapabilityOAuth(h.client, "w", "s", "missing")).rejects.toThrow(
    "verified",
  );
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
