import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, type Session } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { managedSelfContextIdentity } from "./managed-self-context";
import {
  buildPersonalResourceAttachmentIntent,
  isPersonalAttachmentConflict,
  loadPersonalResourceCatalog,
  newSessionFixedResourceCatalogFailed,
  newSessionPersonalResourceAttachment,
  newSessionVariableSetResolutionSource,
  personalResourceSelectionIdentityKey,
  personalSelection,
  reconcileNewSessionFixedResources,
  recoverNewSessionPersonalResourceAttachment,
  resolvePersonalResourceOwnerScope,
  selectableSessionVariableSets,
} from "./personal-resource-attachments";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const personalWorkspaceId = "33333333-3333-4333-8333-333333333333";
const variableSetId = "44444444-4444-4444-8444-444444444444";
const workspaceVariableSetId = "99999999-9999-4999-8999-999999999999";
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
      session: {
        id: "cookie",
        userId: "human",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
      user: { id: "human", name: "Human", email: "human@example.com" },
    },
    accessSubjectId: "user:human",
    managedSelfContext: {
      identity: managedSelfContextIdentity({
        credentialGeneration: 7,
        managedUserId: "human",
      }),
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
  test("holds restored fixed resources until scoped catalogs settle, then reconciles authority", () => {
    expect(
      reconcileNewSessionFixedResources({
        selectedVariableSetIds: [variableSetId],
        selectedRigId: rigId,
        selectableVariableSetIds: [],
        selectableRigIds: [],
        variableSetsSettled: false,
        rigsSettled: false,
      }),
    ).toEqual({
      variableSetIds: [variableSetId],
      rigId,
      selectionResolved: false,
    });

    expect(
      reconcileNewSessionFixedResources({
        selectedVariableSetIds: [variableSetId],
        selectedRigId: rigId,
        selectableVariableSetIds: [variableSetId],
        selectableRigIds: [rigId],
        variableSetsSettled: true,
        rigsSettled: true,
      }),
    ).toEqual({
      variableSetIds: [variableSetId],
      rigId,
      selectionResolved: true,
    });

    expect(
      reconcileNewSessionFixedResources({
        selectedVariableSetIds: [variableSetId],
        selectedRigId: rigId,
        selectableVariableSetIds: [],
        selectableRigIds: [],
        variableSetsSettled: true,
        rigsSettled: true,
      }),
    ).toEqual({ variableSetIds: [], rigId: "", selectionResolved: false });
  });

  test("uses exact-id attachment resolution when metadata-list permissions are unavailable", () => {
    expect(
      newSessionVariableSetResolutionSource({
        canAttach: true,
        canUse: true,
        canListVariableSets: true,
        canListSecrets: true,
      }),
    ).toBe("catalog");
    expect(
      newSessionVariableSetResolutionSource({
        canAttach: true,
        canUse: true,
        canListVariableSets: true,
        canListSecrets: false,
      }),
    ).toBe("attachment");
    expect(
      newSessionVariableSetResolutionSource({
        canAttach: true,
        canUse: true,
        canListVariableSets: false,
        canListSecrets: true,
      }),
    ).toBe("attachment");
    expect(
      newSessionVariableSetResolutionSource({
        canAttach: false,
        canUse: true,
        canListVariableSets: true,
        canListSecrets: true,
      }),
    ).toBe("denied");
  });

  test("keys acknowledgement by typed resource identity rather than display name", () => {
    const first = personalResourceSelectionIdentityKey({
      variableSetIds: [variableSetId],
      rigId,
    });
    const replacement = personalResourceSelectionIdentityKey({
      variableSetIds: [workspaceVariableSetId],
      rigId,
    });
    expect(first).toBe([`rig:${rigId}`, `variable_set:${variableSetId}`].sort().join("\u0000"));
    expect(replacement).not.toBe(first);
  });

  test("surfaces retry only when a failed catalog blocks a restored fixed selection", () => {
    expect(
      newSessionFixedResourceCatalogFailed({
        selectedVariableSetIds: [variableSetId],
        selectedRigId: "",
        selectionResolved: false,
        variableSetCatalogFailed: true,
        rigCatalogFailed: false,
      }),
    ).toBe(true);
    expect(
      newSessionFixedResourceCatalogFailed({
        selectedVariableSetIds: [],
        selectedRigId: rigId,
        selectionResolved: false,
        variableSetCatalogFailed: false,
        rigCatalogFailed: true,
      }),
    ).toBe(true);
    expect(
      newSessionFixedResourceCatalogFailed({
        selectedVariableSetIds: [variableSetId],
        selectedRigId: "",
        selectionResolved: true,
        variableSetCatalogFailed: false,
        rigCatalogFailed: true,
      }),
    ).toBe(false);
    expect(
      newSessionFixedResourceCatalogFailed({
        selectedVariableSetIds: [],
        selectedRigId: "",
        selectionResolved: true,
        variableSetCatalogFailed: true,
        rigCatalogFailed: true,
      }),
    ).toBe(false);
  });

  test("resets acknowledgement and refreshes both catalogs after a definitive conflict", async () => {
    const events: string[] = [];
    const recovered = await recoverNewSessionPersonalResourceAttachment({
      error: new OpenGeniApiError(409, "stale personal resource"),
      attemptedInput: {
        personalResourceAttachment: {
          mode: "session",
          workspaceSharedAcknowledged: true,
          sharedOutputWarningVersion: 1,
        },
      },
      resetAcknowledgement: () => events.push("reset"),
      refreshCatalogs: async () => {
        events.push("variable_sets");
        events.push("rigs");
      },
    });
    expect(recovered).toBe(true);
    expect(events).toEqual(["reset", "variable_sets", "rigs"]);

    events.length = 0;
    expect(
      await recoverNewSessionPersonalResourceAttachment({
        error: new OpenGeniApiError(503, "temporary outage"),
        attemptedInput: {
          personalResourceAttachment: {
            mode: "session",
            workspaceSharedAcknowledged: true,
            sharedOutputWarningVersion: 1,
          },
        },
        resetAcknowledgement: () => events.push("reset"),
        refreshCatalogs: async () => {
          events.push("variable_sets");
          events.push("rigs");
        },
      }),
    ).toBe(false);
    expect(events).toEqual([]);
  });

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
    } as unknown as OpenGeniBrowserClient;

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
    } as unknown as OpenGeniBrowserClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(
      personalSelection(catalog, {
        variableSetId,
        rigId: null,
        connectedMachine: null,
      }),
    ).toMatchObject({
      personalResourceCount: 1,
      resourceCount: 0,
      closureUnverified: true,
    });
  });

  test("accepts a verified mix of workspace and personal Variable Sets", () => {
    const personal = personalVariableSet();
    const workspaceVariableSet = {
      ...personal,
      id: workspaceVariableSetId,
      workspaceId,
      scope: "workspace" as const,
      name: "Workspace defaults",
    };
    expect(
      personalSelection(
        {
          variableSets: [workspaceVariableSet, personal],
          rigs: [],
          variableSetAuthorities: [authority("variable_set", variableSetId)],
          rigAuthorities: [],
          connectedMachineAuthorities: [],
          personalVariableSets: [personal],
          personalRigs: [],
          variableSetAuthoritiesTruncated: false,
          rigAuthoritiesTruncated: false,
          connectedMachineAuthoritiesTruncated: false,
          truncated: false,
        },
        {
          variableSetIds: [workspaceVariableSetId, variableSetId],
          variableSetScopes: ["workspace", "user"],
          variableSetId,
          variableSetScope: "user",
          rigId: null,
          connectedMachine: null,
        },
      ),
    ).toMatchObject({
      personalResourceCount: 1,
      resourceCount: 2,
      closureUnverified: false,
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
    } as unknown as OpenGeniBrowserClient;

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
    } as unknown as OpenGeniBrowserClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(
      personalSelection(catalog, {
        variableSetId,
        rigId,
        connectedMachine: null,
      }),
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
    } as unknown as OpenGeniBrowserClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(variablePages).toBe(4);
    expect(catalog.variableSetAuthoritiesTruncated).toBe(true);
    expect(
      personalSelection(catalog, {
        variableSetId,
        rigId: null,
        connectedMachine: null,
      }),
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

  test("offers only attachable Variable Sets and hides unavailable personal choices", () => {
    const personal = personalVariableSet();
    const workspaceVariableSet = {
      ...personal,
      id: workspaceVariableSetId,
      workspaceId,
      scope: "workspace" as const,
      name: "Workspace defaults",
    };
    const inactivePersonal = {
      ...personal,
      id: "12121212-1212-4212-8212-121212121212",
      status: "revoked" as const,
      name: "Revoked personal set",
    };

    expect(
      selectableSessionVariableSets([workspaceVariableSet, personal, inactivePersonal], {
        canAttach: true,
        canUse: true,
        personalResourcesAvailable: false,
      }).map((variableSet) => variableSet.id),
    ).toEqual([workspaceVariableSetId]);
    expect(
      selectableSessionVariableSets([workspaceVariableSet, personal], {
        canAttach: true,
        canUse: true,
        personalResourcesAvailable: true,
      }).map((variableSet) => variableSet.id),
    ).toEqual([workspaceVariableSetId, variableSetId]);
    expect(
      selectableSessionVariableSets([workspaceVariableSet, personal], {
        canAttach: false,
        canUse: true,
        personalResourcesAvailable: true,
      }),
    ).toEqual([]);
  });

  test("authorized personal resources start private sessions with session-scoped authority", () => {
    expect(
      newSessionPersonalResourceAttachment({
        personalResourceCount: 2,
        visibility: "private",
        sharedAcknowledged: false,
      }),
    ).toEqual({
      requiresAcknowledgement: false,
      intent: {
        mode: "session",
        workspaceSharedAcknowledged: false,
        sharedOutputWarningVersion: 1,
      },
    });
  });

  test("workspace-visible personal resources use one inline acknowledgement", () => {
    expect(
      newSessionPersonalResourceAttachment({
        personalResourceCount: 1,
        visibility: "workspace",
        sharedAcknowledged: false,
      }),
    ).toEqual({ requiresAcknowledgement: true, intent: undefined });
    expect(
      newSessionPersonalResourceAttachment({
        personalResourceCount: 1,
        visibility: "workspace",
        sharedAcknowledged: true,
      }),
    ).toEqual({
      requiresAcknowledgement: false,
      intent: {
        mode: "session",
        workspaceSharedAcknowledged: true,
        sharedOutputWarningVersion: 1,
      },
    });
  });

  test("classifies only a definitive conflict carrying personal intent", () => {
    const conflict = new OpenGeniApiError(409, "conflict", { retryable: true });
    const staleAuthority = new OpenGeniApiError(403, "forbidden", {
      retryable: false,
    });
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
