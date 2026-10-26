import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const viewer = "user:member";

function row(subjectId: string, used: number, limit: number | null) {
  return {
    subjectId,
    used,
    limit,
    remaining: limit === null ? null : limit - used,
    fraction: null,
    status: "ok",
    resetsAt: null,
    externalIdentity: null,
    rule: { kind: "default" },
    version: 1,
  };
}

let usage: Record<string, unknown> = {};

mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({
    client: {},
    accessContext: {
      mode: "managed",
      subjectId: viewer,
      accountGrants: [],
      workspaceGrants: [
        { workspaceId, accountId: organizationId, permissions: ["workspace:read"] },
      ],
    },
  }),
}));
const budgetModule = await import("./use-workspace-budget");
mock.module("./use-workspace-budget", () => ({
  ...budgetModule,
  useWorkspaceBudget: () => ({
    usage: { value: usage, error: null, loading: false },
    allowance: { value: null, error: null, loading: false },
    rosterDenied: false,
    reload: async () => undefined,
    setMemberRule: async () => undefined,
  }),
}));

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

const { WorkspaceUsagePage, ownUsedThisMonth } = await import("./workspace-usage-page");
const { formatCredits } = await import("@/lib/usage-allowances");

async function render(personalOrganizationLabel?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkspaceUsagePage
        workspaceId={workspaceId}
        workspaceName="Product"
        organizationId={organizationId}
        personalOrganizationLabel={personalOrganizationLabel}
      />,
    );
  });
  return {
    text: container.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("Workspace usage page", () => {
  test("with no limits anywhere, a member still sees what they used this month", async () => {
    usage = {
      period: "month",
      workspace: { ...row("workspace", 90_000, null), subjectId: undefined },
      members: [row(viewer, 23_915, null)],
      nextCursor: null,
    };
    const rendered = await render();
    try {
      expect(rendered.text).toContain("Your usage");
      expect(rendered.text).toContain(`${formatCredits(23_915)} used this month`);
      expect(rendered.text).toContain("No usage limits here");
    } finally {
      await rendered.unmount();
    }
  });

  test("under a workspace budget without a personal limit, their own use is still shown", async () => {
    usage = {
      period: "month",
      workspace: { ...row("workspace", 90_000, 5_000_000), subjectId: undefined },
      members: [row(viewer, 41_000, null)],
      nextCursor: null,
    };
    const rendered = await render();
    try {
      expect(rendered.text).toContain(`${formatCredits(41_000)} used this month`);
      expect(rendered.text).toContain("Workspace budget");
    } finally {
      await rendered.unmount();
    }
  });

  test("a Personal workspace shows the owner's own use and that budgets are for shared workspaces", async () => {
    usage = {
      period: "month",
      workspace: { ...row("workspace", 31_402, null), subjectId: undefined },
      members: [row(viewer, 31_402, null)],
      nextCursor: null,
    };
    const rendered = await render("Solo org");
    try {
      expect(rendered.text).toContain(`${formatCredits(31_402)} used this month`);
      expect(rendered.text).toContain("Your Personal workspace uses Solo org's credits");
      expect(rendered.text).not.toContain("Set a budget");
    } finally {
      await rendered.unmount();
    }
  });

  test("own usage reads only the viewer's row", () => {
    const response = {
      period: "month",
      workspace: row("workspace", 0, null),
      members: [row("user:other", 7, null), row(viewer, 5, null)],
      nextCursor: null,
    } as never;
    expect(ownUsedThisMonth(response, viewer)).toBe(5);
    expect(ownUsedThisMonth(response, "user:absent")).toBe(0);
  });
});
