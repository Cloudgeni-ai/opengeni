import { describe, expect, mock, test } from "bun:test";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";

import { personalGitHubLoginForTurn } from "../src/activities/agent-turn/personal-github-login";

const ORIGIN = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const personal = {
  serverId: "github_personal",
  connectionId: CONNECTION,
  originWorkspaceId: ORIGIN,
  ownerSubjectId: "person-a",
  providerDomain: "github.com",
  connectionType: "github_personal",
} as McpPersonalConnectionDelegation;
const db = {} as never;

describe("personal GitHub login for the repositories prompt", () => {
  test("reads the delegated connection's login from its origin workspace", async () => {
    const read = mock(async () => ({ metadata: { githubLogin: "octocat" } }) as never);
    expect(await personalGitHubLoginForTurn(db, [personal], read)).toBe("octocat");
    expect(read).toHaveBeenCalledWith(db, ORIGIN, CONNECTION, "person-a");
  });

  test("is best effort: no delegation, no login, or a failed read omit it", async () => {
    const never = mock(async () => null as never);
    expect(await personalGitHubLoginForTurn(db, null, never)).toBeUndefined();
    expect(
      await personalGitHubLoginForTurn(db, [{ ...personal, connectionType: "mcp" }], never),
    ).toBeUndefined();
    expect(never).not.toHaveBeenCalled();
    expect(
      await personalGitHubLoginForTurn(db, [personal], async () => ({ metadata: {} }) as never),
    ).toBeUndefined();
    expect(
      await personalGitHubLoginForTurn(db, [personal], async () => {
        throw new Error("database unavailable");
      }),
    ).toBeUndefined();
  });
});
