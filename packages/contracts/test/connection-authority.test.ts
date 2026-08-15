import { describe, expect, test } from "bun:test";
import {
  ConnectionAuthorityEnvelope,
  ConnectionUseAttribution,
  ConnectionUseAuthoritySnapshot,
} from "../src/connection-authority";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

const delegation = {
  authorityId: id("1"),
  grantId: id("2"),
  organizationId: id("3"),
  workspaceId: id("4"),
  sessionId: id("5"),
  action: "connection.use",
  mode: "session",
  context: "workspace_shared",
  authorityEpoch: 7,
  authorityGeneration: 2,
  grantGeneration: 3,
} as const;

describe("connection authority contracts", () => {
  test("preserves legacy workspace omission without accepting personal owner input", () => {
    expect(ConnectionAuthorityEnvelope.parse({})).toEqual({ scope: "workspace" });
    expect(
      ConnectionAuthorityEnvelope.safeParse({ scope: "workspace", ownerSubjectId: "user:alice" })
        .success,
    ).toBe(false);
  });

  test("requires the common connection.use delegation for user scope", () => {
    expect(ConnectionAuthorityEnvelope.safeParse({ scope: "user" }).success).toBe(false);
    expect(
      ConnectionAuthorityEnvelope.safeParse({
        scope: "user",
        userDelegation: { ...delegation, action: "github.use" },
      }).success,
    ).toBe(false);
    expect(
      ConnectionAuthorityEnvelope.parse({ scope: "user", userDelegation: delegation }),
    ).toEqual({ scope: "user", userDelegation: delegation });
  });

  test("freezes exact personal owner, scope, generation, and delegation provenance", () => {
    const snapshot = ConnectionUseAuthoritySnapshot.parse({
      organizationId: id("3"),
      originWorkspaceId: id("6"),
      targetWorkspaceId: id("4"),
      targetSessionId: id("5"),
      targetSessionVisibility: "workspace_shared",
      targetSessionAuthorityEpoch: 7,
      acceptedWork: { kind: "turn", turnId: id("7") },
      connectionId: id("8"),
      connectionGeneration: 9,
      connectionStatus: "active",
      providerDomain: "api.example.com",
      connectionKind: "oauth2",
      scope: "user",
      ownerSubjectId: "user:alice",
      ownerOrganizationMembershipId: id("9"),
      authoritySource: "user_delegation",
      selectionSources: ["mcp:example"],
      userDelegation: delegation,
    });
    expect(snapshot).toMatchObject({
      connectionId: id("8"),
      connectionGeneration: 9,
      ownerSubjectId: "user:alice",
      userDelegation: delegation,
    });
  });

  test("keeps usage attribution credential and value free", () => {
    const clean = {
      organizationId: id("3"),
      workspaceId: id("4"),
      sessionId: id("5"),
      connectionId: id("8"),
      connectionGeneration: 9,
      scope: "user",
      ownerSubjectId: "user:alice",
      authorityId: id("1"),
      grantId: id("2"),
    };
    expect(
      ConnectionUseAttribution.safeParse({
        ...clean,
        credential: "must-not-survive",
        quota: 10,
        metadata: { email: "must-not-survive@example.com" },
      }).success,
    ).toBe(false);
    const attribution = ConnectionUseAttribution.parse(clean);
    expect(
      ConnectionUseAttribution.safeParse({
        ...clean,
        scope: "workspace",
        ownerSubjectId: "user:alice",
      }).success,
    ).toBe(false);
    const serialized = JSON.stringify(attribution);
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("quota");
    expect(serialized).not.toContain("email");
    expect(attribution.ownerSubjectId).toBe("user:alice");
  });
});
