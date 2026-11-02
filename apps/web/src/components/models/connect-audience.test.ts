import { describe, expect, test } from "bun:test";

import { EVERYONE, audienceBlockedReason, audiencePolicy } from "./connect-audience";

describe("which workspaces can use a new organization account", () => {
  test("every workspace, Personal ones too, keeps the default policy, so nothing is saved after connecting", () => {
    expect(audiencePolicy(EVERYONE)).toBeNull();
  });

  test("every shared workspace without Personal ones is saved", () => {
    expect(audiencePolicy({ workspaceIds: null, personalWorkspaces: false })).toEqual({
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
    });
  });

  test("selected workspaces become the account's Available in, Personal workspaces included", () => {
    expect(audiencePolicy({ workspaceIds: ["w1"], personalWorkspaces: true })).toEqual({
      allowedWorkspaces: ["w1"],
      allowPersonalWorkspaces: true,
    });
    expect(audiencePolicy({ workspaceIds: ["w1"], personalWorkspaces: false })).toEqual({
      allowedWorkspaces: ["w1"],
      allowPersonalWorkspaces: false,
    });
  });

  test("an empty selection can't be connected", () => {
    expect(audienceBlockedReason({ workspaceIds: [], personalWorkspaces: false })).toBe(
      "Choose at least one workspace.",
    );
    expect(audienceBlockedReason({ workspaceIds: [], personalWorkspaces: true })).toBeNull();
    expect(audienceBlockedReason({ workspaceIds: null, personalWorkspaces: false })).toBeNull();
  });
});
