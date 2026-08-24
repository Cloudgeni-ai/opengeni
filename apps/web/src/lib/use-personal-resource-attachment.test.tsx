import { afterEach, describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import {
  actRun,
  flush,
  registerDom,
  renderHook,
} from "../../../../packages/react/test/render-hook";

import { managedSelfContextIdentity } from "./managed-self-context";
import { usePersonalResourceAttachment } from "./use-personal-resource-attachment";

registerDom();
afterEach(() => document.body.replaceChildren());

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const personalWorkspaceId = "33333333-3333-4333-8333-333333333333";
const variableSetId = "44444444-4444-4444-8444-444444444444";
const workspace = { id: workspaceId, accountId: organizationId };

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

function authorityPage(active: boolean, kind: "variable_set" | "rig") {
  return {
    scope: "user" as const,
    authorities:
      active && kind === "variable_set"
        ? [
            {
              authorityId: "55555555-5555-4555-8555-555555555555",
              resourceKind: "variable_set" as const,
              resourceId: variableSetId,
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

  for (const [name, failure] of [
    ["network failure", new TypeError("network unavailable")],
    ["managed-session 401", new OpenGeniApiError(401, "unauthorized")],
  ] as const) {
    test(`${name} keeps a fixed personal-resource decision fenced with retry visible`, async () => {
      const client = {
        listVariableSets: async () => {
          throw failure;
        },
        listRigs: async () => [],
        listUserResourceAuthorities: async () => authorityPage(true, "variable_set"),
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
      expect(hook.result.current.selected.resourceCount).toBe(0);
      expect(hook.result.current.error).toBe(failure);
      expect(hook.result.current.requiresDecision).toBe(true);
      expect(hook.result.current.intent).toBeUndefined();
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
