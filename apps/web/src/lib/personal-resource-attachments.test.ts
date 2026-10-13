import { ongoingPersonalResourceNames } from "./personal-resource-ongoing-access";
import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, type Session, type UserResourceAuthoritySummary } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { managedSelfContextIdentity } from "./managed-self-context";
import {
  buildPersonalResourceAttachmentIntent,
  isPersonalAttachmentConflict,
  loadPersonalResourceCatalog,
  newSessionFixedResourceCatalogFailed,
  newSessionPersonalResourceAttachment,
  personalResourceSelectionIdentityKey,
  personalSelection,
  reconcileNewSessionFixedResources,
  recoverNewSessionPersonalResourceAttachment,
  resolvePersonalResourceOwnerScope,
} from "./personal-resource-attachments";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const personalWorkspaceId = "33333333-3333-4333-8333-333333333333";
const otherRigId = "99999999-9999-4999-8999-999999999999";
const rigId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const enrollmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function personalRig(originWorkspaceId = personalWorkspaceId) {
  return {
    id: rigId,
    accountId: organizationId,
    workspaceId: originWorkspaceId,
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

function authority(
  resourceKind: "rig" | "connected_machine",
  resourceId: string,
  originWorkspaceId = personalWorkspaceId,
) {
  return {
    authorityId: `${resourceKind === "rig" ? "bbbbbbbb-bbbb-4bbb-8bbb" : "77777777-7777-4777-8777"}-777777777777`,
    resourceKind,
    resourceId,
    originWorkspaceId,
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
  test("holds a restored Rig until the scoped catalog settles, then reconciles authority", () => {
    expect(
      reconcileNewSessionFixedResources({
        selectedRigId: rigId,
        selectableRigIds: [],
        rigsSettled: false,
      }),
    ).toEqual({ rigId, selectionResolved: false });

    expect(
      reconcileNewSessionFixedResources({
        selectedRigId: rigId,
        selectableRigIds: [rigId],
        rigsSettled: true,
      }),
    ).toEqual({ rigId, selectionResolved: true });

    expect(
      reconcileNewSessionFixedResources({
        selectedRigId: rigId,
        selectableRigIds: [],
        rigsSettled: true,
      }),
    ).toEqual({ rigId: "", selectionResolved: false });
  });
  test("keys acknowledgement by typed resource identity rather than display name", () => {
    const first = personalResourceSelectionIdentityKey({
      rigId,
      connectedMachineId: enrollmentId,
    });
    const replacement = personalResourceSelectionIdentityKey({
      rigId: otherRigId,
      connectedMachineId: enrollmentId,
    });
    expect(first).toBe([`rig:${rigId}`, `connected_machine:${enrollmentId}`].sort().join("\u0000"));
    expect(replacement).not.toBe(first);
  });
  test("surfaces retry only when a failed catalog blocks a restored fixed selection", () => {
    expect(
      newSessionFixedResourceCatalogFailed({
        selectedRigId: rigId,
        selectionResolved: false,
        rigCatalogFailed: true,
      }),
    ).toBe(true);
    expect(
      newSessionFixedResourceCatalogFailed({
        selectedRigId: rigId,
        selectionResolved: true,
        rigCatalogFailed: true,
      }),
    ).toBe(false);
    expect(
      newSessionFixedResourceCatalogFailed({
        selectedRigId: "",
        selectionResolved: false,
        rigCatalogFailed: true,
      }),
    ).toBe(false);
  });
  test("refreshes both catalogs after a definitive conflict", async () => {
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
      refreshCatalogs: async () => {
        events.push("rigs");
      },
    });
    expect(recovered).toBe(true);
    expect(events).toEqual(["rigs"]);

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
        refreshCatalogs: async () => {
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

  test("joins metadata to active authority rows using each resource's exact origin", async () => {
    const scope = ownerScope();
    if (!scope) throw new Error("fixture owner scope missing");
    const client = {
      listRigs: async (routeWorkspaceId: string) => {
        expect(routeWorkspaceId).toBe(workspaceId);
        return [personalRig(workspaceId)];
      },
      listUserResourceAuthorities: async (
        routeWorkspaceId: string,
        options: { resourceKind: string },
      ) => {
        expect(routeWorkspaceId).toBe(workspaceId);
        return {
          scope: "user" as const,
          authorities:
            options.resourceKind === "rig"
              ? [
                  authority("rig", rigId, workspaceId),
                  {
                    ...authority("rig", rigId, personalWorkspaceId),
                    authorityId: "88888888-8888-4888-8888-888888888888",
                  },
                ]
              : [],
          nextCursor: null,
        };
      },
    } as unknown as OpenGeniBrowserClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(catalog.rigs.map((resource) => resource.name)).toEqual(["Private rig"]);
    expect(catalog.rigAuthorities).toHaveLength(1);
    expect(catalog.rigAuthorities[0]?.originWorkspaceId).toBe(workspaceId);
    expect(catalog.connectedMachineAuthorities).toEqual([]);
  });
  test("fails closed when a fixed personal resource is missing from the authority page", async () => {
    const scope = ownerScope();
    if (!scope) throw new Error("fixture owner scope missing");
    const client = {
      listRigs: async () => [personalRig()],
      listUserResourceAuthorities: async () => ({
        scope: "user" as const,
        authorities: [],
        nextCursor: null,
      }),
    } as unknown as OpenGeniBrowserClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(
      personalSelection(catalog, {
        rigId,
        connectedMachine: null,
      }),
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
      listRigs: async () => [personalRig()],
      listUserResourceAuthorities: async (
        _routeWorkspaceId: string,
        options: { resourceKind: "rig" | "connected_machine" },
      ) => ({
        scope: "user" as const,
        authorities: options.resourceKind === "rig" ? [authority("rig", rigId)] : [],
        nextCursor: null,
      }),
    } as unknown as OpenGeniBrowserClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(
      personalSelection(catalog, {
        rigId,
        connectedMachine: { enrollmentId, name: "My Mac" },
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
    let rigPages = 0;
    const client = {
      listRigs: async () => [personalRig()],
      listUserResourceAuthorities: async (
        _routeWorkspaceId: string,
        options: { resourceKind: "rig" | "connected_machine" },
      ) => {
        if (options.resourceKind === "rig") rigPages += 1;
        return {
          scope: "user" as const,
          authorities: options.resourceKind === "rig" ? [authority("rig", rigId)] : [],
          nextCursor: options.resourceKind === "rig" ? `page-${rigPages}` : null,
        };
      },
    } as unknown as OpenGeniBrowserClient;

    const catalog = await loadPersonalResourceCatalog(client, scope);
    expect(rigPages).toBe(4);
    expect(catalog.rigAuthoritiesTruncated).toBe(true);
    expect(
      personalSelection(catalog, {
        rigId,
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

  test("authorized personal resources start private sessions with session-scoped authority", () => {
    expect(
      newSessionPersonalResourceAttachment({
        personalResourceCount: 2,
        visibility: "private",
      }),
    ).toEqual({
      intent: {
        mode: "session",
        workspaceSharedAcknowledged: false,
        sharedOutputWarningVersion: 1,
      },
    });
  });

  test("workspace-visible personal attachments authorize ongoing work without a second toggle", () => {
    expect(
      newSessionPersonalResourceAttachment({
        personalResourceCount: 1,
        visibility: "workspace",
      }),
    ).toEqual({
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

test("shared new sessions authorize only selected personal resources for ongoing work", () => {
  const input = { personalResourceCount: 1, visibility: "workspace" as const };
  expect(newSessionPersonalResourceAttachment(input).intent).toEqual({
    mode: "session",
    workspaceSharedAcknowledged: true,
    sharedOutputWarningVersion: 1,
  });
  expect(
    newSessionPersonalResourceAttachment({ ...input, personalResourceCount: 0 }).intent,
  ).toBeUndefined();
});

test("ongoing authorization cue requires exact current grant metadata", () => {
  const item: UserResourceAuthoritySummary = {
    ...authority("rig", rigId),
    grants: [],
  };
  const sessionId = "99999999-9999-4999-8999-999999999999";
  const grant = {
    grantId: "grant",
    targetWorkspaceId: workspaceId,
    targetSessionId: sessionId,
    action: "rig.use" as const,
    mode: "session" as const,
    context: "workspace_shared" as const,
    authorityEpoch: 3,
    generation: 2,
    status: "active" as const,
    expiresAt: "2026-10-01T00:00:00Z",
    delegation: {
      authorityId: item.authorityId,
      grantId: "grant",
      organizationId,
      workspaceId,
      sessionId,
      action: "rig.use",
      mode: "session" as const,
      context: "workspace_shared" as const,
      authorityEpoch: 3,
      authorityGeneration: 1,
      grantGeneration: 2,
    },
  };
  item.grants = [grant];
  const input = {
    authorities: [item],
    resources: [{ kind: "rig" as const, id: rigId, name: "PR access" }],
    organizationId,
    workspaceId,
    sessionId,
    authorityEpoch: 3,
    now: Date.parse("2026-09-07T00:00:00Z"),
  };
  expect(ongoingPersonalResourceNames(input)).toEqual(["PR access"]);
  for (const mutate of [
    (value: UserResourceAuthoritySummary) => {
      value.status = "revoked";
    },
    (value: UserResourceAuthoritySummary) => {
      value.generation = 2;
    },
    (value: UserResourceAuthoritySummary) => {
      value.grants[0]!.status = "consumed";
    },
    (value: UserResourceAuthoritySummary) => {
      value.grants[0]!.mode = "once";
    },
    (value: UserResourceAuthoritySummary) => {
      value.grants[0]!.targetWorkspaceId = "other";
    },
    (value: UserResourceAuthoritySummary) => {
      value.grants[0]!.targetSessionId = "other";
    },
    (value: UserResourceAuthoritySummary) => {
      value.grants[0]!.authorityEpoch = 4;
    },
    (value: UserResourceAuthoritySummary) => {
      value.grants[0]!.generation = 3;
    },
    (value: UserResourceAuthoritySummary) => {
      value.grants[0]!.expiresAt = "2026-09-01T00:00:00Z";
    },
    (value: UserResourceAuthoritySummary) => {
      value.grants[0]!.delegation.organizationId = "other";
    },
  ]) {
    const altered = structuredClone(item);
    mutate(altered);
    expect(ongoingPersonalResourceNames({ ...input, authorities: [altered] })).toEqual([]);
  }
});
