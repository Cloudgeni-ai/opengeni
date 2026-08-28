import { describe, expect, test } from "bun:test";

import type { McpConnectionAuthoritySelection } from "@/types";
import {
  reusablePersonalGitHubAuthority,
  type PersonalGitHubAuthorityCache,
} from "./personal-github-authority";

const authority = {
  serverId: "github:personal",
  connectionId: "connection-1",
  userDelegation: {
    authorityId: "authority-1",
    grantId: "grant-1",
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    sessionId: null,
    action: "connection.use",
    mode: "always",
    context: "workspace_shared",
    authorityEpoch: null,
    authorityGeneration: 4,
    grantGeneration: 2,
  },
} satisfies McpConnectionAuthoritySelection;

const cache = {
  authority,
  connectionVersion: 7,
} satisfies PersonalGitHubAuthorityCache;

describe("personal GitHub authority cache", () => {
  test("reuses only the exact connection version, authority generation, and context", () => {
    expect(
      reusablePersonalGitHubAuthority(cache, {
        connectionId: "connection-1",
        connectionVersion: 7,
        connectionAuthorityGeneration: 4,
        context: "workspace_shared",
      }),
    ).toBe(authority);

    expect(
      reusablePersonalGitHubAuthority(cache, {
        connectionId: "connection-1",
        connectionVersion: 8,
        connectionAuthorityGeneration: 5,
        context: "workspace_shared",
      }),
    ).toBeNull();
    expect(
      reusablePersonalGitHubAuthority(cache, {
        connectionId: "connection-1",
        connectionVersion: 7,
        connectionAuthorityGeneration: 5,
        context: "workspace_shared",
      }),
    ).toBeNull();
    expect(
      reusablePersonalGitHubAuthority(cache, {
        connectionId: "connection-1",
        connectionVersion: 7,
        connectionAuthorityGeneration: 4,
        context: "user_private",
      }),
    ).toBeNull();
  });
});
