import { describe, expect, test } from "bun:test";

import { EVERYONE, audienceBlockedReason, audiencePolicy } from "./connect-audience";

describe("which workspaces can use a new organization account", () => {
  test("every workspace keeps the default policy, so nothing is saved after connecting", () => {
    expect(audiencePolicy(EVERYONE)).toBeNull();
  });

  test("selected workspaces become the account's Available in, Personal workspaces included", () => {
    expect(
      audiencePolicy({ kind: "selected", workspaceIds: ["w1"], personalWorkspaces: true }),
    ).toEqual({ allowedWorkspaces: ["w1"], allowPersonalWorkspaces: true });
    expect(
      audiencePolicy({ kind: "selected", workspaceIds: ["w1"], personalWorkspaces: false }),
    ).toEqual({ allowedWorkspaces: ["w1"], allowPersonalWorkspaces: false });
  });

  test("an empty selection can't be connected", () => {
    expect(
      audienceBlockedReason({ kind: "selected", workspaceIds: [], personalWorkspaces: false }),
    ).toBe("Choose at least one workspace.");
    expect(
      audienceBlockedReason({ kind: "selected", workspaceIds: [], personalWorkspaces: true }),
    ).toBeNull();
  });
});
