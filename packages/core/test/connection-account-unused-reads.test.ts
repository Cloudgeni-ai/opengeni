import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { freezeConnectionAccounts } from "../src/domain/personal-connection-delegations";

test("no account-backed routes require no account reads and preserve intent", async () => {
  const source = { kind: "subject" as const, subjectId: "user:caller", accountId: "account" };
  const result = await freezeConnectionAccounts({
    db: {} as db.Database,
    settings: testSettings({ mcpServers: [] }),
    accountId: "account",
    workspaceId: "workspace",
    source,
    tools: [],
    resources: [],
    authoritySelections: [],
  });
  expect(result).toEqual({
    mcpAccountBindings: [],
    personalConnectionDelegations: [],
    connectionAccountIntent: {
      version: 1,
      principal: { kind: "subject", subjectId: "user:caller" },
      selections: [],
    },
  });
});

for (const member of [true, false]) {
  test(`first-party social authority retains live membership without reading native metadata: ${member}`, async () => {
    const membership = spyOn(db, "namedSubjectHasLiveWorkspaceAuthority").mockResolvedValue(member);
    const native = spyOn(db, "listOwnedConnectionAccounts").mockResolvedValue([]);
    const workspace = spyOn(db, "listConnectionsMetadata").mockImplementation(async () => {
      throw new Error("unused generic MCP accounts read");
    });
    const social = spyOn(db, "listSocialConnections").mockResolvedValue([]);
    try {
      const result = await freezeConnectionAccounts({
        db: {} as db.Database,
        settings: testSettings({ mcpServers: [] }),
        accountId: "account",
        workspaceId: "workspace",
        source: { kind: "subject", subjectId: "user:caller", accountId: "account" },
        tools: [{ kind: "mcp", id: "opengeni" }],
        resources: [],
      });
      expect(result.mcpAccountBindings).toEqual([]);
      expect(result.personalConnectionDelegations).toEqual([]);
      expect(membership).toHaveBeenCalledTimes(1);
      expect(native).not.toHaveBeenCalled();
      expect(social).toHaveBeenCalledTimes(member ? 1 : 0);
      expect(workspace).not.toHaveBeenCalled();
    } finally {
      membership.mockRestore();
      native.mockRestore();
      workspace.mockRestore();
      social.mockRestore();
    }
  });
}
