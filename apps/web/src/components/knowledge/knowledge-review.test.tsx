import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SkillRecord } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const baselineRevisionId = "00000000-0000-4000-8000-000000000004";

let skills: SkillRecord[] = [];
let instructions = true;
const removal: SkillRecord = {
  id: "00000000-0000-4000-8000-000000000010",
  stableKey: "obsolete-skill",
  title: "Obsolete skill",
  description: "Remove obsolete instructions",
  scope: "workspace",
  scopeVersion: 1,
  status: "active",
  activationMode: "workspace_managed",
  activeRevisionId: "00000000-0000-4000-8000-000000000011",
  revisionId,
  pendingRevisionIds: [revisionId],
  removalOperationId: "00000000-0000-4000-8000-000000000012",
  contentHash: null,
  source: null,
  files: [{ path: "SKILL.md", content: "Obsolete instructions" }],
};
const approveSkill = mock(async (_workspace: string, _skill: string, _request: unknown) => ({
  removed: true,
}));
let resolveBaseline!: (value: { content: string }) => void;
const baseline = new Promise<{ content: string }>((resolve) => {
  resolveBaseline = resolve;
});
const reviewAgentInstruction = mock(async () => ({ outcome: "published" }));

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
    listKnowledgeReviewBatches: mock(async () => ({ batches: [], nextCursor: null })),
    listKnowledgeEntries: mock(async () => ({ entries: [], nextCursor: null })),
    listAgentInstructionReviews: mock(async () => ({
      entries: instructions
        ? [
            {
              revisionId,
              content: "Keep every existing customer commitment.\nUse the new rule.",
              target: { kind: "policy" as const, scope: "global" as const, roleKey: null },
              reviewBatchId: null,
              sessionId: null,
              reason: "Agent proposed a policy change",
              createdAt: "2026-09-13T00:00:00.000Z",
            },
          ]
        : [],
      nextCursor: null,
    })),
    listWorkspaceSkills: mock(async () => ({ skills, nextCursor: null })),
    readWorkspaceSkill: async (_workspace: string, _id: string, revision?: string) =>
      revision === removal.activeRevisionId
        ? { ...removal, removalOperationId: null, revisionId: removal.activeRevisionId }
        : removal,
    approveWorkspaceSkill: approveSkill,
    rejectWorkspaceSkill: mock(async () => ({})),
    listWorkspaceInstructionPolicies: mock(async () => ({
      activeHeads: [
        { revisionId: baselineRevisionId, kind: "policy", scope: "global", roleKey: null },
      ],
    })),
    getWorkspaceInstructionPolicyRevision: mock(async () => await baseline),
    reviewAgentInstruction,
  },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
// The modal renders through a portal happy-dom doesn't lay out; keep its contract.
mock.module("@/components/ui/destructive-confirm", () => ({
  showUndoToast: () => 0,
  DestructiveConfirm: (props: {
    open: boolean;
    consequences?: string[];
    confirmLabel?: string;
    onConfirm?: () => void;
  }) =>
    props.open ? (
      <div role="dialog">
        <ul>
          {props.consequences?.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <button type="button" onClick={() => props.onConfirm?.()}>
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));
const { ReviewTab, useReviewQueue } = await import("./knowledge-review");

function Harness() {
  const queue = useReviewQueue(workspaceId, 0);
  return (
    <ReviewTab
      workspaceId={workspaceId}
      queue={queue}
      emptyDescription="When agents propose knowledge, instruction or skill changes, they wait here for your OK."
      onOpenLearning={() => undefined}
      onOpenEntry={() => undefined}
      onChanged={() => undefined}
    />
  );
}

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function button(label: string | RegExp, within: ParentNode = document.body) {
  return [...within.querySelectorAll("button")].find((each) =>
    typeof label === "string"
      ? each.textContent?.trim() === label
      : label.test(each.textContent ?? ""),
  );
}

/** Opens the first change on the list: its own page, with the back link to Review. */
async function openFirstRow(container: HTMLElement) {
  const row = container.querySelector<HTMLElement>("[data-slot=list-row] [data-row-action]");
  expect(row).not.toBeNull();
  await act(async () => row!.click());
  await settle();
  expect(button("Review", container)).toBeDefined();
}

test("instruction approval waits until the current text is loaded, then shows one diff", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await settle();
    // One row per change: what it is and when.
    expect(container.textContent).toContain("Workspace instructions");
    expect(container.querySelectorAll("[data-slot=list-row]")).toHaveLength(1);
    await openFirstRow(container);
    // Nothing to approve until the baseline is visible: no unseen replacement.
    expect(button("Approve")).toBeUndefined();
    expect(button("Reject")).toBeUndefined();
    await act(async () => resolveBaseline({ content: "Keep every existing customer commitment." }));
    await settle();
    expect(container.textContent).toContain("Keep every existing customer commitment.");
    expect(container.textContent).toContain("Added: Use the new rule.");
    const approve = button("Approve");
    expect(approve).toBeDefined();
    // The agent's reason is on the page, under what changes.
    expect(container.textContent).toContain("Agent proposed a policy change");
    await act(async () => approve!.click());
    await settle();
    expect(reviewAgentInstruction).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ revisionId, decision: "approve" }),
    );
    // The last change is done: back on the list, which says so.
    expect(container.textContent).toContain("You're all caught up");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a skill removal confirms with its consequences and submits the exact operation binding", async () => {
  instructions = false;
  skills = [removal];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await settle();
    await openFirstRow(container);
    expect(container.textContent).toContain("An agent asked to delete this skill");
    await act(async () => button("Delete skill")!.click());
    await settle();
    expect(document.body.textContent).toContain("Every saved version of it is deleted.");
    expect(approveSkill).not.toHaveBeenCalled();
    await act(async () =>
      button("Delete skill", document.querySelector("[role=dialog]")!)!.click(),
    );
    await settle();
    expect(approveSkill).toHaveBeenCalledWith(
      workspaceId,
      removal.id,
      expect.objectContaining({
        removalOperationId: removal.removalOperationId,
        revisionId,
        expectedRevisionId: removal.activeRevisionId,
        expectedScopeVersion: 1,
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    skills = [];
    instructions = true;
  }
});

test("an empty queue says so instead of showing an empty list", async () => {
  instructions = false;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(container.textContent).toContain("You're all caught up");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    instructions = true;
  }
});
