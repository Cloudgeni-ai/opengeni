import { describe, expect, test } from "bun:test";
import type { AccessGrantAuthorization } from "@opengeni/core";
import {
  connectionUseGrantLifecycleInput,
  projectSelfConnectionAuthorities,
  requireConnectionAuthorityOwner,
} from "../src/connection-authority-owner";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

function access(overrides: Partial<AccessGrantAuthorization> = {}): AccessGrantAuthorization {
  return {
    authenticatedSubjectId: "user:alice",
    contextIntegrity: true,
    accountGrant: null,
    grant: {
      accountId: id("1"),
      workspaceId: id("2"),
      subjectId: "user:alice",
      permissions: ["workspace:read"],
      principalKind: "human_session",
    },
    ...overrides,
  } as AccessGrantAuthorization;
}

describe("connection authority API owner boundary", () => {
  test("accepts only the exact integrity-checked human owner", () => {
    expect(requireConnectionAuthorityOwner(access())).toBe("user:alice");
    expect(() =>
      requireConnectionAuthorityOwner(access({ authenticatedSubjectId: "user:mallory" })),
    ).toThrow("authenticated connection owner required");
    expect(() =>
      requireConnectionAuthorityOwner(
        access({ grant: { ...access().grant, principalKind: "agent_attempt" } }),
      ),
    ).toThrow("authenticated connection owner required");
  });

  test("derives connection.use and rejects arbitrary action or owner", () => {
    expect(
      connectionUseGrantLifecycleInput({
        scope: "user",
        mode: "session",
        context: "workspace_shared",
        sessionId: id("3"),
        expectedAuthorityEpoch: 7,
        workspaceSharedAcknowledged: true,
      }),
    ).toEqual({
      action: "connection.use",
      mode: "session",
      context: "workspace_shared",
      sessionId: id("3"),
      expectedAuthorityEpoch: 7,
      workspaceSharedAcknowledged: true,
    });
    expect(() =>
      connectionUseGrantLifecycleInput({
        scope: "user",
        mode: "always",
        context: "user_private",
        ownerSubjectId: "user:mallory",
        action: "provider.admin",
      }),
    ).toThrow();
  });

  test("projects only opaque connection authority rows", () => {
    expect(
      projectSelfConnectionAuthorities({
        authorities: [
          {
            authorityId: id("4"),
            resourceKind: "connection",
            resourceId: id("7"),
            originWorkspaceId: id("8"),
            generation: 1,
            status: "active",
            grants: [
              {
                grantId: id("5"),
                targetWorkspaceId: id("2"),
                targetSessionId: null,
                action: "connection.use",
                mode: "always",
                context: "user_private",
                authorityEpoch: null,
                generation: 1,
                status: "active",
                expiresAt: null,
                delegation: {
                  authorityId: id("4"),
                  grantId: id("5"),
                  organizationId: id("1"),
                  workspaceId: id("2"),
                  sessionId: null,
                  action: "connection.use",
                  mode: "always",
                  context: "user_private",
                  authorityEpoch: null,
                  authorityGeneration: 1,
                  grantGeneration: 1,
                },
              },
            ],
          },
          {
            authorityId: id("6"),
            resourceKind: "rig",
            resourceId: id("9"),
            originWorkspaceId: null,
            generation: 1,
            status: "active",
            grants: [],
          },
        ],
        nextCursor: id("6"),
      }),
    ).toEqual({
      scope: "user",
      authorities: [
        {
          authorityId: id("4"),
          resourceId: id("7"),
          originWorkspaceId: id("8"),
          generation: 1,
          status: "active",
          grants: [
            {
              grantId: id("5"),
              targetWorkspaceId: id("2"),
              targetSessionId: null,
              action: "connection.use",
              mode: "always",
              context: "user_private",
              authorityEpoch: null,
              generation: 1,
              status: "active",
              expiresAt: null,
              delegation: {
                authorityId: id("4"),
                grantId: id("5"),
                organizationId: id("1"),
                workspaceId: id("2"),
                sessionId: null,
                action: "connection.use",
                mode: "always",
                context: "user_private",
                authorityEpoch: null,
                authorityGeneration: 1,
                grantGeneration: 1,
              },
            },
          ],
        },
      ],
      nextCursor: id("6"),
    });
  });
});
