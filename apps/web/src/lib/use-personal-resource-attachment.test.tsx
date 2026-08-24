import { afterEach, describe, expect, test } from "bun:test";
import { OpenGeniApiError, type ResourceAuthorityScope } from "@opengeni/sdk";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import {
  actRun,
  flush,
  registerDom,
  renderHook,
} from "../../../../packages/react/test/render-hook";

import { managedSelfContextIdentity } from "./managed-self-context";
import {
  useFixedResourceScopes,
  usePersonalResourceAttachment,
} from "./use-personal-resource-attachment";

registerDom();
afterEach(() => document.body.replaceChildren());

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const personalWorkspaceId = "33333333-3333-4333-8333-333333333333";
const variableSetId = "44444444-4444-4444-8444-444444444444";
const rigId = "77777777-7777-4777-8777-777777777777";
const workspace = { id: workspaceId, accountId: organizationId };
type ResourceKind = "variable_set" | "rig";

function identity(principal: string) {
  return {
    authSession: {
      session: { id: `cookie-${principal}`, userId: principal, expiresAt: "2027-01-01T00:00:00Z" },
      user: { id: principal, name: principal, email: `${principal}@example.com` },
    },
    managedSelfContext: {
      identity: managedSelfContextIdentity({ credentialGeneration: 7, managedUserId: principal }),
      memberships: [
        {
          id: `membership-${principal}`,
          organizationId,
          status: "active" as const,
          personalWorkspaceId,
        },
      ],
    },
  };
}

function variableSet() {
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
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function rig() {
  return {
    id: rigId,
    accountId: organizationId,
    workspaceId: personalWorkspaceId,
    scope: "user" as const,
    generation: 1,
    status: "active" as const,
    name: "Private rig",
    description: null,
    createdBy: "user:owner",
    activeVersion: null,
    activeVersionHealth: null,
    versionCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function fixedResource(kind: ResourceKind, scope?: ResourceAuthorityScope | null) {
  return kind === "variable_set"
    ? { variableSetId, variableSetScope: scope, rigId: null, connectedMachine: null }
    : { variableSetId: null, rigId, rigScope: scope, connectedMachine: null };
}

function authorityPage(active: boolean, kind: ResourceKind) {
  return {
    scope: "user" as const,
    authorities: active
      ? [
          {
            authorityId: "55555555-5555-4555-8555-555555555555",
            resourceKind: kind,
            resourceId: kind === "variable_set" ? variableSetId : rigId,
            originWorkspaceId: personalWorkspaceId,
            generation: 1,
            status: "active" as const,
            grants: [],
          },
        ]
      : [],
    nextCursor: null,
  };
}

function personalClient(input?: { active?: boolean; failure?: Error | null }): OpenGeniCoreClient {
  return {
    listVariableSets: async () => {
      if (input?.failure) throw input.failure;
      return input?.active === false ? [] : [variableSet()];
    },
    listRigs: async () => {
      if (input?.failure) throw input.failure;
      return input?.active === false ? [] : [rig()];
    },
    listUserResourceAuthorities: async (
      _workspaceId: string,
      options: { resourceKind: ResourceKind },
    ) => {
      if (input?.failure) throw input.failure;
      return authorityPage(input?.active !== false, options.resourceKind);
    },
  } as unknown as OpenGeniCoreClient;
}

describe("useFixedResourceScopes", () => {
  test("classifies both fixed resource kinds through exact ordinary catalog reads", async () => {
    const requested: string[] = [];
    const client = {
      getVariableSet: async (requestedWorkspaceId: string, requestedId: string) => {
        requested.push(`variable_set:${requestedWorkspaceId}:${requestedId}`);
        return { ...variableSet(), scope: "organization" as const };
      },
      getRig: async (requestedWorkspaceId: string, requestedId: string) => {
        requested.push(`rig:${requestedWorkspaceId}:${requestedId}`);
        return { ...rig(), scope: "workspace" as const };
      },
    } as unknown as OpenGeniCoreClient;
    const hook = await renderHook(
      () => useFixedResourceScopes(client, workspaceId, variableSetId, rigId),
      undefined,
    );
    await flush();
    expect(requested).toEqual([
      `variable_set:${workspaceId}:${variableSetId}`,
      `rig:${workspaceId}:${rigId}`,
    ]);
    expect(hook.result.current).toEqual(["organization", "workspace"]);
    await hook.unmount();
  });

  test("fails closed to unknown without retaining another route's classification", async () => {
    const client = {
      getVariableSet: async (requestedWorkspaceId: string) => {
        if (requestedWorkspaceId !== workspaceId) throw new Error("ordinary catalog unavailable");
        return { ...variableSet(), scope: "user" as const };
      },
    } as unknown as OpenGeniCoreClient;
    const hook = await renderHook(
      ({ routedWorkspaceId }: { routedWorkspaceId: string }) =>
        useFixedResourceScopes(client, routedWorkspaceId, variableSetId, null),
      { routedWorkspaceId: workspaceId },
    );
    await flush();
    expect(hook.result.current[0]).toBe("user");
    await hook.rerender({ routedWorkspaceId: personalWorkspaceId });
    expect(hook.result.current[0]).toBeNull();
    await flush();
    expect(hook.result.current[0]).toBeNull();
    await hook.unmount();
  });
});

describe("usePersonalResourceAttachment", () => {
  test("discovers personal options without surfacing authority failure when nothing is selected", async () => {
    let calls = 0;
    const client = {
      listVariableSets: async () => {
        calls += 1;
        throw new Error("personal catalog unavailable");
      },
      listRigs: async () => {
        calls += 1;
        throw new Error("personal catalog unavailable");
      },
      listUserResourceAuthorities: async () => {
        calls += 1;
        throw new Error("personal catalog unavailable");
      },
    } as unknown as OpenGeniCoreClient;
    const current = identity("owner");
    const hook = await renderHook(
      () =>
        usePersonalResourceAttachment({
          client,
          authMode: "managedSession",
          authSession: current.authSession,
          accessSubjectId: "user:owner",
          managedSelfContext: current.managedSelfContext,
          workspace,
          fixed: { variableSetId: null, rigId: null, connectedMachine: null },
          personalWorkspaceTarget: false,
        }),
      undefined,
    );
    await flush();
    expect(calls).toBeGreaterThan(0);
    expect(hook.result.current.eligible).toBe(true);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.requiresDecision).toBe(false);
    await hook.unmount();
  });

  test("drops a late owner response after the authenticated principal changes", async () => {
    let resolveVariable!: (value: ReturnType<typeof authorityPage>) => void;
    let resolveRig!: (value: ReturnType<typeof authorityPage>) => void;
    const variablePromise = new Promise<ReturnType<typeof authorityPage>>(
      (resolve) => (resolveVariable = resolve),
    );
    const rigPromise = new Promise<ReturnType<typeof authorityPage>>(
      (resolve) => (resolveRig = resolve),
    );
    const client = {
      listVariableSets: async () => [variableSet()],
      listRigs: async () => [],
      listUserResourceAuthorities: async (
        _workspaceId: string,
        options: { resourceKind: string },
      ) => (options.resourceKind === "variable_set" ? variablePromise : rigPromise),
    } as unknown as OpenGeniCoreClient;
    const hook = await renderHook(
      ({ principal }: { principal: string }) => {
        const current = identity(principal);
        return usePersonalResourceAttachment({
          client,
          authMode: "managedSession",
          authSession: current.authSession,
          accessSubjectId: `user:${principal}`,
          managedSelfContext: principal === "shared-user" ? null : current.managedSelfContext,
          workspace,
          fixed: { variableSetId, rigId: null, connectedMachine: null },
          personalWorkspaceTarget: false,
        });
      },
      { principal: "owner" },
    );
    await hook.rerender({ principal: "shared-user" });
    await actRun(() => {
      resolveVariable(authorityPage(true, "variable_set"));
      resolveRig(authorityPage(false, "rig"));
    });
    await flush();
    expect(hook.result.current.catalog).toBeNull();
    expect(hook.result.current.selected.resourceCount).toBe(0);
    expect(hook.result.current.mode).toBeNull();
    await hook.unmount();
  });

  test("an authoritative refresh that loses the fixed source clears and fences the decision", async () => {
    let active = true;
    const client = {
      listVariableSets: async () => [variableSet()],
      listRigs: async () => [],
      listUserResourceAuthorities: async (
        _workspaceId: string,
        options: { resourceKind: string },
      ) => authorityPage(active, options.resourceKind as "variable_set" | "rig"),
    } as unknown as OpenGeniCoreClient;
    const current = identity("owner");
    const hook = await renderHook(
      () =>
        usePersonalResourceAttachment({
          client,
          authMode: "managedSession",
          authSession: current.authSession,
          accessSubjectId: "user:owner",
          managedSelfContext: current.managedSelfContext,
          workspace,
          fixed: { variableSetId, rigId: null, connectedMachine: null },
          personalWorkspaceTarget: false,
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.selected.resourceCount).toBe(1);
    await actRun(() => hook.result.current.setMode("session"));
    await actRun(() => hook.result.current.setAcknowledged(true));
    expect(hook.result.current.intent?.mode).toBe("session");

    active = false;
    await actRun(() => hook.result.current.refresh());
    await flush();
    expect(hook.result.current.sourceLost).toBe(true);
    expect(hook.result.current.requiresDecision).toBe(true);
    expect(hook.result.current.intent).toBeUndefined();
    expect(hook.result.current.mode).toBeNull();
    await hook.unmount();
  });

  test("a definitive stale-authority denial reloads the session and requires reconfirmation", async () => {
    let sessionReloads = 0;
    const client = {
      listVariableSets: async () => [variableSet()],
      listRigs: async () => [],
      listUserResourceAuthorities: async (
        _workspaceId: string,
        options: { resourceKind: string },
      ) => authorityPage(true, options.resourceKind as "variable_set" | "rig"),
    } as unknown as OpenGeniCoreClient;
    const current = identity("owner");
    const hook = await renderHook(
      () =>
        usePersonalResourceAttachment({
          client,
          authMode: "managedSession",
          authSession: current.authSession,
          accessSubjectId: "user:owner",
          managedSelfContext: current.managedSelfContext,
          workspace,
          session: {
            id: "66666666-6666-4666-8666-666666666666",
            tenancy: {
              visibility: "workspace",
              authorityEpoch: 3,
              ownedByCurrentUser: true,
              fork: null,
            },
          },
          fixed: { variableSetId, rigId: null, connectedMachine: null },
          personalWorkspaceTarget: false,
          onReloadSession: async () => {
            sessionReloads += 1;
          },
        }),
      undefined,
    );
    await flush();
    await actRun(() => hook.result.current.setMode("always"));
    await actRun(() => hook.result.current.setAcknowledged(true));
    const attempted = {
      text: "Deploy",
      personalResourceAttachment: hook.result.current.intent,
    };
    expect(attempted.personalResourceAttachment?.expectedAuthorityEpoch).toBe(3);

    await actRun(() =>
      hook.result.current.onDeliveryError(
        new OpenGeniApiError(403, "forbidden", { mutation: true }),
        attempted,
        "send",
      ),
    );
    await flush();
    expect(sessionReloads).toBe(1);
    expect(hook.result.current.mode).toBeNull();
    expect(hook.result.current.intent).toBeUndefined();
    expect(hook.result.current.requiresDecision).toBe(true);
    expect(hook.result.current.notice).toContain("Session authority changed");
    await hook.unmount();
  });

  test("a selected personal Connected Machine requires and produces an attachment decision", async () => {
    const enrollmentId = "99999999-9999-4999-8999-999999999999";
    const client = {
      listVariableSets: async () => [],
      listRigs: async () => [],
      listUserResourceAuthorities: async (
        _workspaceId: string,
        options: { resourceKind: string },
      ) => ({
        scope: "user" as const,
        authorities:
          options.resourceKind === "connected_machine"
            ? [
                {
                  authorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
    const current = identity("owner");
    const hook = await renderHook(
      () =>
        usePersonalResourceAttachment({
          client,
          authMode: "managedSession",
          authSession: current.authSession,
          accessSubjectId: "user:owner",
          managedSelfContext: current.managedSelfContext,
          workspace,
          fixed: {
            variableSetId: null,
            rigId: null,
            connectedMachine: { enrollmentId, name: "Owner Mac" },
          },
          personalWorkspaceTarget: false,
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.selected.connectedMachines).toEqual([
      { enrollmentId, name: "Owner Mac" },
    ]);
    expect(hook.result.current.requiresDecision).toBe(true);
    expect(hook.result.current.intent).toBeUndefined();

    await actRun(() => hook.result.current.setMode("once"));
    expect(hook.result.current.requiresDecision).toBe(true);
    await actRun(() => hook.result.current.setAcknowledged(true));
    expect(hook.result.current.requiresDecision).toBe(false);
    expect(hook.result.current.intent).toMatchObject({
      mode: "once",
      workspaceSharedAcknowledged: true,
    });
    await hook.unmount();
  });

  for (const kind of ["variable_set", "rig"] as const) {
    const label = kind === "variable_set" ? "Variable Set" : "Rig";

    for (const scope of ["organization", "workspace"] as const) {
      test(`${scope} ${label} never exposes a Personal catalog failure`, async () => {
        const failure = new Error("personal catalog unavailable");
        const client = personalClient({ failure });
        const current = identity("owner");
        const hook = await renderHook(
          () =>
            usePersonalResourceAttachment({
              client,
              authMode: "managedSession",
              authSession: current.authSession,
              accessSubjectId: "user:owner",
              managedSelfContext: current.managedSelfContext,
              workspace,
              fixed: fixedResource(kind, scope),
              personalWorkspaceTarget: false,
            }),
          undefined,
        );
        await flush();
        expect(hook.result.current.eligible).toBe(true);
        expect(hook.result.current.loading).toBe(false);
        expect(hook.result.current.error).toBeNull();
        expect(hook.result.current.selected.resourceCount).toBe(0);
        expect(hook.result.current.requiresDecision).toBe(false);
        expect(hook.result.current.intent).toBeUndefined();
        await hook.unmount();
      });
    }

    test(`personal ${label} positively identifies the selection and requires a decision`, async () => {
      const client = personalClient();
      const current = identity("owner");
      const hook = await renderHook(
        () =>
          usePersonalResourceAttachment({
            client,
            authMode: "managedSession",
            authSession: current.authSession,
            accessSubjectId: "user:owner",
            managedSelfContext: current.managedSelfContext,
            workspace,
            fixed: fixedResource(kind, "user"),
            personalWorkspaceTarget: false,
          }),
        undefined,
      );
      await flush();
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.selected.resourceCount).toBe(1);
      expect(hook.result.current.selected.personalResourceCount).toBe(1);
      expect(hook.result.current.requiresDecision).toBe(true);
      await hook.unmount();
    });

    test(`absent ${label} stays inert when neither catalog identifies it`, async () => {
      const client = personalClient({ active: false });
      const current = identity("owner");
      const hook = await renderHook(
        () =>
          usePersonalResourceAttachment({
            client,
            authMode: "managedSession",
            authSession: current.authSession,
            accessSubjectId: "user:owner",
            managedSelfContext: current.managedSelfContext,
            workspace,
            fixed: fixedResource(kind, null),
            personalWorkspaceTarget: false,
          }),
        undefined,
      );
      await flush();
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.selected.resourceCount).toBe(0);
      expect(hook.result.current.requiresDecision).toBe(false);
      expect(hook.result.current.intent).toBeUndefined();
      await hook.unmount();
    });

    test(`forbidden personal ${label} surfaces the retryable fence`, async () => {
      const failure = new OpenGeniApiError(403, "forbidden");
      const client = personalClient({ failure });
      const current = identity("owner");
      const hook = await renderHook(
        () =>
          usePersonalResourceAttachment({
            client,
            authMode: "managedSession",
            authSession: current.authSession,
            accessSubjectId: "user:owner",
            managedSelfContext: current.managedSelfContext,
            workspace,
            fixed: fixedResource(kind, "user"),
            personalWorkspaceTarget: false,
          }),
        undefined,
      );
      await flush();
      expect(hook.result.current.error).toBe(failure);
      expect(hook.result.current.selected.resourceCount).toBe(0);
      expect(hook.result.current.requiresDecision).toBe(true);
      expect(hook.result.current.intent).toBeUndefined();
      await hook.unmount();
    });

    test(`pre-activation ${label} stays ineligible and performs no Personal lookup`, async () => {
      let calls = 0;
      const current = identity("owner");
      const client = {
        listVariableSets: async () => {
          calls += 1;
          throw new Error("must remain inert");
        },
        listRigs: async () => {
          calls += 1;
          throw new Error("must remain inert");
        },
        listUserResourceAuthorities: async () => {
          calls += 1;
          throw new Error("must remain inert");
        },
      } as unknown as OpenGeniCoreClient;
      const hook = await renderHook(
        () =>
          usePersonalResourceAttachment({
            client,
            authMode: "managedSession",
            authSession: current.authSession,
            accessSubjectId: "user:owner",
            managedSelfContext: { ...current.managedSelfContext, memberships: [] },
            workspace,
            fixed: fixedResource(kind, "user"),
            personalWorkspaceTarget: false,
          }),
        undefined,
      );
      await flush();
      expect(calls).toBe(0);
      expect(hook.result.current.eligible).toBe(false);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.requiresDecision).toBe(false);
      await hook.unmount();
    });

    test(`personal ${label} refresh failure retains identity and fences submission`, async () => {
      let failure: Error | null = null;
      const client = {
        listVariableSets: async () => {
          if (failure) throw failure;
          return [variableSet()];
        },
        listRigs: async () => {
          if (failure) throw failure;
          return [rig()];
        },
        listUserResourceAuthorities: async (
          _workspaceId: string,
          options: { resourceKind: ResourceKind },
        ) => {
          if (failure) throw failure;
          return authorityPage(true, options.resourceKind);
        },
      } as unknown as OpenGeniCoreClient;
      const current = identity("owner");
      const hook = await renderHook(
        () =>
          usePersonalResourceAttachment({
            client,
            authMode: "managedSession",
            authSession: current.authSession,
            accessSubjectId: "user:owner",
            managedSelfContext: current.managedSelfContext,
            workspace,
            fixed: fixedResource(kind, "user"),
            personalWorkspaceTarget: false,
          }),
        undefined,
      );
      await flush();
      expect(hook.result.current.selected.resourceCount).toBe(1);
      failure = new Error("refresh unavailable");
      await actRun(() => hook.result.current.refresh());
      await flush();
      expect(hook.result.current.error).toBe(failure);
      expect(hook.result.current.selected.resourceCount).toBe(1);
      expect(hook.result.current.requiresDecision).toBe(true);
      expect(hook.result.current.intent).toBeUndefined();
      await hook.unmount();
    });

    test(`personal ${label} retry clears the failure and restores the decision`, async () => {
      let failing = true;
      const client = {
        listVariableSets: async () => {
          if (failing) throw new Error("initial failure");
          return [variableSet()];
        },
        listRigs: async () => {
          if (failing) throw new Error("initial failure");
          return [rig()];
        },
        listUserResourceAuthorities: async (
          _workspaceId: string,
          options: { resourceKind: ResourceKind },
        ) => {
          if (failing) throw new Error("initial failure");
          return authorityPage(true, options.resourceKind);
        },
      } as unknown as OpenGeniCoreClient;
      const current = identity("owner");
      const hook = await renderHook(
        () =>
          usePersonalResourceAttachment({
            client,
            authMode: "managedSession",
            authSession: current.authSession,
            accessSubjectId: "user:owner",
            managedSelfContext: current.managedSelfContext,
            workspace,
            fixed: fixedResource(kind, "user"),
            personalWorkspaceTarget: false,
          }),
        undefined,
      );
      await flush();
      expect(hook.result.current.error).toBeInstanceOf(Error);
      expect(hook.result.current.requiresDecision).toBe(true);
      failing = false;
      await actRun(() => hook.result.current.refresh());
      await flush();
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.selected.resourceCount).toBe(1);
      expect(hook.result.current.requiresDecision).toBe(true);
      await hook.unmount();
    });
  }

  test("disabling the managed-sandbox attachment lane clears a hidden decision", async () => {
    const client = {
      listVariableSets: async () => [variableSet()],
      listRigs: async () => [],
      listUserResourceAuthorities: async (
        _workspaceId: string,
        options: { resourceKind: string },
      ) => authorityPage(true, options.resourceKind as "variable_set" | "rig"),
    } as unknown as OpenGeniCoreClient;
    const current = identity("owner");
    const hook = await renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePersonalResourceAttachment({
          client,
          authMode: "managedSession",
          authSession: current.authSession,
          accessSubjectId: "user:owner",
          managedSelfContext: current.managedSelfContext,
          workspace,
          fixed: { variableSetId, rigId: null, connectedMachine: null },
          personalWorkspaceTarget: false,
          enabled,
        }),
      { enabled: true },
    );
    await flush();
    await actRun(() => hook.result.current.setMode("session"));
    await actRun(() => hook.result.current.setAcknowledged(true));
    expect(hook.result.current.intent).toBeDefined();

    await hook.rerender({ enabled: false });
    await flush();
    expect(hook.result.current.eligible).toBe(false);
    expect(hook.result.current.mode).toBeNull();
    expect(hook.result.current.intent).toBeUndefined();

    await hook.rerender({ enabled: true });
    await flush();
    expect(hook.result.current.mode).toBeNull();
    expect(hook.result.current.requiresDecision).toBe(true);
    await hook.unmount();
  });
});
