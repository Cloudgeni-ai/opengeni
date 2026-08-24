import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, type Session } from "@opengeni/sdk";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";

import { managedSelfContextIdentity } from "./managed-self-context";
import {
  buildPersonalResourceAttachmentIntent,
  isPersonalAttachmentConflict,
  loadPersonalResourceCatalog,
  personalSelection,
  resolvePersonalResourceOwnerScope,
} from "./personal-resource-attachments";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const personalWorkspaceId = "33333333-3333-4333-8333-333333333333";
const variableSetId = "44444444-4444-4444-8444-444444444444";
const rigId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const enrollmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function personalVariableSet() {
  return {
    id: variableSetId,
    accountId: organizationId,
    workspaceId: personalWorkspaceId,
    scope: "user" as const,
    generation: 1,
    status: "active" as const,
    name: "Private deploy keys",
    description: null,
    variables: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function personalRig() {
  return {
    id: rigId,
    accountId: organizationId,
    workspaceId: personalWorkspaceId,
    scope: "user" as const,
    generation: 1,
    status: "active" as const,
    name: "Private rig",
    description: null,
    createdBy: "human",
    activeVersion: null,
    activeVersionHealth: null,
    versionCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function authority(resourceKind: "variable_set" | "rig", resourceId: string) {
  return {
    authorityId: `${resourceKind === "rig" ? "bbbbbbbb-bbbb-4bbb-8bbb" : "77777777-7777-4777-8777"}-777777777777`,
    resourceKind,
    resourceId,
    originWorkspaceId: personalWorkspaceId,
    generation: 1,
    status: "active" as const,
    grants: [],
  };
}

function ownerScope(session?: Pick<Session, "id" | "tenancy">) {
  return resolvePersonalResourceOwnerScope({
    authMode: "managedSession",
    authSession: {
      session: { id: "cookie", userId: "human", expiresAt: "2027-01-01T00:00:00.000Z" },
      user: { id: "human", name: "Human", email: "human@example.com" },
    },
    accessSubjectId: "user:human",
    managedSelfContext: {
      identity: managedSelfContextIdentity({ credentialGeneration: 7, managedUserId: "human" }),
      memberships: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          organizationId,
          status: "active",
          personalWorkspaceId,
        },
      ],
    },
    workspace: { id: workspaceId, accountId: organizationId },
    ...(session ? { session } : {}),
  });
}

describe("personal resource attachment authority", () => {
  test("requires the exact managed owner projection and rejects a shared nonowner", () => {
    expect(ownerScope()).not.toBeNull();
    expect(
      ownerScope({
        id: "66666666-6666-4666-8666-666666666666",
        tenancy: {
          visibility: "workspace",
          authorityEpoch: 2,
          ownedByCurrentUser: false,
          fork: null,
        },
      }),
    ).toBeNull();
  });

  test("joins metadata to only active exact-origin authority rows", async () => {
    const scope = ownerScope();
    if (!scope) throw new Error("fixture owner scope missing");
    const client = {
      listVariableSets: async (routeWorkspaceId: string) => {
        expect(routeWorkspaceId).toBe(personalWorkspaceId);
        return [personalVariableSet()];
      },
      listRigs: async () => [],
      listUserResourceAuthorities: async (
        routeWorkspaceId: string,
        options: { resourceKind: string },
      ) => {
        expect(routeWorkspaceId).toBe(workspaceId);
        return {
          scope: "user" as const,
          authorities:
            options.resourceKind === "variable_set"
              ? [
                  {
                    authorityId: "77777777-7777-4777-8777-777777777777",
                    resourceKind: "variable_set" as const,
                    resourceId: variableSetId,
                    originWorkspaceId: personalWorkspaceId,
                    generation: 1,
                    status: "active" as const,
                    grants: [],
                  },
                  {
                    authorityId: "88888888-8888-4888-8888-888888888888",
                    resourceKind: "variable_set" as const,
                    resourceId: "99999999-9999-4999-8999-999999999999",
                    originWorkspaceId: workspaceId,
                    generation: 1,
                    status: "active" as const,
                    grants: [],
                  },
                ]
              : [],
          nextCursor: null,
        };
      },
    } as unknown as OpenGeniCoreClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(catalog.variableSets.map((resource) => resource.name)).toEqual(["Private deploy keys"]);
    expect(catalog.variableSetAuthorities).toHaveLength(1);
    expect(catalog.rigs).toEqual([]);
  });

  test("fails closed when a fixed personal resource is missing from the authority page", async () => {
    const scope = ownerScope();
    if (!scope) throw new Error("fixture owner scope missing");
    const client = {
      listVariableSets: async () => [personalVariableSet()],
      listRigs: async () => [],
      listUserResourceAuthorities: async () => ({
        scope: "user" as const,
        authorities: [],
        nextCursor: null,
      }),
    } as unknown as OpenGeniCoreClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(
      personalSelection(catalog, { variableSetId, rigId: null, connectedMachine: null }),
    ).toMatchObject({
      personalResourceCount: 1,
      resourceCount: 0,
      closureUnverified: true,
    });
  });

  test("recognizes only an authorized selected personal Connected Machine", async () => {
    const scope = ownerScope();
    if (!scope) throw new Error("fixture owner scope missing");
    const client = {
      listVariableSets: async () => [],
      listRigs: async () => [],
      listUserResourceAuthorities: async (
        _routeWorkspaceId: string,
        options: { resourceKind: string },
      ) => ({
        scope: "user" as const,
        authorities:
          options.resourceKind === "connected_machine"
            ? [
                {
                  authorityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                  resourceKind: "connected_machine" as const,
                  resourceId: enrollmentId,
                  originWorkspaceId: workspaceId,
                  generation: 1,
                  status: "active" as const,
                  grants: [],
                },
              ]
            : [],
        nextCursor: null,
      }),
    } as unknown as OpenGeniCoreClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(
      personalSelection(catalog, {
        variableSetId: null,
        rigId: null,
        connectedMachine: { enrollmentId, name: "My Mac" },
      }),
    ).toMatchObject({
      connectedMachines: [{ enrollmentId, name: "My Mac" }],
      personalResourceCount: 1,
      resourceCount: 1,
      closureUnverified: false,
    });
  });

  test("fails closed on a partial two-resource authority observation", async () => {
    const scope = ownerScope();
    if (!scope) throw new Error("fixture owner scope missing");
    const client = {
      listVariableSets: async () => [personalVariableSet()],
      listRigs: async () => [personalRig()],
      listUserResourceAuthorities: async (
        _routeWorkspaceId: string,
        options: { resourceKind: "variable_set" | "rig" },
      ) => ({
        scope: "user" as const,
        authorities:
          options.resourceKind === "variable_set" ? [authority("variable_set", variableSetId)] : [],
        nextCursor: null,
      }),
    } as unknown as OpenGeniCoreClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(
      personalSelection(catalog, { variableSetId, rigId, connectedMachine: null }),
    ).toMatchObject({
      personalResourceCount: 2,
      resourceCount: 1,
      closureUnverified: true,
    });
  });

  test("fails closed when bounded authority pagination remains truncated", async () => {
    const scope = ownerScope();
    if (!scope) throw new Error("fixture owner scope missing");
    let variablePages = 0;
    const client = {
      listVariableSets: async () => [personalVariableSet()],
      listRigs: async () => [],
      listUserResourceAuthorities: async (
        _routeWorkspaceId: string,
        options: { resourceKind: "variable_set" | "rig" },
      ) => {
        if (options.resourceKind === "variable_set") variablePages += 1;
        return {
          scope: "user" as const,
          authorities:
            options.resourceKind === "variable_set"
              ? [authority("variable_set", variableSetId)]
              : [],
          nextCursor: options.resourceKind === "variable_set" ? `page-${variablePages}` : null,
        };
      },
    } as unknown as OpenGeniCoreClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(variablePages).toBe(4);
    expect(catalog.variableSetAuthoritiesTruncated).toBe(true);
    expect(
      personalSelection(catalog, { variableSetId, rigId: null, connectedMachine: null }),
    ).toMatchObject({
      personalResourceCount: 1,
      resourceCount: 1,
      closureUnverified: true,
    });
  });

  test("requires warning acknowledgement for shared use and binds established epoch", () => {
    expect(
      buildPersonalResourceAttachmentIntent({
        mode: "once",
        visibility: "workspace",
        acknowledged: false,
        expectedAuthorityEpoch: 3,
        resourceCount: 1,
      }),
    ).toBeUndefined();
    expect(
      buildPersonalResourceAttachmentIntent({
        mode: "session",
        visibility: "workspace",
        acknowledged: true,
        expectedAuthorityEpoch: 3,
        resourceCount: 1,
      }),
    ).toEqual({
      mode: "session",
      expectedAuthorityEpoch: 3,
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    });
  });

  test("classifies only a definitive conflict carrying personal intent", () => {
    const conflict = new OpenGeniApiError(409, "conflict", { retryable: true });
    const staleAuthority = new OpenGeniApiError(403, "forbidden", { retryable: false });
    const attempted = {
      personalResourceAttachment: {
        mode: "once" as const,
        expectedAuthorityEpoch: 2,
        workspaceSharedAcknowledged: true,
        sharedOutputWarningVersion: 1 as const,
      },
    };
    expect(isPersonalAttachmentConflict(staleAuthority, attempted)).toBe(true);
    expect(isPersonalAttachmentConflict(conflict, attempted)).toBe(true);
    expect(isPersonalAttachmentConflict(conflict, {})).toBe(false);
    expect(
      isPersonalAttachmentConflict(
        new OpenGeniApiError(409, "unknown", { outcomeUnknown: true }),
        attempted,
      ),
    ).toBe(false);
  });
});
