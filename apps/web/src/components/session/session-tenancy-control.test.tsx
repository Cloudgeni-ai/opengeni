import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError, type Session } from "@opengeni/sdk";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import {
  SessionTenancyOperationController,
  type SessionTenancyOperationScope,
} from "@/lib/session-tenancy-operation-controller";

const toastSuccess = mock((_message: string) => undefined);
const toastInfo = mock((_message: string) => undefined);

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    {
      error: mock((_message: string) => undefined),
      info: toastInfo,
      success: toastSuccess,
    },
  ),
}));

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    confirmLabel,
    description,
    onConfirm,
    open,
    title,
  }: {
    confirmLabel: string;
    description?: ReactNode;
    onConfirm: () => unknown;
    open: boolean;
    title: ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <span>{title}</span>
        <span>{description}</span>
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

const { SessionTenancyControl } = await import("./session-tenancy-control");

const baseSession = {
  id: "session-a",
  workspaceId: "workspace-a",
  accountId: "organization-a",
  status: "idle",
  initialMessage: "Inspect the tenancy boundary",
  title: "Tenancy audit",
  titleSource: "user",
  tenancy: {
    visibility: "workspace",
    authorityEpoch: 4,
    ownedByCurrentUser: true,
    fork: null,
  },
} as Session;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function operationAuthority(
  controller = new SessionTenancyOperationController(),
  scope: Partial<SessionTenancyOperationScope> = {},
) {
  return {
    operationController: controller,
    operationScope: {
      principalId: "principal-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      workspaceTransitionRevision: 1,
      ...scope,
    },
  };
}

function apiError(input: {
  status: number;
  code: string;
  reason?: string;
  blocker?: string;
  outcomeUnknown?: boolean;
}) {
  return new OpenGeniApiError(
    input.status,
    JSON.stringify({
      error: {
        code: input.code,
        message: "tenancy failure",
        retryable: false,
        ...(input.outcomeUnknown ? { outcomeUnknown: true } : {}),
        ...(input.reason
          ? {
              details: {
                reason: input.reason,
                ...(input.blocker ? { blocker: input.blocker } : {}),
              },
            }
          : {}),
      },
    }),
    { mutation: true },
  );
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return found;
}

function dialogButton(container: HTMLElement, label: string): HTMLButtonElement {
  const dialog = container.querySelector('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) throw new Error("Missing confirmation dialog");
  return button(dialog, label);
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  toastInfo.mockClear();
  toastSuccess.mockClear();
});

describe("SessionTenancyControl", () => {
  test("renders only activated tenancy and keeps nonowners read-only", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const common = {
      client: {} as OpenGeniCoreClient,
      managedSession: true,
      scopeLabel: "Engineering",
      captureWorkspaceInvocation: () => ({ workspaceId: "workspace-a", revision: 1 }),
      ownsWorkspaceInvocation: () => true,
      ...operationAuthority(),
      onRefreshSession: async () => undefined,
      onOpenSession: () => undefined,
    };

    await act(async () => {
      root.render(
        <SessionTenancyControl {...common} session={{ ...baseSession, tenancy: undefined }} />,
      );
    });
    expect(container.textContent).toBe("");

    await act(async () => {
      root.render(
        <SessionTenancyControl
          {...common}
          session={{
            ...baseSession,
            tenancy: { ...baseSession.tenancy!, ownedByCurrentUser: false },
          }}
        />,
      );
    });
    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).not.toContain("Make private");
    expect(container.textContent).not.toContain("Private copy");

    await act(async () => root.unmount());
    container.remove();
  });

  test("retains one key across a blocker retry and reconciles the replay", async () => {
    const keys: string[] = [];
    let updateCalls = 0;
    let reads = 0;
    const updateSessionVisibility = mock(async (_workspaceId, _sessionId, request) => {
      keys.push(request.idempotencyKey);
      updateCalls += 1;
      if (updateCalls === 1) {
        throw apiError({
          status: 409,
          code: "conflict",
          reason: "not_quiescent",
          blocker: "active_sandbox_access",
        });
      }
      return {
        operationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        eventSequence: 8,
        visibility: "private" as const,
        authorityEpoch: 5,
        changed: true,
        replay: true,
        revokedGrantCount: 0,
      };
    });
    const getSession = mock(async () => {
      reads += 1;
      return reads === 1
        ? baseSession
        : {
            ...baseSession,
            tenancy: { ...baseSession.tenancy!, visibility: "private" as const, authorityEpoch: 5 },
          };
    });
    const client = { updateSessionVisibility, getSession } as unknown as OpenGeniCoreClient;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={client}
          managedSession
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });

    await act(async () => button(container, "Make private").click());
    await act(async () => dialogButton(container, "Make private").click());
    await flush();
    expect(container.textContent).toContain(
      "Close active Files, Terminal, Desktop, and viewer access first.",
    );
    expect(container.textContent).toContain("Retry make private");

    await act(async () => dialogButton(container, "Retry make private").click());
    await flush();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Only me");

    await act(async () => root.unmount());
    container.remove();
  });

  test("reconciles an unknown visibility outcome before offering another operation", async () => {
    const updateSessionVisibility = mock(async () => {
      throw apiError({ status: 503, code: "upstream_unavailable", outcomeUnknown: true });
    });
    const getSession = mock(async () => ({
      ...baseSession,
      tenancy: { ...baseSession.tenancy!, visibility: "private" as const, authorityEpoch: 5 },
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={{ updateSessionVisibility, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });
    await act(async () => button(container, "Make private").click());
    await act(async () => dialogButton(container, "Make private").click());
    await flush();

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Only you can open this session.");
    expect(toastInfo).toHaveBeenCalledWith("Session access refreshed", {
      description: "Session is private to you.",
    });

    await act(async () => root.unmount());
    container.remove();
  });

  test("renders the fresh workspace state when a visibility replay was superseded", async () => {
    const controller = new SessionTenancyOperationController();
    const authority = operationAuthority(controller);
    const updateSessionVisibility = mock(async () => ({
      operationId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
      eventSequence: 8,
      visibility: "private" as const,
      authorityEpoch: 5,
      changed: true,
      replay: true,
      revokedGrantCount: 0,
    }));
    const getSession = mock(async () => ({
      ...baseSession,
      tenancy: { ...baseSession.tenancy!, visibility: "workspace" as const, authorityEpoch: 6 },
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={{ updateSessionVisibility, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...authority}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });
    await act(async () => button(container, "Make private").click());
    await act(async () => dialogButton(container, "Make private").click());
    await flush();

    expect(container.textContent).toContain("Visible to people in Engineering.");
    expect(container.textContent).not.toContain("Only you can open this session.");
    expect(toastInfo).toHaveBeenCalledWith("Session access refreshed", {
      description: "Session is visible to Engineering.",
    });
    expect(controller.snapshot(authority.operationScope).visibility).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  test("retires a visibility replay when the fresh projection is no longer present", async () => {
    const controller = new SessionTenancyOperationController();
    const authority = operationAuthority(controller);
    const updateSessionVisibility = mock(async () => ({
      operationId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
      eventSequence: 8,
      visibility: "private" as const,
      authorityEpoch: 5,
      changed: true,
      replay: true,
      revokedGrantCount: 0,
    }));
    const getSession = mock(async () => ({ ...baseSession, tenancy: undefined }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={{ updateSessionVisibility, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...authority}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });
    await act(async () => button(container, "Make private").click());
    await act(async () => dialogButton(container, "Make private").click());
    await flush();

    expect(container.textContent).toBe("");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("Session access refreshed", {
      description: "Session access controls are no longer available.",
    });
    expect(controller.snapshot(authority.operationScope).visibility).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  test("reuses an outcome-unknown visibility key after an actual unmount and remount", async () => {
    const keys: string[] = [];
    const controller = new SessionTenancyOperationController();
    const authority = operationAuthority(controller);
    let calls = 0;
    const updateSessionVisibility = mock(async (_workspaceId, _sessionId, request) => {
      keys.push(request.idempotencyKey);
      calls += 1;
      if (calls === 1) {
        throw apiError({ status: 503, code: "upstream_unavailable", outcomeUnknown: true });
      }
      return {
        operationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        eventSequence: 8,
        visibility: "private" as const,
        authorityEpoch: 5,
        changed: true,
        replay: true,
        revokedGrantCount: 0,
      };
    });
    let reads = 0;
    const getSession = mock(async () => {
      reads += 1;
      return reads === 1
        ? baseSession
        : {
            ...baseSession,
            tenancy: { ...baseSession.tenancy!, visibility: "private" as const, authorityEpoch: 5 },
          };
    });
    const props = {
      session: baseSession,
      client: { updateSessionVisibility, getSession } as unknown as OpenGeniCoreClient,
      managedSession: true,
      scopeLabel: "Engineering",
      captureWorkspaceInvocation: () => ({ workspaceId: "workspace-a", revision: 1 }),
      ownsWorkspaceInvocation: () => true,
      ...authority,
      onRefreshSession: async () => undefined,
      onOpenSession: () => undefined,
    };
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    await act(async () => root.render(<SessionTenancyControl {...props} />));
    await act(async () => button(container, "Make private").click());
    await act(async () => dialogButton(container, "Make private").click());
    await flush();
    await act(async () => root.unmount());

    root = createRoot(container);
    await act(async () => root.render(<SessionTenancyControl {...props} />));
    await act(async () => button(container, "Make private").click());
    expect(container.textContent).toContain("Retry make private");
    await act(async () => dialogButton(container, "Retry make private").click());
    await flush();

    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(container.textContent).toContain("Only you can open this session.");

    await act(async () => root.unmount());
    container.remove();
  });

  test("refetches an authority-epoch conflict and starts the next intent with fresh input", async () => {
    const keys: string[] = [];
    const epochs: number[] = [];
    let calls = 0;
    const updateSessionVisibility = mock(async (_workspaceId, _sessionId, request) => {
      keys.push(request.idempotencyKey);
      epochs.push(request.expectedAuthorityEpoch);
      calls += 1;
      if (calls === 1) {
        throw apiError({ status: 409, code: "conflict", reason: "authority_epoch" });
      }
      return {
        operationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        eventSequence: 10,
        visibility: "private" as const,
        authorityEpoch: 6,
        changed: true,
        replay: false,
        revokedGrantCount: 0,
      };
    });
    const getSession = mock(async () => ({
      ...baseSession,
      tenancy: { ...baseSession.tenancy!, authorityEpoch: 5 },
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={{ updateSessionVisibility, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });
    await act(async () => button(container, "Make private").click());
    await act(async () => dialogButton(container, "Make private").click());
    await flush();
    expect(container.textContent).toContain(
      "Session access changed in another tab. The latest state has been loaded.",
    );

    await act(async () => button(container, "Make private").click());
    await act(async () => dialogButton(container, "Make private").click());
    await flush();
    expect(epochs).toEqual([4, 5]);
    expect(keys[1]).not.toBe(keys[0]);

    await act(async () => root.unmount());
    container.remove();
  });

  test("retries an unknown fork with the exact key and navigates only from its receipt", async () => {
    const keys: string[] = [];
    const forkSession = mock(async (_workspaceId, _sessionId, request) => {
      keys.push(request.idempotencyKey);
      if (keys.length === 1) {
        throw apiError({ status: 503, code: "upstream_unavailable", outcomeUnknown: true });
      }
      return {
        operationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        eventSequence: 9,
        sessionId: "session-fork",
        workspaceId: "workspace-a",
        visibility: "private" as const,
        authorityEpoch: 1 as const,
        copiedHistoryItemCount: 4,
        replay: true,
      };
    });
    const getSession = mock(async () => ({
      ...baseSession,
      id: "session-fork",
      tenancy: {
        visibility: "private" as const,
        authorityEpoch: 1,
        ownedByCurrentUser: true,
        fork: null,
      },
    }));
    const openSession = mock((_workspaceId: string, _sessionId: string) => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={{ forkSession, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onRefreshSession={async () => undefined}
          onOpenSession={openSession}
        />,
      );
    });
    await act(async () => button(container, "Private copy").click());
    expect(container.textContent).toContain("independent private session in the same workspace");
    await act(async () => button(container, "Create private copy").click());
    await flush();

    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledWith("workspace-a", "session-fork");

    await act(async () => root.unmount());
    container.remove();
  });

  test("does not navigate a replayed fork whose fresh session is no longer private", async () => {
    const controller = new SessionTenancyOperationController();
    const authority = operationAuthority(controller);
    const forkSession = mock(async () => ({
      operationId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
      eventSequence: 9,
      sessionId: "session-fork",
      workspaceId: "workspace-a",
      visibility: "private" as const,
      authorityEpoch: 1 as const,
      copiedHistoryItemCount: 4,
      replay: true,
    }));
    const getSession = mock(async () => ({
      ...baseSession,
      id: "session-fork",
      tenancy: {
        visibility: "workspace" as const,
        authorityEpoch: 2,
        ownedByCurrentUser: true,
        fork: null,
      },
    }));
    const openSession = mock((_workspaceId: string, _sessionId: string) => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={{ forkSession, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...authority}
          onRefreshSession={async () => undefined}
          onOpenSession={openSession}
        />,
      );
    });
    await act(async () => button(container, "Private copy").click());
    await act(async () => button(container, "Create private copy").click());
    await flush();

    expect(openSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "The fork is no longer an owned private session in this workspace.",
    );
    expect(controller.snapshot(authority.operationScope).fork).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  test("reuses an outcome-unknown fork key after an actual unmount and remount", async () => {
    const keys: string[] = [];
    const controller = new SessionTenancyOperationController();
    const authority = operationAuthority(controller);
    const forkSession = mock(async (_workspaceId, _sessionId, request) => {
      keys.push(request.idempotencyKey);
      if (keys.length <= 2) {
        throw apiError({ status: 503, code: "upstream_unavailable", outcomeUnknown: true });
      }
      return {
        operationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        eventSequence: 9,
        sessionId: "session-fork",
        workspaceId: "workspace-a",
        visibility: "private" as const,
        authorityEpoch: 1 as const,
        copiedHistoryItemCount: 4,
        replay: true,
      };
    });
    const getSession = mock(async () => ({
      ...baseSession,
      id: "session-fork",
      tenancy: {
        visibility: "private" as const,
        authorityEpoch: 1,
        ownedByCurrentUser: true,
        fork: null,
      },
    }));
    const openSession = mock((_workspaceId: string, _sessionId: string) => undefined);
    const props = {
      session: baseSession,
      client: { forkSession, getSession } as unknown as OpenGeniCoreClient,
      managedSession: true,
      scopeLabel: "Engineering",
      captureWorkspaceInvocation: () => ({ workspaceId: "workspace-a", revision: 1 }),
      ownsWorkspaceInvocation: () => true,
      ...authority,
      onRefreshSession: async () => undefined,
      onOpenSession: openSession,
    };
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    await act(async () => root.render(<SessionTenancyControl {...props} />));
    await act(async () => button(container, "Private copy").click());
    await act(async () => button(container, "Create private copy").click());
    await flush();
    await act(async () => root.unmount());

    root = createRoot(container);
    await act(async () => root.render(<SessionTenancyControl {...props} />));
    expect(container.textContent).toContain("Retry private copy");
    await act(async () => button(container, "Retry private copy").click());
    await act(async () => dialogButton(container, "Retry private copy").click());
    await flush();

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(openSession).toHaveBeenCalledWith("workspace-a", "session-fork");

    await act(async () => root.unmount());
    container.remove();
  });

  test("does not replay an unknown fork after the principal transition becomes stale", async () => {
    let current = true;
    const pending = deferred<never>();
    const forkSession = mock(async () => await pending.promise);
    const openSession = mock((_workspaceId: string, _sessionId: string) => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={{ forkSession } as unknown as OpenGeniCoreClient}
          managedSession
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => current}
          {...operationAuthority()}
          onRefreshSession={async () => undefined}
          onOpenSession={openSession}
        />,
      );
    });
    await act(async () => button(container, "Private copy").click());
    await act(async () => button(container, "Create private copy").click());
    current = false;
    pending.reject(apiError({ status: 503, code: "upstream_unavailable", outcomeUnknown: true }));
    await flush();

    expect(forkSession).toHaveBeenCalledTimes(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });

  for (const transition of ["principal", "workspace"] as const) {
    test(`makes a delayed mutation inert after a ${transition} transition`, async () => {
      const pending = deferred<{
        operationId: string;
        eventId: string;
        eventSequence: number;
        visibility: "private";
        authorityEpoch: number;
        changed: true;
        replay: false;
        revokedGrantCount: number;
      }>();
      let current = true;
      const refresh = mock(async () => undefined);
      const updateSessionVisibility = mock(async () => await pending.promise);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <SessionTenancyControl
            session={baseSession}
            client={{ updateSessionVisibility } as unknown as OpenGeniCoreClient}
            managedSession
            scopeLabel="Engineering"
            captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
            ownsWorkspaceInvocation={() => current}
            {...operationAuthority()}
            onRefreshSession={refresh}
            onOpenSession={() => undefined}
          />,
        );
      });
      await act(async () => button(container, "Make private").click());
      await act(async () => dialogButton(container, "Make private").click());
      current = false;
      pending.resolve({
        operationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        eventSequence: 8,
        visibility: "private",
        authorityEpoch: 5,
        changed: true,
        replay: false,
        revokedGrantCount: 0,
      });
      await flush();

      expect(refresh).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Workspace");

      await act(async () => root.unmount());
      container.remove();
    });
  }
});
