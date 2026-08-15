import { describe, expect, test } from "bun:test";
import type { UserResourceDelegation } from "@opengeni/contracts";
import {
  captureConnectionUseAuthority,
  ConnectionAuthorityInvariantError,
  revalidateConnectionUseAuthority,
  type ConnectionAuthorityCandidate,
  type LiveConnectionUseState,
  type UserConnectionAuthorityCandidate,
} from "../src/domain/connection-authority";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const organizationId = id("1");
const originWorkspaceId = id("2");
const targetWorkspaceId = id("3");
const sessionId = id("4");
const connectionId = id("5");
const membershipId = id("6");
const authorityId = id("7");
const grantId = id("8");

const personalConnection: ConnectionAuthorityCandidate = {
  id: connectionId,
  organizationId,
  workspaceId: originWorkspaceId,
  generation: 4,
  status: "active",
  providerDomain: "API.Example.COM",
  kind: "oauth2",
  subjectId: "user:alice",
  ownerOrganizationMembershipId: membershipId,
};

const delegation: UserResourceDelegation = {
  authorityId,
  grantId,
  organizationId,
  workspaceId: targetWorkspaceId,
  sessionId,
  action: "connection.use",
  mode: "session",
  context: "workspace_shared",
  authorityEpoch: 9,
  authorityGeneration: 2,
  grantGeneration: 3,
};

const userAuthority: UserConnectionAuthorityCandidate = {
  id: authorityId,
  organizationId,
  resourceKind: "connection",
  resourceId: connectionId,
  originWorkspaceId,
  ownerSubjectId: "user:alice",
  ownerOrganizationMembershipId: membershipId,
  generation: 2,
  status: "active",
};

function personalSnapshot() {
  return captureConnectionUseAuthority({
    organizationId,
    targetWorkspaceId,
    targetSessionId: sessionId,
    targetSessionVisibility: "workspace_shared",
    targetSessionAuthorityEpoch: 9,
    acceptedWork: { kind: "turn", turnId: id("9") },
    connection: personalConnection,
    authority: { scope: "user", userDelegation: delegation },
    userAuthority,
    selectionSources: ["mcp:example"],
  });
}

function personalLive(): LiveConnectionUseState {
  return {
    organizationId,
    targetWorkspaceId,
    targetWorkspaceAccessActive: true,
    session: {
      id: sessionId,
      organizationId,
      workspaceId: targetWorkspaceId,
      visibility: "workspace_shared",
      authorityEpoch: 9,
      active: true,
    },
    connection: { ...personalConnection },
    ownerMembership: {
      id: membershipId,
      organizationId,
      subjectId: "user:alice",
      status: "active",
    },
    userAuthority: { ...userAuthority },
    grant: {
      id: grantId,
      authorityId,
      organizationId,
      workspaceId: targetWorkspaceId,
      sessionId,
      action: "connection.use",
      mode: "session",
      context: "workspace_shared",
      authorityEpoch: 9,
      generation: 3,
      status: "active",
      expiresAt: null,
      consumed: false,
    },
  };
}

describe("connection authority capture and revalidation", () => {
  test("legacy omission selects only a target-local workspace connection", () => {
    const workspaceConnection: ConnectionAuthorityCandidate = {
      ...personalConnection,
      workspaceId: targetWorkspaceId,
      subjectId: null,
      ownerOrganizationMembershipId: null,
    };
    const snapshot = captureConnectionUseAuthority({
      organizationId,
      targetWorkspaceId,
      targetSessionId: sessionId,
      targetSessionVisibility: "workspace_shared",
      targetSessionAuthorityEpoch: 1,
      acceptedWork: { kind: "turn", turnId: id("9") },
      connection: workspaceConnection,
      authorityWasOmitted: true,
      selectionSources: ["legacy:mcp"],
    });
    expect(snapshot).toMatchObject({
      scope: "workspace",
      authoritySource: "legacy_workspace_omission",
      ownerSubjectId: null,
      userDelegation: null,
    });
  });

  test("workspace authority never borrows a personal connection", () => {
    expect(() =>
      captureConnectionUseAuthority({
        organizationId,
        targetWorkspaceId,
        targetSessionId: sessionId,
        targetSessionVisibility: "workspace_shared",
        targetSessionAuthorityEpoch: 1,
        acceptedWork: { kind: "turn", turnId: id("9") },
        connection: personalConnection,
        authority: { scope: "workspace" },
        selectionSources: ["mcp:example"],
      }),
    ).toThrow(ConnectionAuthorityInvariantError);
  });

  test("derives the personal owner from the resolved connection and common authority", () => {
    expect(personalSnapshot()).toMatchObject({
      scope: "user",
      ownerSubjectId: "user:alice",
      ownerOrganizationMembershipId: membershipId,
      connectionGeneration: 4,
      userDelegation: delegation,
    });
  });

  test("authorizes an unchanged personal connection and attributes usage to its owner", () => {
    expect(
      revalidateConnectionUseAuthority({ snapshot: personalSnapshot(), live: personalLive() }),
    ).toEqual({
      status: "authorized",
      attribution: {
        organizationId,
        workspaceId: targetWorkspaceId,
        sessionId,
        connectionId,
        connectionGeneration: 4,
        scope: "user",
        ownerSubjectId: "user:alice",
        authorityId,
        grantId,
      },
    });
  });

  test("disconnect or reconnect generation immediately blocks provider use", () => {
    const disconnected = personalLive();
    disconnected.connection = { ...personalConnection, status: "revoked", generation: 5 };
    expect(
      revalidateConnectionUseAuthority({ snapshot: personalSnapshot(), live: disconnected }),
    ).toEqual({ status: "denied", reason: "connection_generation_changed" });
  });

  test("grant revocation and session epoch changes immediately block queued use", () => {
    const revoked = personalLive();
    revoked.grant = { ...revoked.grant!, status: "revoked", generation: 4 };
    expect(
      revalidateConnectionUseAuthority({ snapshot: personalSnapshot(), live: revoked }),
    ).toEqual({ status: "denied", reason: "grant_generation_changed" });

    const visibilityChanged = personalLive();
    visibilityChanged.session.authorityEpoch = 10;
    expect(
      revalidateConnectionUseAuthority({ snapshot: personalSnapshot(), live: visibilityChanged }),
    ).toEqual({ status: "denied", reason: "session_authority_epoch_changed" });
  });

  test("owner membership loss blocks long-lived use without changing attribution", () => {
    const inactiveOwner = personalLive();
    inactiveOwner.ownerMembership = { ...inactiveOwner.ownerMembership!, status: "revoked" };
    expect(
      revalidateConnectionUseAuthority({ snapshot: personalSnapshot(), live: inactiveOwner }),
    ).toEqual({ status: "denied", reason: "owner_membership_inactive" });
  });
});
