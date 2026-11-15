import { describe, expect, test } from "bun:test";
import { WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { WorkspaceArtifactOperationError } from "@opengeni/db";
import {
  declareSiteToolsForEveryViewer,
  routeSiteTool,
  siteToolDeclarationsForEveryViewer,
} from "../src/site-tool-routing";

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

  test("refuses a list that pairing would push past the declaration limit", () => {
    const inventory = { accounts: [account("account-a", "dynamics")] };
    const declared = Array.from({ length: WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX }, (_, index) => ({
      serverId: "account-a",
      toolName: `tool_${index}`,
    }));
    expect(() => siteToolDeclarationsForEveryViewer(inventory, declared)).toThrow(
      `more than the limit of ${WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX}`,
    );
    // Exactly at the limit is fine.
    const half = declared.slice(0, WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX / 2);
    expect(siteToolDeclarationsForEveryViewer(inventory, half)).toHaveLength(
      WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX,
    );
    // Tools of a connector without the publisher's accounts need no pairing.
    expect(siteToolDeclarationsForEveryViewer({ accounts: [] }, declared)).toEqual(declared);
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

  test("an agent's publication fails visibly when its turn's account bindings can't be read", async () => {
    const grant = {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      subjectId: "agent:attempt",
      principalKind: "agent_attempt",
      permissions: [],
      metadata: { sessionId: "s", turnId: "t", attemptId: "a", executionGeneration: 1 },
    } as unknown as AccessGrant;
    const deps = { db: {} } as unknown as ApiRouteDeps;
    const declared = [{ serverId: "account-a", toolName: "query" }];
    const unusedInventory = async () => {
      throw new Error("an agent publishes with its turn's bindings");
    };
    const failed = declareSiteToolsForEveryViewer(deps, grant, declared, unusedInventory, () =>
      Promise.reject(new Error("connection reset")),
    );
    await expect(failed).rejects.toBeInstanceOf(WorkspaceArtifactOperationError);
    await expect(failed).rejects.toThrow("Nothing was published");
    // Readable bindings still pair the publisher's route with its connector.
    expect(
      await declareSiteToolsForEveryViewer(
        deps,
        grant,
        declared,
        unusedInventory,
        async () => [account("account-a", "dynamics")] as never,
      ),
    ).toEqual([...declared, { serverId: "dynamics", toolName: "query" }]);
  });
});
