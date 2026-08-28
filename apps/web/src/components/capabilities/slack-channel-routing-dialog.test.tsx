import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { AccessContext } from "@/types";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const SHARED_ID = "44444444-4444-4444-8444-444444444444";
const PERSONAL_ID = "55555555-5555-4555-8555-555555555555";
const CONNECTION_ID = "66666666-6666-4666-8666-666666666666";

const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@/context", () => ({ useAppContext: () => mutableContext.current }));

// Radix portals do not mount under happy-dom; render the frame inline so the
// real dialog body is exercised.
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div data-dialog>{children}</div> : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
}));

const { SlackChannelRoutingDialog } = await import("./slack-channel-routing-dialog");

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

function grants(workspaceIds: string[]) {
  return workspaceIds.map((workspaceId) => ({
    workspaceId,
    accountId: ACCOUNT_ID,
    subjectId: "subject-a",
    permissions: ["sessions:create", "workspace:admin"],
  }));
}

function contextValue(storedRouteTarget: string | null): Record<string, unknown> {
  const accessContext: AccessContext = {
    mode: "managed",
    subjectId: "subject-a",
    accountGrants: [],
    workspaceGrants: grants([WORKSPACE_ID, SHARED_ID, PERSONAL_ID]),
    defaultAccountId: ACCOUNT_ID,
    defaultWorkspaceId: WORKSPACE_ID,
  };
  return {
    accessContext,
    workspaces: [
      { id: WORKSPACE_ID, accountId: ACCOUNT_ID, kind: "shared", name: "Home" },
      { id: SHARED_ID, accountId: ACCOUNT_ID, kind: "shared", name: "Platform" },
      { id: PERSONAL_ID, accountId: ACCOUNT_ID, kind: "personal", name: "Sam" },
    ],
    // Canonical Workspace.kind drives display and routing classification. The
    // membership pointer separately proves that PERSONAL_ID belongs to this
    // admin when an owner-specific lifecycle operation needs that identity.
    managedSelfContext: {
      identity: { credentialGeneration: 1, managedUserId: "user-a", subjectId: "subject-a" },
      memberships: [
        {
          organizationId: ACCOUNT_ID,
          status: "active",
          personalWorkspaceId: PERSONAL_ID,
        },
      ],
    },
    client: {
      listOpenGeniSlackReactionChannels: async () => ({
        channels: [{ id: "C1", name: "eng", isPrivate: false }],
      }),
      listOpenGeniSlackChannelRoutes: async () => ({
        routes: storedRouteTarget
          ? [
              {
                slackChannelId: "C1",
                targetWorkspaceId: storedRouteTarget,
                targetWorkspaceName: storedRouteTarget === PERSONAL_ID ? "Sam" : "Platform",
                source: "admin",
              },
            ]
          : [],
      }),
    },
  };
}

async function renderDialog(storedRouteTarget: string | null): Promise<HTMLElement> {
  mutableContext.current = contextValue(storedRouteTarget);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SlackChannelRoutingDialog
        workspaceId={WORKSPACE_ID}
        connectionId={CONNECTION_ID}
        open
        canManage
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
  });
  return host;
}

describe("Slack channel routing dialog", () => {
  test("never offers a personal workspace as a destination", async () => {
    const host = await renderDialog(null);
    const labels = [...host.querySelectorAll("option")].map((option) => option.textContent ?? "");
    expect(labels).toContain("Platform");
    expect(labels.some((label) => label.startsWith("Sam"))).toBe(false);
  });

  test("keeps a route already pointing at the admin's own personal workspace changeable", async () => {
    // Filtering personal workspaces out of the choices must not strand a route
    // set before that rule existed: rendering it as "set by someone else" would
    // be false, and would remove the only control that can clear it.
    const host = await renderDialog(PERSONAL_ID);
    expect(host.textContent).not.toContain("set by someone else");
    const select = host.querySelector("select");
    expect(select).not.toBeNull();
    expect(select?.value).toBe(PERSONAL_ID);
    const labels = [...host.querySelectorAll("option")].map((option) => option.textContent ?? "");
    expect(labels).toContain("Ask me");
    expect(labels.some((label) => label.includes("only you can see this"))).toBe(true);
  });
});
