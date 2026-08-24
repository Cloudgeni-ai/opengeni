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
    children,
    onConfirm,
    open,
    title,
  }: {
    confirmLabel: string;
    description?: ReactNode;
    children?: ReactNode;
    onConfirm: () => unknown;
    open: boolean;
    title: ReactNode;
  }) => {
    return open ? (
      <div role="dialog">
        <span>{title}</span>
        <span>{description}</span>
        {children}
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null;
  },
}));

// Keep mutation/reconciliation tests independent of Radix portal geometry.
// The production module remains Radix-backed; this semantic stand-in exposes
// the same trigger/menuitem interaction in the test document.
mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    "aria-label"?: string;
  }) => (
    <button type="button" role="menuitem" aria-label={ariaLabel} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
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
  retryable?: boolean;
}) {
  return new OpenGeniApiError(
    input.status,
    JSON.stringify({
      error: {
        code: input.code,
        message: "tenancy failure",
        retryable: input.retryable ?? false,
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

async function chooseAccessAction(container: HTMLElement, label: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label$="Manage session access"]',
  );
  if (!trigger) throw new Error("Missing session access menu trigger");
  await act(async () => trigger.click());
  const item = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!item) throw new Error(`Missing session access action: ${label}`);
  await act(async () => item.click());
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
  test("renders only activated tenancy and lets shared-session members fork without managing visibility", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const common = {
      client: {} as OpenGeniCoreClient,
      managedSession: true,
      canForkPrivately: true,
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
    expect(container.querySelector('[aria-label^="Workspace session access"]')).not.toBeNull();
    expect(container.querySelector('[aria-label$="Manage session access"]')).toBeNull();
    const memberActions = container.querySelector<HTMLButtonElement>(
      'button[aria-label$="Session actions"]',
    );
    expect(memberActions).not.toBeNull();
    await act(async () => memberActions!.click());
    expect(container.textContent).not.toContain("Limit this session to me…");
    expect(container.textContent).toContain("Fork session…");

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
          canForkPrivately
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });

    await chooseAccessAction(container, "Limit this session to me…");
    await act(async () => dialogButton(container, "Limit to me").click());
    await flush();
    expect(container.textContent).toContain(
      "Close active Files, Terminal, Desktop, and viewer access first.",
    );
    expect(container.textContent).toContain("Retry limit to me");

    await act(async () => dialogButton(container, "Retry limit to me").click());
    await flush();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Private");

    await act(async () => root.unmount());
    container.remove();
  });

  test("forks with an explicit destination and durable private-to-workspace acknowledgement", async () => {
    const privateSession = {
      ...baseSession,
      tenancy: { ...baseSession.tenancy!, visibility: "private" as const, authorityEpoch: 5 },
    };
    const requests: unknown[] = [];
    const forkSession = mock(async (_workspaceId, _sessionId, request) => {
      requests.push(request);
      return {
        operationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        eventSequence: 1,
        sessionId: "session-fork",
        workspaceId: "workspace-a",
        visibility: "workspace" as const,
        authorityEpoch: 1 as const,
        copiedHistoryItemCount: 3,
        replay: false,
      };
    });
    const getSession = mock(async () => ({
      ...baseSession,
      id: "session-fork",
      tenancy: {
        ...baseSession.tenancy!,
        visibility: "workspace" as const,
        authorityEpoch: 1,
      },
    }));
    const onOpenSession = mock((_workspaceId: string, _sessionId: string) => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={privateSession}
          client={{ forkSession, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          canForkPrivately
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onOpenSession={onOpenSession}
        />,
      );
    });

    await chooseAccessAction(container, "Fork session…");
    await act(async () => dialogButton(container, "Workspace").click());
    expect(container.textContent).toContain(
      "This private session's complete conversation will be copied",
    );
    await act(async () => dialogButton(container, "Fork for workspace").click());
    await flush();

    expect(requests).toEqual([
      {
        visibility: "workspace",
        workspaceSharedAcknowledged: true,
        idempotencyKey: expect.any(String),
      },
    ]);
    expect(getSession).toHaveBeenCalledWith("workspace-a", "session-fork", { fresh: true });
    expect(onOpenSession).toHaveBeenCalledWith("workspace-a", "session-fork");

    await act(async () => root.unmount());
    container.remove();
  });

  test("offers no private fork destination when the organization has not enabled private sessions", async () => {
    // Migration 0335 fails a private fork into a shared workspace closed with
    // SQLSTATE 55000 when the organization has not enabled private sessions, so
    // the dialog must not present a choice the database refuses. The same
    // `canForkPrivately={false}` state also covers "not answered yet".
    const requests: unknown[] = [];
    const forkSession = mock(async (_workspaceId, _sessionId, request) => {
      requests.push(request);
      return {
        operationId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        eventSequence: 1,
        sessionId: "session-fork",
        workspaceId: "workspace-a",
        visibility: "workspace" as const,
        authorityEpoch: 1 as const,
        copiedHistoryItemCount: 1,
        replay: false,
      };
    });
    const getSession = mock(async () => ({
      ...baseSession,
      id: "session-fork",
      tenancy: { ...baseSession.tenancy!, visibility: "workspace" as const, authorityEpoch: 1 },
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={{
            ...baseSession,
            tenancy: { ...baseSession.tenancy!, visibility: "private", ownedByCurrentUser: true },
          }}
          client={{ forkSession, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          canForkPrivately={false}
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onOpenSession={() => undefined}
        />,
      );
    });

    await chooseAccessAction(container, "Fork session…");
    const dialog = container.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error("Missing confirmation dialog");
    expect(
      Array.from(dialog.querySelectorAll('[role="radio"]')).map((node) => node.textContent?.trim()),
    ).toEqual(["Workspace"]);
    // A private source would otherwise default the fork to private.
    expect(dialog.textContent).toContain("Fork a workspace-visible copy?");
    await act(async () => dialogButton(container, "Fork for workspace").click());
    await flush();
    expect(requests).toEqual([
      {
        visibility: "workspace",
        workspaceSharedAcknowledged: true,
        idempotencyKey: expect.any(String),
      },
    ]);

    await act(async () => root.unmount());
    container.remove();
  });

  test("reuses the exact fork key when destination reconciliation is retryable", async () => {
    const keys: string[] = [];
    let forkCalls = 0;
    const forkSession = mock(async (_workspaceId, _sessionId, request) => {
      keys.push(request.idempotencyKey);
      forkCalls += 1;
      return {
        operationId: "operation-fork",
        eventId: "event-fork",
        eventSequence: 1,
        sessionId: "session-fork",
        workspaceId: "workspace-a",
        visibility: "workspace" as const,
        authorityEpoch: 1 as const,
        copiedHistoryItemCount: 1,
        replay: forkCalls > 1,
      };
    });
    let reads = 0;
    const getSession = mock(async () => {
      reads += 1;
      if (reads === 1) {
        throw apiError({ status: 503, code: "unavailable", retryable: true });
      }
      return {
        ...baseSession,
        id: "session-fork",
        tenancy: { ...baseSession.tenancy!, authorityEpoch: 1 },
      };
    });
    const onOpenSession = mock((_workspaceId: string, _sessionId: string) => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionTenancyControl
          session={baseSession}
          client={{ forkSession, getSession } as unknown as OpenGeniCoreClient}
          managedSession
          canForkPrivately
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onOpenSession={onOpenSession}
        />,
      );
    });

    await chooseAccessAction(container, "Fork session…");
    await act(async () => dialogButton(container, "Fork for workspace").click());
    await flush();
    expect(container.textContent).toContain("Retry fork");
    await act(async () => dialogButton(container, "Retry fork").click());
    await flush();

    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(onOpenSession).toHaveBeenCalledWith("workspace-a", "session-fork");

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
          canForkPrivately
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });
    await chooseAccessAction(container, "Limit this session to me…");
    await act(async () => dialogButton(container, "Limit to me").click());
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
          canForkPrivately
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...authority}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });
    await chooseAccessAction(container, "Limit this session to me…");
    await act(async () => dialogButton(container, "Limit to me").click());
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
          canForkPrivately
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...authority}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });
    await chooseAccessAction(container, "Limit this session to me…");
    await act(async () => dialogButton(container, "Limit to me").click());
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
      canForkPrivately: true,
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
    await chooseAccessAction(container, "Limit this session to me…");
    await act(async () => dialogButton(container, "Limit to me").click());
    await flush();
    await act(async () => root.unmount());

    root = createRoot(container);
    await act(async () => root.render(<SessionTenancyControl {...props} />));
    await chooseAccessAction(container, "Retry: Limit this session to me…");
    expect(container.textContent).toContain("Retry limit to me");
    await act(async () => dialogButton(container, "Retry limit to me").click());
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
          canForkPrivately
          scopeLabel="Engineering"
          captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          {...operationAuthority()}
          onRefreshSession={async () => undefined}
          onOpenSession={() => undefined}
        />,
      );
    });
    await chooseAccessAction(container, "Limit this session to me…");
    await act(async () => dialogButton(container, "Limit to me").click());
    await flush();
    expect(container.textContent).toContain(
      "Session access changed in another tab. The latest state has been loaded.",
    );

    await chooseAccessAction(container, "Limit this session to me…");
    await act(async () => dialogButton(container, "Limit to me").click());
    await flush();
    expect(epochs).toEqual([4, 5]);
    expect(keys[1]).not.toBe(keys[0]);

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
            canForkPrivately
            scopeLabel="Engineering"
            captureWorkspaceInvocation={() => ({ workspaceId: "workspace-a", revision: 1 })}
            ownsWorkspaceInvocation={() => current}
            {...operationAuthority()}
            onRefreshSession={refresh}
            onOpenSession={() => undefined}
          />,
        );
      });
      await chooseAccessAction(container, "Limit this session to me…");
      await act(async () => dialogButton(container, "Limit to me").click());
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
