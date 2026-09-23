import { describe, expect, test } from "bun:test";

import type { McpConnectionAccountSelection } from "@/types";
import {
  reusablePersonalGitHubAuthority,
  type PersonalGitHubAuthorityCache,
} from "./personal-github-authority";

const authority = {
  serverId: "github:personal",
  connectionId: "connection-1",
} satisfies McpConnectionAccountSelection;

const cache = {
  authority,
  connectionVersion: 7,
} satisfies PersonalGitHubAuthorityCache;

describe("personal GitHub authority cache", () => {
  test("reuses only the exact connection and version", () => {
    expect(
      reusablePersonalGitHubAuthority(cache, {
        connectionId: "connection-1",
        connectionVersion: 7,
      }),
    ).toBe(authority);

    expect(
      reusablePersonalGitHubAuthority(cache, {
        connectionId: "connection-1",
        connectionVersion: 8,
      }),
    ).toBeNull();
    expect(
      reusablePersonalGitHubAuthority(cache, { connectionId: "other", connectionVersion: 7 }),
    ).toBeNull();
  });
});
