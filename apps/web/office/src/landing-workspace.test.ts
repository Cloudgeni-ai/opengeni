import { describe, expect, test } from "bun:test";
import { landingWorkspaceId } from "./landing-workspace";

describe("the workspace the Excel pane opens in", () => {
  const workspaceIds = ["someone-elses", "own", "team"];

  test("a first sign-in opens the person's own default, not the first in the list", () => {
    expect(landingWorkspaceId({ workspaceIds, remembered: null, defaultWorkspaceId: "own" })).toBe(
      "own",
    );
  });

  test("the workspace picked in the pane before wins", () => {
    expect(
      landingWorkspaceId({ workspaceIds, remembered: "team", defaultWorkspaceId: "own" }),
    ).toBe("team");
  });

  test("a remembered or default workspace the person lost access to is skipped", () => {
    expect(
      landingWorkspaceId({ workspaceIds, remembered: "gone", defaultWorkspaceId: "own" }),
    ).toBe("own");
    expect(
      landingWorkspaceId({ workspaceIds, remembered: "gone", defaultWorkspaceId: "also-gone" }),
    ).toBe("someone-elses");
    expect(landingWorkspaceId({ workspaceIds, remembered: null, defaultWorkspaceId: null })).toBe(
      "someone-elses",
    );
  });

  test("no workspace at all opens none", () => {
    expect(
      landingWorkspaceId({ workspaceIds: [], remembered: "team", defaultWorkspaceId: "own" }),
    ).toBeNull();
  });
});
