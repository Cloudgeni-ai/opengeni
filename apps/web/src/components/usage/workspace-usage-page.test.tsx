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
// Stable across renders, as the real app context client is.
const client = { listWorkspaceMembers: async () => [] };
let permissions: string[] = ["workspace:read"];
let budgetOptions: { roster: boolean; budget: boolean }[] = [];

mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({
    client,
    accessContext: {
      mode: "managed",
      subjectId: viewer,
      accountGrants: [],
      workspaceGrants: [{ workspaceId, accountId: organizationId, permissions }],
    },
  }),
}));
const budgetModule = await import("./use-workspace-budget");
mock.module("./use-workspace-budget", () => ({
  ...budgetModule,
  useWorkspaceBudget: (_client: unknown, _workspaceId: string, options: never) => {
    budgetOptions.push(options);
    return {
      usage: { value: usage, error: null, loading: false },
      allowance: { value: null, error: null, loading: false },
      rosterDenied: false,
      reload: async () => undefined,
      setMemberRule: async () => undefined,
    };
  },
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
  budgetOptions = [];
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
      expect(budgetOptions.length).toBeGreaterThan(0);
      for (const options of budgetOptions) {
        expect(options).toEqual({ roster: false, budget: false });
      }
    } finally {
      await rendered.unmount();
    }
  });

  test("an admin's roster with one other member never shows that member's spend as theirs", async () => {
    permissions = ["workspace:admin"];
    usage = {
      period: "month",
      workspace: { ...row("workspace", 64_000, null), subjectId: undefined },
      members: [row("user:someone-else", 64_000, null)],
      nextCursor: null,
    };
    const rendered = await render();
    try {
      expect(budgetOptions.at(-1)).toEqual({ roster: true, budget: true });
      expect(rendered.text).toContain(`${formatCredits(0)} used this month`);
      expect(rendered.text).not.toContain(`${formatCredits(64_000)} used this month`);
    } finally {
      permissions = ["workspace:read"];
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
    expect(ownUsedThisMonth(response, viewer, false)).toBe(5);
    expect(ownUsedThisMonth(response, "user:absent", false)).toBe(0);
    const single = { ...(response as object), members: [row("user:other", 7, null)] } as never;
    // `/usage/me` returns only the caller's row; a roster's lone row is someone else's.
    expect(ownUsedThisMonth(single, viewer, true)).toBe(7);
    expect(ownUsedThisMonth(single, viewer, false)).toBe(0);
  });
});
