import { describe, expect, test } from "bun:test";
import type {
  ConnectionUseAttribution,
  ConnectionUseAuthoritySnapshot,
} from "@opengeni/contracts/connection-authority";
import {
  ConnectionProviderUseDeniedError,
  runAuthorizedConnectionProviderUse,
} from "../src/connection-provider-use";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

const snapshot: ConnectionUseAuthoritySnapshot = {
  organizationId: id("1"),
  originWorkspaceId: id("2"),
  targetWorkspaceId: id("3"),
  targetSessionId: id("4"),
  targetSessionVisibility: "workspace_shared",
  targetSessionAuthorityEpoch: 5,
  acceptedWork: { kind: "turn", turnId: id("6") },
  connectionId: id("7"),
  connectionGeneration: 8,
  connectionStatus: "active",
  providerDomain: "api.example.com",
  connectionKind: "oauth2",
  scope: "user",
  ownerSubjectId: "user:alice",
  ownerOrganizationMembershipId: id("9"),
  authoritySource: "user_delegation",
  selectionSources: ["mcp:example"],
  userDelegation: {
    authorityId: id("10"),
    grantId: id("11"),
    organizationId: id("1"),
    workspaceId: id("3"),
    sessionId: id("4"),
    action: "connection.use",
    mode: "session",
    context: "workspace_shared",
    authorityEpoch: 5,
    authorityGeneration: 1,
    grantGeneration: 1,
  },
};

const attribution: ConnectionUseAttribution = {
  organizationId: id("1"),
  workspaceId: id("3"),
  sessionId: id("4"),
  connectionId: id("7"),
  connectionGeneration: 8,
  scope: "user",
  ownerSubjectId: "user:alice",
  authorityId: id("10"),
  grantId: id("11"),
};

describe("connection provider pre-use guard", () => {
  test("revalidates once immediately before every provider request", async () => {
    let resolutions = 0;
    let invocations = 0;
    const use = () =>
      runAuthorizedConnectionProviderUse({
        snapshot,
        resolveAuthority: async () => {
          resolutions += 1;
          return { status: "authorized", attribution } as const;
        },
        invokeProvider: async (resolved) => {
          expect(resolved.ownerSubjectId).toBe("user:alice");
          expect(resolutions).toBe(invocations + 1);
          invocations += 1;
          return `effect-${invocations}`;
        },
      });
    expect((await use()).value).toBe("effect-1");
    expect((await use()).value).toBe("effect-2");
    expect({ resolutions, invocations }).toEqual({ resolutions: 2, invocations: 2 });
  });

  test("denial prevents provider invocation", async () => {
    let invoked = false;
    const result = runAuthorizedConnectionProviderUse({
      snapshot,
      resolveAuthority: async () => ({
        status: "denied",
        reason: "connection_generation_changed",
      }),
      invokeProvider: async () => {
        invoked = true;
      },
    });
    await expect(result).rejects.toBeInstanceOf(ConnectionProviderUseDeniedError);
    expect(invoked).toBe(false);
  });

  test("provider failure is propagated without replay", async () => {
    let attempts = 0;
    const failure = new Error("outcome unknown");
    const result = runAuthorizedConnectionProviderUse({
      snapshot,
      resolveAuthority: async () => ({ status: "authorized", attribution }),
      invokeProvider: async () => {
        attempts += 1;
        throw failure;
      },
    });
    await expect(result).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});
