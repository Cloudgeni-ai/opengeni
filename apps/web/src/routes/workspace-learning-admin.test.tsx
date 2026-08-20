import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceLearningHistoryResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const firstRevisionId = "00000000-0000-4000-8000-000000000003";
const secondRevisionId = "00000000-0000-4000-8000-000000000004";
const activationId = "00000000-0000-4000-8000-000000000005";

const history: WorkspaceLearningHistoryResponse = {
  head: {
    accountId,
    workspaceId,
    revisionId: secondRevisionId,
    revision: 2,
    policyHash: "b".repeat(64),
    activationVersion: 2,
    activatedAt: "2026-08-16T10:00:00.000Z",
  },
  revisions: [
    {
      id: secondRevisionId,
      operationId: crypto.randomUUID(),
      accountId,
      workspaceId,
      revision: 2,
      policyHash: "b".repeat(64),
      workspaceMode: "suggest",
      sourceOverrides: [],
      supersedesRevisionId: firstRevisionId,
      createdBySubjectId: "user:admin",
      createdAt: "2026-08-16T09:59:00.000Z",
    },
    {
      id: firstRevisionId,
      operationId: crypto.randomUUID(),
      accountId,
      workspaceId,
      revision: 1,
      policyHash: "a".repeat(64),
      workspaceMode: "off",
      sourceOverrides: [],
      supersedesRevisionId: null,
      createdBySubjectId: "user:admin",
      createdAt: "2026-08-15T09:59:00.000Z",
    },
  ],
  policyEvents: [],
  decisions: [
    {
      id: crypto.randomUUID(),
      sourceKind: "task-note",
      sourceId: "00000000-0000-4000-8000-000000000006",
      proposalId: crypto.randomUUID(),
      policySnapshotId: crypto.randomUUID(),
      policyRevisionId: secondRevisionId,
      policyActivationVersion: 2,
      effectiveMode: "suggest",
      confidenceBps: 9_200,
      conflictCount: 0,
      outcome: "suggest",
      reasons: ["policy_suggest"],
      automaticEligible: false,
      createdAt: "2026-08-16T10:01:00.000Z",
    },
  ],
  activations: [
    {
      id: activationId,
      decisionReceiptId: crypto.randomUUID(),
      initiatingHumanSubjectId: "user:admin",
      serviceActorSubjectId: "service:governed-learning-activation:test",
      sourceKind: "task-note",
      sourceId: "00000000-0000-4000-8000-000000000006",
      destination: "preference",
      destinationRevisionId: crypto.randomUUID(),
      destinationOldRevisionId: crypto.randomUUID(),
      destinationOldContentHash: "c".repeat(64),
      destinationOldVersion: 3,
      destinationNewContentHash: "d".repeat(64),
      destinationNewVersion: 4,
      effectiveAt: "2026-08-16T10:02:00.000Z",
      createdAt: "2026-08-16T10:02:00.000Z",
    },
  ],
  undos: [],
  truncated: false,
  effectiveBoundary: "next_accepted_attempt",
};

const getHistory = mock(async () => history);
const createRevision = mock(async (_workspaceId: string, request: Record<string, any>) => ({
  ...history.revisions[0]!,
  id: crypto.randomUUID(),
  workspaceMode: request.workspaceMode,
}));
const activateRevision = mock(async () => ({ head: history.head!, event: {} }));
const rollbackRevision = mock(async () => ({ head: history.head!, event: {} }));
const undoActivation = mock(async () => ({}));

const context = {
  client: {
    getWorkspaceLearningHistory: getHistory,
    createWorkspaceLearningPolicyRevision: createRevision,
    activateWorkspaceLearningPolicyRevision: activateRevision,
    rollbackWorkspaceLearningPolicyRevision: rollbackRevision,
    undoGovernedLearningActivation: undoActivation,
  },
  accessContext: {
    accountGrants: [],
    workspaceGrants: [{ workspaceId, permissions: ["workspace:read", "workspace:admin"] }],
  },
};

mock.module("@/context", () => ({ useAppContext: () => context }));
const { WorkspaceLearningAdministration } = await import("./workspace-learning-admin");

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

describe("Learning & autonomy", () => {
  test("shows sanitized history and CAS-fenced controls", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<WorkspaceLearningAdministration workspaceId={workspaceId} />),
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

      expect(container.textContent).toContain("Review first");
      expect(container.textContent).toContain("92.00% confidence");
      expect(container.textContent).toContain("effective for the next accepted attempt");
      expect(container.textContent).not.toContain("private source text");

      const autonomous = container.querySelector<HTMLInputElement>('input[value="automatic"]');
      expect(autonomous).not.toBeNull();
      await act(async () => {
        autonomous!.click();
      });
      const save = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Save learning mode"),
      );
      await act(async () => {
        save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(createRevision).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({
          workspaceMode: "automatic",
          supersedesRevisionId: secondRevisionId,
        }),
      );
      expect(activateRevision).toHaveBeenCalledWith(
        workspaceId,
        expect.any(String),
        expect.objectContaining({
          expectedCurrentRevisionId: secondRevisionId,
          expectedActivationVersion: 2,
        }),
      );

      const rollback = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Rollback to r1"),
      );
      expect(rollback).toBeDefined();
      const undo = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Undo preference change"),
      );
      expect(undo).toBeDefined();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
