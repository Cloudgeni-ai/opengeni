import { expect, mock, test } from "bun:test";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import type { Session } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  prepareSessionCapabilityAccess,
  applySessionCapabilityAccess,
} from "../src/session-capability-policy";
const fiken = CapabilityCatalogItem.parse({
  id: "api:fiken",
  name: "Fiken",
  kind: "api",
  source: "built_in",
  tools: [{ kind: "mcp", id: "opengeni" }],
  metadata: { firstPartyMcpTools: ["fiken_companies_list", "fiken_invoices_list"] },
});
function harness() {
  const sessions = new Map(
    ["root", "parent", "child"].map((id, index) => [
      id,
      {
        id,
        title: `${id} title`,
        workspaceId: "workspace",
        parentSessionId: index === 0 ? null : index === 1 ? "root" : "parent",
        tools: [
          { kind: "mcp", id: "opengeni" },
          { kind: "mcp", id: "existing" },
        ],
        firstPartyMcpTools: ["session_pause"],
        toolPolicy: { mode: "workspace_default", inheritedFromSessionId: index ? "root" : null },
        toolPolicyVersion: index + 5,
        effectiveToolPolicy: {
          effectiveIds: ["existing", "opengeni"],
          mandatoryIds: ["opengeni"],
          idsTruncated: false,
        },
      } as Session,
    ]),
  );
  const getSession = mock(async (_workspaceId: string, id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error("Permission denied reading parent");
    return structuredClone(session);
  });
  const updateSessionToolPolicy = mock(
    async (
      _workspaceId: string,
      id: string,
      request: Parameters<OpenGeniBrowserClient["updateSessionToolPolicy"]>[2],
    ) => {
      const session = sessions.get(id)!;
      if (request.expectedVersion !== session.toolPolicyVersion)
        throw new Error("Version conflict");
      if (request.mode !== "explicit") throw new Error("Unexpected default update");
      if (session.parentSessionId) {
        const parent = sessions.get(session.parentSessionId)!;
        if (request.firstPartyMcpTools.some((tool) => !parent.firstPartyMcpTools.includes(tool)))
          throw new Error("Child exceeds parent");
      }
      Object.assign(session, {
        tools: request.tools,
        firstPartyMcpTools: request.firstPartyMcpTools,
        toolPolicy: { ...session.toolPolicy, mode: "explicit" },
        toolPolicyVersion: session.toolPolicyVersion + 1,
      });
      return structuredClone(session);
    },
  );
  const client = { getSession, updateSessionToolPolicy } as unknown as OpenGeniBrowserClient;
  return { sessions, getSession, updateSessionToolPolicy, client };
}
test("child Add tools prepares a read-only review of all missing parents", async () => {
  const h = harness();
  const plan = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  expect(plan.sessions.map(({ id, title }) => ({ id, title }))).toEqual([
    { id: "root", title: "root title" },
    { id: "parent", title: "parent title" },
    { id: "child", title: "child title" },
  ]);
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
test("approved access applies root to child preserving selections with exact CAS", async () => {
  const h = harness();
  const plan = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  await applySessionCapabilityAccess(h.client, plan);
  expect(h.updateSessionToolPolicy.mock.calls.map((call) => call[1])).toEqual([
    "root",
    "parent",
    "child",
  ]);
  for (const [index, call] of h.updateSessionToolPolicy.mock.calls.entries())
    expect(call[2]).toEqual({
      mode: "explicit",
      tools: [{ kind: "mcp", id: "existing" }],
      firstPartyMcpTools: ["session_pause", "fiken_companies_list", "fiken_invoices_list"],
      expectedVersion: index + 5,
    });
});
test("a parent already allowing Fiken retains defaults and stops ancestor discovery", async () => {
  const h = harness();
  h.sessions.get("parent")!.firstPartyMcpTools.push("fiken_companies_list", "fiken_invoices_list");
  const plan = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  expect(plan.sessions.filter((chat) => chat.id !== "child").map((chat) => chat.request)).toEqual([
    null,
  ]);
  expect(h.getSession.mock.calls.map((call) => call[1])).toEqual(["child", "parent"]);
  await applySessionCapabilityAccess(h.client, plan);
  expect(h.updateSessionToolPolicy.mock.calls.map((call) => call[1])).toEqual(["child"]);
});
test("stale review aborts before any write", async () => {
  const h = harness();
  const plan = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  h.sessions.get("child")!.toolPolicyVersion++;
  await expect(applySessionCapabilityAccess(h.client, plan)).rejects.toThrow("Chat access changed");
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
test("inaccessible or truncated parent fails before any write", async () => {
  const h = harness();
  h.sessions.get("root")!.effectiveToolPolicy!.idsTruncated = true;
  await expect(
    prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken),
  ).rejects.toThrow("full session tool selection");
  h.sessions.delete("root");
  await expect(
    prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken),
  ).rejects.toThrow("Permission denied");
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
test("cyclic ancestry cannot produce a review", async () => {
  const h = harness();
  h.sessions.get("root")!.parentSessionId = "child";
  await expect(
    prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken),
  ).rejects.toThrow("parent chat chain");
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
test("scope interruption stops before writing next chat", async () => {
  const h = harness();
  const plan = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  await expect(
    applySessionCapabilityAccess(
      h.client,
      plan,
      () => h.updateSessionToolPolicy.mock.calls.length === 0,
    ),
  ).rejects.toThrow("interrupted");
  expect(h.updateSessionToolPolicy.mock.calls.map((call) => call[1])).toEqual(["root"]);
});
test("API denial stops writes and retry reviews remaining additions without rollback", async () => {
  const h = harness();
  const plan = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  const original = h.client.updateSessionToolPolicy;
  h.client.updateSessionToolPolicy = async (...args) => {
    if (args[1] === "parent") throw new Error("Permission denied");
    return original(...args);
  };
  await expect(applySessionCapabilityAccess(h.client, plan)).rejects.toThrow("Permission denied");
  expect(h.updateSessionToolPolicy.mock.calls.map((call) => call[1])).toEqual(["root"]);
  const retry = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  expect(retry.sessions.map((chat) => chat.request !== null)).toEqual([false, true, true]);
});
test("unchanged child never reads or broadens unrelated parents", async () => {
  const h = harness();
  h.sessions.get("child")!.firstPartyMcpTools.push("fiken_companies_list", "fiken_invoices_list");
  h.sessions.delete("parent");
  const plan = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  await applySessionCapabilityAccess(h.client, plan);
  expect(plan.sessions.map((chat) => chat.id)).toEqual(["child"]);
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
test("capability clamping cannot claim success or proceed to the child", async () => {
  const h = harness();
  const plan = await prepareSessionCapabilityAccess(h.client, "workspace", "child", fiken);
  h.client.updateSessionToolPolicy = async () => structuredClone(h.sessions.get("root")!);
  await expect(applySessionCapabilityAccess(h.client, plan)).rejects.toThrow(
    "capabilities do not allow",
  );
  expect(h.updateSessionToolPolicy).not.toHaveBeenCalled();
});
