import { describe, expect, test } from "bun:test";
import { WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX } from "@opengeni/contracts";
import { routeSiteTool, siteToolDeclarationsForEveryViewer } from "../src/site-tool-routing";

const account = (serverId: string, canonicalServerId: string) => ({
  serverId,
  connector: canonicalServerId,
  account: `${serverId}@example.test`,
  canonicalServerId,
  connectionId: `${serverId}-connection`,
});

describe("Site tool declarations for every viewer", () => {
  test("pairs each of the publisher's own routes with its connector once, keeping order", () => {
    const inventory = {
      accounts: [account("account-a", "dynamics"), account("account-b", "gmail")],
    };
    const declared = [
      { serverId: "account-a", toolName: "query" },
      { serverId: "opengeni", toolName: "sessions_list" },
      { serverId: "account-a", toolName: "update" },
      { serverId: "account-b", toolName: "send" },
      { serverId: "gmail", toolName: "send" },
      { serverId: "account-unknown", toolName: "query" },
    ];
    expect(siteToolDeclarationsForEveryViewer(inventory, declared)).toEqual([
      ...declared,
      { serverId: "dynamics", toolName: "query" },
      { serverId: "dynamics", toolName: "update" },
    ]);
    expect(siteToolDeclarationsForEveryViewer({ accounts: [] }, declared)).toEqual(declared);
  });

  test("never grows past the declaration limit", () => {
    const inventory = { accounts: [account("account-a", "dynamics")] };
    const declared = Array.from({ length: WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX }, (_, index) => ({
      serverId: "account-a",
      toolName: `tool_${index}`,
    }));
    expect(siteToolDeclarationsForEveryViewer(inventory, declared)).toEqual(declared);
    const roomForOne = declared.slice(1);
    const paired = siteToolDeclarationsForEveryViewer(inventory, roomForOne);
    expect(paired).toHaveLength(WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX);
    expect(paired.at(-1)).toEqual({ serverId: "dynamics", toolName: "tool_1" });
  });

  test("a paired declaration routes another viewer to connect; an unpaired one is marked unresolved", () => {
    const connect = { capabilityId: "dynamics", name: "Dynamics", providerDomain: "dynamics" };
    const viewer = {
      canonical: new Map([["dynamics", connect]]),
      plain: new Set(["opengeni"]),
      accounts: [],
    };
    const publisherRoute = { serverId: "account-publisher", toolName: "query" };
    const paired = siteToolDeclarationsForEveryViewer(
      { accounts: [account("account-publisher", "dynamics")] },
      [publisherRoute],
    );
    expect(routeSiteTool(viewer, paired, publisherRoute)).toMatchObject({
      kind: "connect",
      connect,
    });
    expect(routeSiteTool(viewer, [publisherRoute], publisherRoute)).toMatchObject({
      kind: "direct",
      identity: publisherRoute,
      unresolved: true,
    });
    // Tools that run as themselves are not marked.
    const firstParty = { serverId: "opengeni", toolName: "sessions_list" };
    expect(routeSiteTool(viewer, [firstParty], firstParty)).not.toHaveProperty("unresolved");
  });
});
