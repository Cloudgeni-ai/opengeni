import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, type ReactNode } from "react";
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
  OrganizationInvitationsDialog,
  OrganizationInvitationsMenuItem,
  useOrganizationInvitations,
} = await import("./organization-invitations");

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
  const timestamp = "2026-09-08T12:00:00.000Z";
  return {
    ...input,
    targetEmail: "member@example.test",
    targetName: "Member",
    initialWorkspaceIds: [crypto.randomUUID()],
    role: "member" as const,
    expiresAt: timestamp,
    acceptedMembershipId: input.status === "accepted" ? crypto.randomUUID() : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    delivery: null,
  };
}

describe("global organization invitations", () => {
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
          .querySelector<HTMLButtonElement>('button[aria-label="Join Northwind Research"]')!
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
