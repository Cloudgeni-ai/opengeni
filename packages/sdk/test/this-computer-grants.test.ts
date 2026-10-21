import { describe, expect, test } from "bun:test";

import type { UserResourceAuthorityGrant, UserResourceAuthoritySummary } from "../src/types";

import {
  allowAgentsOnComputer,
  disallowAgentsOnComputer,
  type ComputerGrantClient,
} from "../src/this-computer";

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

describe("disallowAgentsOnComputer", () => {
  function revoking(authorities: UserResourceAuthoritySummary[]) {
    const revoked: Array<{ workspaceId: string; grantId: string }> = [];
    const api = {
      listUserResourceAuthorities: async () => ({
        scope: "user" as const,
        authorities,
        nextCursor: null,
      }),
      revokeUserResourceGrant: async (workspaceId: string, grantId: string) => {
        revoked.push({ workspaceId, grantId });
        return {};
      },
    };
    return { api, revoked };
  }

  test("takes back only the standing permission in this workspace", async () => {
    const keep = [
      grant({ grantId: "one-chat", mode: "session", targetSessionId: "s" }),
      grant({ grantId: "revoked", status: "revoked" }),
      grant({ grantId: "elsewhere", targetWorkspaceId: "elsewhere" }),
    ];
    const h = revoking([
      authority(MACHINE, [
        grant({ grantId: "private", context: "user_private" }),
        grant({ grantId: "shared", context: "workspace_shared" }),
        ...keep,
      ]),
    ]);
    await disallowAgentsOnComputer(h.api, WORKSPACE, MACHINE);
    expect(h.revoked).toEqual([
      { workspaceId: WORKSPACE, grantId: "private" },
      { workspaceId: WORKSPACE, grantId: "shared" },
    ]);
  });

  test("is done when the computer isn't listed", async () => {
    const h = revoking([authority("other", [grant({})])]);
    await disallowAgentsOnComputer(h.api, WORKSPACE, MACHINE);
    expect(h.revoked).toHaveLength(0);
  });
});
