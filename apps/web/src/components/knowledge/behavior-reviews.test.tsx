import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const baselineRevisionId = "00000000-0000-4000-8000-000000000004";
let resolveBaseline!: (value: { content: string }) => void;
const baseline = new Promise<{ content: string }>((resolve) => {
  resolveBaseline = resolve;
});
const review = mock(async () => ({
  operationId: crypto.randomUUID(),
  revisionId,
  outcome: "published" as const,
  reviewBatchId: null,
  replayed: false,
}));
const context = {
  workspaces: [{ id: workspaceId, accountId, kind: "shared" }],
  managedSelfContext: null,
  accessContext: {
    mode: "managed",
    subjectId: "user:admin",
    accountGrants: [],
    workspaceGrants: [{ workspaceId, permissions: ["workspace:admin"] }],
  },
  client: {
    listAgentInstructionReviews: mock(async () => ({
      entries: [
        {
          revisionId,
          content: "Use the new rule and discard the old one.",
          target: { kind: "policy" as const, scope: "global" as const, roleKey: null },
          reviewBatchId: null,
          sessionId: null,
          reason: "Agent proposed a policy change",
          createdAt: "2026-09-13T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    })),
    listWorkspaceSkills: mock(async () => ({ skills: [], nextCursor: null })),
    listWorkspaceInstructionPolicies: mock(async () => ({
      activeHeads: [
        {
          revisionId: baselineRevisionId,
          kind: "policy",
          scope: "global",
          roleKey: null,
        },
      ],
    })),
    getWorkspaceInstructionPolicyRevision: mock(async () => await baseline),
    reviewAgentInstruction: review,
  },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
const { BehaviorReviews } = await import("./behavior-reviews");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("instruction approval stays disabled until current and proposed text are visible", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<BehaviorReviews workspaceId={workspaceId} />);
      await Promise.resolve();
    });
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review",
    );
    if (!open) throw new Error("Missing instruction review button");
    await act(async () => open.click());
    let approve = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );
    expect(document.body.textContent).toContain("Loading the current instruction for comparison");
    expect(approve?.disabled).toBe(true);

    await act(async () => resolveBaseline({ content: "Keep every existing customer commitment." }));
    expect(document.body.textContent).toContain("Current");
    expect(document.body.textContent).toContain("Keep every existing customer commitment.");
    expect(document.body.textContent).toContain("Proposed");
    expect(document.body.textContent).toContain("Use the new rule and discard the old one.");
    approve = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );
    expect(approve?.disabled).toBe(false);
    await act(async () => approve?.click());
    expect(review).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
