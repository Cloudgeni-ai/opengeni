import { describe, expect, test } from "bun:test";

import {
  resolveAuthorizedWorkspaceFallback,
  workspaceSessionIdFromPath,
} from "./authorized-route-recovery";
import type { AccessContext, Workspace } from "@/types";

const requestedWorkspaceId = "11111111-1111-4111-8111-111111111111";
const fallbackWorkspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
const accountId = "44444444-4444-4444-8444-444444444444";
const subjectId = "user:ada";

function workspace(id: string): Workspace {
  return {
    id,
    accountId,
    kind: "shared",
    name: id === fallbackWorkspaceId ? "Default" : "Other",
    slug: null,
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    defaultRigId: null,
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
  };
}

function context(permissions: Record<string, string[]>): AccessContext {
  return {
    mode: "managed",
    subjectId,
    accountGrants: [],
    workspaceGrants: Object.entries(permissions).map(([workspaceId, values]) => ({
      workspaceId,
      accountId,
      subjectId,
      permissions: values,
    })) as AccessContext["workspaceGrants"],
    defaultAccountId: accountId,
    defaultWorkspaceId: fallbackWorkspaceId,
  };
}

const location = (pathname: string) => ({ pathname, search: "?view=mine", hash: "#heading" });

describe("authorized workspace route recovery", () => {
  test("canonicalizes a stale list route to the authorized default and preserves URL state", () => {
    expect(
      resolveAuthorizedWorkspaceFallback({
        requestedWorkspaceId,
        location: location(`/workspaces/${requestedWorkspaceId}/rigs`),
        workspaces: [workspace(otherWorkspaceId), workspace(fallbackWorkspaceId)],
        accessContext: context({
          [fallbackWorkspaceId]: ["rigs:use"],
          [otherWorkspaceId]: ["workspace:read"],
        }),
      }),
    ).toEqual({
      workspaceId: fallbackWorkspaceId,
      target: `/workspaces/${fallbackWorkspaceId}/rigs?view=mine#heading`,
    });
  });

  test("requires both a server-listed workspace and an exact matching grant", () => {
    expect(
      resolveAuthorizedWorkspaceFallback({
        requestedWorkspaceId,
        location: location(`/workspaces/${requestedWorkspaceId}/machines`),
        workspaces: [workspace(fallbackWorkspaceId)],
        accessContext: context({ [otherWorkspaceId]: ["enrollments:read"] }),
      }),
    ).toBeNull();
  });

  test("does not carry resource or session detail identities across workspaces", () => {
    for (const pathname of [
      `/workspaces/${requestedWorkspaceId}/rigs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      `/workspaces/${requestedWorkspaceId}/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      `/workspaces/${requestedWorkspaceId}/artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    ]) {
      expect(
        resolveAuthorizedWorkspaceFallback({
          requestedWorkspaceId,
          location: location(pathname),
          workspaces: [workspace(fallbackWorkspaceId)],
          accessContext: context({ [fallbackWorkspaceId]: ["workspace:admin"] }),
        }),
      ).toBeNull();
    }
  });

  test("keeps a safe unavailable state when no listed destination has route permission", () => {
    expect(
      resolveAuthorizedWorkspaceFallback({
        requestedWorkspaceId,
        location: location(`/workspaces/${requestedWorkspaceId}/variable-sets`),
        workspaces: [workspace(fallbackWorkspaceId)],
        accessContext: context({ [fallbackWorkspaceId]: ["sessions:read"] }),
      }),
    ).toBeNull();

    expect(
      resolveAuthorizedWorkspaceFallback({
        requestedWorkspaceId,
        location: location(`/workspaces/${requestedWorkspaceId}/variable-sets`),
        workspaces: [workspace(fallbackWorkspaceId)],
        accessContext: context({ [fallbackWorkspaceId]: ["variable-sets:list"] }),
      }),
    ).toBeNull();
  });

  test("extracts only an exact workspace session detail identity", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(
      workspaceSessionIdFromPath(`/workspaces/${requestedWorkspaceId}/sessions/${sessionId}`),
    ).toBe(sessionId);
    expect(
      workspaceSessionIdFromPath(`/workspaces/${requestedWorkspaceId}/sessions/${sessionId}/edit`),
    ).toBeNull();
    expect(workspaceSessionIdFromPath(`/workspaces/${requestedWorkspaceId}/sessions`)).toBeNull();
  });
});
