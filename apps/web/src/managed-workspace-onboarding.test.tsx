import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

const toastSuccess = mock((_message: string) => undefined);
const toastError = mock((_message: string) => undefined);

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    {
      error: toastError,
      success: toastSuccess,
    },
  ),
}));

const { ManagedWorkspaceOnboardingPanel } =
  await import("./components/managed-workspace-onboarding");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
  document.body.replaceChildren();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function enterText(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const onChange = reactPropsKey
      ? (
          input as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) onChange({ target: input });
    else input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing ${label} button`);
  return match;
}

describe("managed zero-workspace onboarding", () => {
  test("accepts an invitation before a user has any routable workspace", async () => {
    const invitation = {
      id: "invite-1",
      organizationId: "12345678-0000-4000-8000-000000000001",
      targetEmail: "new@example.test",
      targetName: null,
      initialWorkspaceIds: [],
      role: "member" as const,
      status: "pending" as const,
      revision: 1,
      expiresAt: "2026-09-01T00:00:00.000Z",
      acceptedMembershipId: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const acceptOrganizationInvitation = mock(async () => ({
      invitation: { ...invitation, status: "accepted" as const },
      membership: {
        id: "membership-1",
        organizationId: invitation.organizationId,
        subjectId: "user:new",
        name: "New user",
        email: invitation.targetEmail,
        role: "member" as const,
        status: "active" as const,
        authorizationRevision: 1,
        personalWorkspaceId: "personal-workspace-1",
        revokedAt: null,
        personalRetentionUntil: null,
        createdAt: invitation.createdAt,
        updatedAt: invitation.updatedAt,
      },
    }));
    const onAccessChanged = mock(() => undefined);
    const onOpenWorkspace = mock(async () => undefined);
    const client = {
      listOrganizationInvitations: async () => ({ invitations: [invitation], nextCursor: null }),
      acceptOrganizationInvitation,
    } as unknown as OpenGeniCoreClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManagedWorkspaceOnboardingPanel
          client={client}
          onAccessChanged={onAccessChanged}
          onOpenWorkspace={onOpenWorkspace}
        />,
      );
    });
    await flush();
    await act(async () => button(container, "Accept").click());
    await flush();

    expect(acceptOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(onAccessChanged).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspace).toHaveBeenCalledWith("personal-workspace-1");

    await act(async () => root.unmount());
  });

  test("reuses the organization operation id when the first outcome is unknown", async () => {
    const uncertain = Object.assign(new Error("response lost"), { outcomeUnknown: true });
    const createOrganization = mock(async (...args: unknown[]) => {
      if (createOrganization.mock.calls.length === 1) throw uncertain;
      return {
        organization: {
          id: "org-1",
          name: (args[0] as { name: string }).name,
          createdAt: "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        },
        workspaceId: "workspace-1",
      };
    });
    const client = {
      listOrganizationInvitations: async () => ({ invitations: [], nextCursor: null }),
      createOrganization,
    } as unknown as OpenGeniCoreClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ManagedWorkspaceOnboardingPanel
          client={client}
          onAccessChanged={() => undefined}
          onOpenWorkspace={async () => undefined}
        />,
      );
    });
    await flush();
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Organization name"]',
    );
    if (!input) throw new Error("Missing organization name input");
    await enterText(input, "New organization");
    await act(async () => button(container, "Create organization").click());
    await flush();
    await act(async () => button(container, "Create organization").click());
    await flush();

    expect(createOrganization).toHaveBeenCalledTimes(2);
    const first = createOrganization.mock.calls[0]?.[0] as { operationId: string };
    const second = createOrganization.mock.calls[1]?.[0] as { operationId: string };
    expect(second.operationId).toBe(first.operationId);

    await act(async () => root.unmount());
  });
});
