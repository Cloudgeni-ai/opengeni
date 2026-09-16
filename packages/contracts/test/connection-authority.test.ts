import { describe, expect, test } from "bun:test";
import {
  ConnectionUseAttribution,
  ConnectionUseAuthoritySnapshot,
} from "../src/connection-authority";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("connection authority contracts", () => {
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
      ownerMembershipAuthorizationRevision: 11,
      authoritySource: "sender",
      selectionSources: ["mcp:example"],
      userDelegation: null,
    });
    expect(snapshot).toMatchObject({
      connectionId: id("8"),
      connectionGeneration: 9,
      ownerSubjectId: "user:alice",
      userDelegation: null,
    });
  });

  test("rejects legacy user snapshots and live attribution", () => {
    const legacy = {
      organizationId: id("3"),
      originWorkspaceId: id("4"),
      targetWorkspaceId: id("4"),
      targetSessionId: id("5"),
      targetSessionVisibility: "user_private",
      targetSessionAuthorityEpoch: 7,
      acceptedWork: { kind: "turn", turnId: id("7") },
      connectionId: id("8"),
      connectionGeneration: 9,
      connectionStatus: "active",
      providerDomain: "api.example.com",
      connectionKind: "oauth2",
      scope: "legacy_user",
      ownerSubjectId: "user:alice",
      ownerOrganizationMembershipId: null,
      ownerMembershipAuthorizationRevision: null,
      authoritySource: "legacy_user_compatibility",
      selectionSources: ["mcp:example"],
      userDelegation: null,
    };
    expect(ConnectionUseAuthoritySnapshot.safeParse(legacy).success).toBe(false);
    expect(
      ConnectionUseAttribution.safeParse({
        organizationId: id("3"),
        workspaceId: id("4"),
        sessionId: id("5"),
        connectionId: id("8"),
        connectionGeneration: 9,
        scope: "legacy_user",
        ownerSubjectId: "user:alice",
        authorityId: null,
        grantId: null,
      }).success,
    ).toBe(false);
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
      grantId: null,
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
