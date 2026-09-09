import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const toastSuccess = mock(() => undefined);
const toastError = mock(() => undefined);

mock.module("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children: ReactNode;
    onSelect?: () => void;
    [key: string]: unknown;
  }) => (
    <button type="button" {...props} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

const {
  accountMenuAriaLabel,
  OrganizationInvitationCountBadge,
  OrganizationInvitationRailNotice,
  OrganizationInvitationsDialog,
  OrganizationInvitationsMenuItem,
  organizationInvitationNoticeLabel,
  pendingOrganizationInvitationCue,
  useOrganizationInvitations,
} = await import("./organization-invitations");
type OrganizationInvitationsController =
  import("./organization-invitations").OrganizationInvitationsController;
const { storeOrganizationInvitationContinuation } =
  await import("@/lib/organization-invitation-continuation");

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

async function flush(): Promise<void> {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

function invitation(input: {
  id: string;
  organizationId: string;
  organizationName: string;
  status: "pending" | "accepted";
  revision: number;
}) {
  const timestamp = new Date(Date.now() + 60 * 60_000).toISOString();
  return {
    ...input,
    targetEmail: "member@example.test",
    targetName: "Member",
    initialWorkspaceIds: [crypto.randomUUID()],
    role: "member" as const,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    acceptedMembershipId: input.status === "accepted" ? crypto.randomUUID() : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    delivery: null,
  };
}

describe("global organization invitations", () => {
  test("opens the exact invitation automatically after an invitation-link sign-in", async () => {
    sessionStorage.clear();
    const pending = invitation({
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      organizationName: "Direct Invitation Organization",
      status: "pending",
      revision: 2,
    });
    storeOrganizationInvitationContinuation({
      organizationId: pending.organizationId,
      organizationName: pending.organizationName,
      targetEmail: pending.targetEmail,
      expiresAt: pending.expiresAt,
    });
    const acceptOrganizationInvitation = mock(async () => ({ status: "complete" as const }));
    const onAccepted = mock(() => undefined);
    const client = {
      listOrganizationInvitations: mock(async () => ({
        invitations: [pending],
        nextCursor: null,
      })),
      acceptOrganizationInvitation,
    } as unknown as OpenGeniBrowserClient;

    function Harness() {
      const controller = useOrganizationInvitations({
        client,
        enabled: true,
        activeEmail: pending.targetEmail,
        onAccepted,
      });
      return <OrganizationInvitationsDialog controller={controller} />;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <Harness />
          </StrictMode>,
        ),
      );
      await flush();
      expect(container.textContent).toContain("Join Direct Invitation Organization");
      expect(container.textContent).toContain("You're signed in");
      expect(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Accept invitation to Direct Invitation Organization"]',
        ),
      ).not.toBeNull();
      expect(sessionStorage.getItem("opengeni:organization-invitation-continuation:v1")).toBeNull();

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Accept invitation to Direct Invitation Organization"]',
          )!
          .click(),
      );
      await flush();
      expect(acceptOrganizationInvitation).toHaveBeenCalledWith(pending.id, {
        expectedRevision: pending.revision,
        operationId: expect.any(String),
      });
      expect(onAccepted).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("Join Direct Invitation Organization");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
    }
  });

  test("does not substitute another pending invitation when the linked one is unavailable", async () => {
    sessionStorage.clear();
    const requestedOrganizationId = crypto.randomUUID();
    const unrelated = invitation({
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      organizationName: "Unrelated Organization",
      status: "pending",
      revision: 1,
    });
    storeOrganizationInvitationContinuation({
      organizationId: requestedOrganizationId,
      organizationName: "Requested Organization",
      targetEmail: unrelated.targetEmail,
      expiresAt: unrelated.expiresAt,
    });
    const client = {
      listOrganizationInvitations: mock(async () => ({
        invitations: [unrelated],
        nextCursor: null,
      })),
      acceptOrganizationInvitation: mock(async () => ({ status: "complete" as const })),
    } as unknown as OpenGeniBrowserClient;

    function Harness() {
      const controller = useOrganizationInvitations({
        client,
        enabled: true,
        activeEmail: unrelated.targetEmail,
        onAccepted: () => undefined,
      });
      return <OrganizationInvitationsDialog controller={controller} />;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await flush();
      expect(container.textContent).toContain("This invitation is no longer available");
      expect(container.textContent).toContain("accepted, expired, or revoked");
      expect(container.textContent).not.toContain("Unrelated Organization");
      expect(container.querySelector('button[aria-label^="Accept invitation to"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
    }
  });

  test("names the invited and active accounts separately before switching", async () => {
    sessionStorage.clear();
    const pending = invitation({
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      organizationName: "Invited Organization",
      status: "pending",
      revision: 1,
    });
    storeOrganizationInvitationContinuation({
      organizationId: pending.organizationId,
      organizationName: pending.organizationName,
      targetEmail: pending.targetEmail,
      expiresAt: pending.expiresAt,
    });
    const onUseInvitedAccount = mock(() => undefined);
    const client = {
      listOrganizationInvitations: mock(async () => ({
        invitations: [],
        nextCursor: null,
      })),
      acceptOrganizationInvitation: mock(async () => ({ status: "complete" as const })),
    } as unknown as OpenGeniBrowserClient;

    function Harness() {
      const controller = useOrganizationInvitations({
        client,
        enabled: true,
        activeEmail: "other@example.test",
        onUseInvitedAccount,
        onAccepted: () => undefined,
      });
      return <OrganizationInvitationsDialog controller={controller} />;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await flush();
      expect(container.textContent).toContain(`This invitation is for ${pending.targetEmail}`);
      expect(container.textContent).toContain("You're signed in as other@example.test");
      expect(container.textContent).toContain("The invitation remains available while you switch");
      expect(
        sessionStorage.getItem("opengeni:organization-invitation-continuation:v1"),
      ).not.toBeNull();

      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "Switch account")!
          .click(),
      );
      expect(onUseInvitedAccount).toHaveBeenCalledWith(pending.targetEmail);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
    }
  });

  test("continues through historical pages to find every pending invitation", async () => {
    const pending = invitation({
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      organizationName: "Later Pending Organization",
      status: "pending",
      revision: 2,
    });
    const nextCursor = crypto.randomUUID();
    const historical = Array.from({ length: 100 }, (_, index) =>
      invitation({
        id: crypto.randomUUID(),
        organizationId: crypto.randomUUID(),
        organizationName: `Historical Organization ${index}`,
        status: "accepted",
        revision: 1,
      }),
    );
    const listOrganizationInvitations = mock(async (options: { cursor?: string; limit?: number }) =>
      options.cursor === nextCursor
        ? { invitations: [pending], nextCursor: null }
        : { invitations: historical, nextCursor },
    );
    const client = {
      listOrganizationInvitations,
      acceptOrganizationInvitation: mock(async () => ({ status: "complete" as const })),
    } as unknown as OpenGeniBrowserClient;

    function Harness() {
      const controller = useOrganizationInvitations({
        client,
        enabled: true,
        onAccepted: () => undefined,
      });
      return <OrganizationInvitationsMenuItem controller={controller} />;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await flush();
      expect(listOrganizationInvitations).toHaveBeenCalledTimes(2);
      expect(listOrganizationInvitations.mock.calls).toEqual([
        [{ limit: 100 }],
        [{ cursor: nextCursor, limit: 100 }],
      ]);
      expect(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Organization invitations, 1 pending"]',
        ),
      ).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("names a closed account menu when invitations are pending", () => {
    expect(pendingOrganizationInvitationCue(0)).toBeNull();
    expect(pendingOrganizationInvitationCue(1)).toBe("1 organization invitation pending");
    expect(pendingOrganizationInvitationCue(3)).toBe("3 organization invitations pending");
    expect(
      accountMenuAriaLabel({
        displayName: "Ada",
        pendingCount: 0,
      }),
    ).toBe("Account menu. Ada is active.");
    expect(
      accountMenuAriaLabel({
        displayName: "Ada",
        pendingCount: 1,
      }),
    ).toBe("Account menu. Ada is active. 1 organization invitation pending.");
    expect(
      organizationInvitationNoticeLabel([
        invitation({
          id: "inv_1",
          organizationId: "org_1",
          organizationName: "Acme",
          status: "pending",
          revision: 1,
        }),
      ]),
    ).toBe("Join Acme");
    expect(
      organizationInvitationNoticeLabel([
        invitation({
          id: "inv_1",
          organizationId: "org_1",
          organizationName: "Acme",
          status: "pending",
          revision: 1,
        }),
        invitation({
          id: "inv_2",
          organizationId: "org_2",
          organizationName: "Beta",
          status: "pending",
          revision: 1,
        }),
      ]),
    ).toBe("2 organization invitations");
    expect(
      organizationInvitationNoticeLabel([
        invitation({
          id: "inv_unnamed",
          organizationId: "org_unnamed",
          organizationName: "   ",
          status: "pending",
          revision: 1,
        }),
      ]),
    ).toBe("Review organization invitation");
  });

  test("does not render a count badge until invitations are pending", async () => {
    const idle = document.createElement("div");
    const pending = document.createElement("div");
    document.body.append(idle, pending);
    const idleRoot = createRoot(idle);
    const pendingRoot = createRoot(pending);
    try {
      await act(async () => idleRoot.render(<OrganizationInvitationCountBadge pendingCount={0} />));
      await act(async () =>
        pendingRoot.render(<OrganizationInvitationCountBadge pendingCount={2} />),
      );
      expect(idle.querySelector('[data-slot="organization-invitation-count"]')).toBeNull();
      expect(
        pending.querySelector('[data-slot="organization-invitation-count"]')?.textContent,
      ).toBe("2");
    } finally {
      await act(async () => {
        idleRoot.unmount();
        pendingRoot.unmount();
      });
      idle.remove();
      pending.remove();
    }
  });

  test("caps the count badge at 9+", async () => {
    const capped = document.createElement("div");
    document.body.append(capped);
    const cappedRoot = createRoot(capped);
    try {
      await act(async () =>
        cappedRoot.render(<OrganizationInvitationCountBadge pendingCount={10} />),
      );
      expect(capped.querySelector('[data-slot="organization-invitation-count"]')?.textContent).toBe(
        "9+",
      );
    } finally {
      await act(async () => cappedRoot.unmount());
      capped.remove();
    }
  });

  test("opens the invitations dialog from the rail notice", async () => {
    const openDialog = mock(() => undefined);
    const pending = invitation({
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      organizationName: "Acme",
      status: "pending",
      revision: 1,
    });
    const controller = {
      open: false,
      invitations: [pending],
      pendingCount: 1,
      loaded: true,
      loading: false,
      error: null,
      acceptingInvitationId: null,
      announcement: "",
      continuation: null,
      canUseInvitedAccount: false,
      openDialog,
      setOpen: () => undefined,
      useInvitedAccount: () => undefined,
      reload: async () => undefined,
      accept: async () => undefined,
    } satisfies OrganizationInvitationsController;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<OrganizationInvitationRailNotice controller={controller} />),
      );
      const notice = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Review invitations. 1 organization invitation pending."]',
      );
      expect(notice).not.toBeNull();
      expect(notice?.textContent).toContain("Join Acme");
      await act(async () => notice!.click());
      expect(openDialog).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("lists only pending invitations and accepts the chosen organization", async () => {
    const pending = invitation({
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      organizationName: "Northwind Research",
      status: "pending",
      revision: 3,
    });
    const historical = invitation({
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      organizationName: "Historical Organization",
      status: "accepted",
      revision: 4,
    });
    const listOrganizationInvitations = mock(async () => ({
      invitations: [pending, historical],
      nextCursor: null,
    }));
    const acceptOrganizationInvitation = mock(async () => ({ status: "complete" as const }));
    const onAccepted = mock(() => undefined);
    const client = {
      listOrganizationInvitations,
      acceptOrganizationInvitation,
    } as unknown as OpenGeniBrowserClient;

    function Harness() {
      const controller = useOrganizationInvitations({
        client,
        enabled: true,
        onAccepted,
      });
      return (
        <>
          <OrganizationInvitationsMenuItem controller={controller} />
          <OrganizationInvitationsDialog controller={controller} />
        </>
      );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await flush();
      expect(listOrganizationInvitations).toHaveBeenCalled();
      expect(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Organization invitations, 1 pending"]',
        ),
      ).not.toBeNull();

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Organization invitations, 1 pending"]',
          )!
          .click(),
      );
      await flush();
      expect(container.textContent).toContain("Northwind Research");
      expect(container.textContent).not.toContain("Historical Organization");

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Accept invitation to Northwind Research"]',
          )!
          .click(),
      );
      await flush();
      expect(acceptOrganizationInvitation).toHaveBeenCalledWith(pending.id, {
        expectedRevision: 3,
        operationId: expect.any(String),
      });
      expect(onAccepted).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("Joined Northwind Research");
      expect(container.textContent).toContain("No pending invitations");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
