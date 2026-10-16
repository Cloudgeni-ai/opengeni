import { describe, expect, test } from "bun:test";

import type { UserResourceAuthorityGrant, UserResourceAuthoritySummary } from "@opengeni/sdk";

import { allowAgentsOnComputer, type ComputerGrantClient } from "../src/main/computer-grants";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const MACHINE = "22222222-2222-4222-8222-222222222222";

function grant(overrides: Partial<UserResourceAuthorityGrant>): UserResourceAuthorityGrant {
  return {
    grantId: crypto.randomUUID(),
    targetWorkspaceId: WORKSPACE,
    targetSessionId: null,
    action: "connected_machine.use",
    mode: "always",
    context: "user_private",
    authorityEpoch: null,
    generation: 1,
    status: "active",
    expiresAt: null,
    delegation: {} as UserResourceAuthorityGrant["delegation"],
    ...overrides,
  };
}

function authority(
  resourceId: string,
  grants: UserResourceAuthorityGrant[] = [],
): UserResourceAuthoritySummary {
  return {
    authorityId: `authority-${resourceId}`,
    resourceKind: "connected_machine",
    resourceId,
    originWorkspaceId: WORKSPACE,
    generation: 1,
    status: "active",
    grants,
  };
}

function client(pages: UserResourceAuthoritySummary[][]) {
  const issued: Array<{ authorityId: string; context: string; acknowledged: unknown }> = [];
  const cursors: Array<string | undefined> = [];
  const api: ComputerGrantClient = {
    listUserResourceAuthorities: async (_workspaceId, options) => {
      cursors.push(options.cursor);
      const index = options.cursor ? Number(options.cursor) : 0;
      return {
        scope: "user",
        authorities: pages[index] ?? [],
        nextCursor: index + 1 < pages.length ? String(index + 1) : null,
      };
    },
    issueUserResourceGrant: async (_workspaceId, authorityId, request) => {
      issued.push({
        authorityId,
        context: request.context,
        acknowledged: request.workspaceSharedAcknowledged,
      });
      return { scope: "user", grant: grant({ context: request.context }) };
    },
  };
  return { api, issued, cursors };
}

describe("allowAgentsOnComputer", () => {
  test("gives standing permission for private and shared chats", async () => {
    const h = client([[authority("other"), authority(MACHINE)]]);
    await allowAgentsOnComputer(h.api, WORKSPACE, MACHINE);
    expect(h.issued).toEqual([
      { authorityId: `authority-${MACHINE}`, context: "user_private", acknowledged: undefined },
      { authorityId: `authority-${MACHINE}`, context: "workspace_shared", acknowledged: true },
    ]);
  });

  test("leaves permission that already stands alone", async () => {
    const h = client([
      [
        authority(MACHINE, [
          grant({ context: "user_private" }),
          // Not standing: for one chat, revoked, another workspace, expired.
          grant({ context: "workspace_shared", mode: "session", targetSessionId: "s" }),
          grant({ context: "workspace_shared", status: "revoked" }),
          grant({ context: "workspace_shared", targetWorkspaceId: "elsewhere" }),
          grant({ context: "workspace_shared", expiresAt: "2000-01-01T00:00:00.000Z" }),
        ]),
      ],
    ]);
    await allowAgentsOnComputer(h.api, WORKSPACE, MACHINE);
    expect(h.issued.map((entry) => entry.context)).toEqual(["workspace_shared"]);
  });

  test("follows pages to find the computer", async () => {
    const h = client([[authority("a")], [authority("b")], [authority(MACHINE)]]);
    await allowAgentsOnComputer(h.api, WORKSPACE, MACHINE);
    expect(h.cursors).toEqual([undefined, "1", "2"]);
    expect(h.issued).toHaveLength(2);
  });

  test("says so when the computer isn't listed", async () => {
    const h = client([[authority("other")]]);
    await expect(allowAgentsOnComputer(h.api, WORKSPACE, MACHINE)).rejects.toThrow(
      "isn't listed as yours yet",
    );
    expect(h.issued).toHaveLength(0);
  });
});
