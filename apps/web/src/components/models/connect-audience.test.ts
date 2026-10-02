import { describe, expect, test } from "bun:test";

import {
  EVERYONE,
  audienceBlockedReason,
  audiencePolicy,
  personalWorkspacesSupported,
} from "./connect-audience";

describe("which workspaces can use a new organization account", () => {
  test("every workspace keeps the default policy, so nothing is saved after connecting", () => {
    expect(audiencePolicy(EVERYONE, "codex")).toBeNull();
    expect(audiencePolicy(EVERYONE, "openrouter")).toBeNull();
  });

  test("selected workspaces become the account's Available in", () => {
    expect(
      audiencePolicy(
        { kind: "selected", workspaceIds: ["w1"], personalWorkspaces: true },
        "supergrok",
      ),
    ).toEqual({ allowedWorkspaces: ["w1"], allowPersonalWorkspaces: true });
  });

  test("organization API keys never claim Personal workspaces", () => {
    expect(personalWorkspacesSupported("vercel_gateway")).toBe(false);
    expect(
      audiencePolicy(
        { kind: "selected", workspaceIds: ["w1"], personalWorkspaces: true },
        "anthropic",
      ),
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
