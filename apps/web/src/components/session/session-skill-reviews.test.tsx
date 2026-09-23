import { act } from "react";
import { expect, mock, test } from "bun:test";
import type { SessionEvent, SkillRecord } from "@opengeni/sdk";
import type { AppContextValue } from "@/context";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";
registerDom();
const { SessionSkillReviews } = await import("./session-skill-reviews");
const operationId = "11111111-1111-4111-8111-111111111111";
const skillId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const reference = {
  sourceOperationId: operationId,
  skillId,
  revisionId,
  expectedRevisionId: null,
  expectedScopeVersion: 1,
};
const events = [
  {
    type: "agent.toolCall.output",
    payload: {
      output: {
        operationId,
        skillId,
        revisionId,
        outcome: "pending",
        replayed: false,
        skillReview: reference,
      },
    },
  },
] as SessionEvent[];
const record: SkillRecord = {
  id: skillId,
  revisionId,
  activeRevisionId: null,
  scopeVersion: 1,
  scope: "user",
  activationMode: "workspace_managed",
  pendingRevisionIds: [revisionId],
  status: "proposed",
  title: "Test Skill",
  description: "Test",
  stableKey: "test",
  contentHash: null,
  source: null,
  files: [
    { path: "SKILL.md", content: "<script>untrusted()</script>" },
    { path: "references/a.md", content: "Supporting text" },
  ],
};
function fixture(value = record, human = true) {
  const read = mock(async (_workspaceId: string, _skillId: string, _revisionId: string) => value);
  const approve = mock(async (_workspaceId: string, _skillId: string, _request: unknown) => ({
    outcome: "applied",
  }));
  const context = {
    authSession: human ? {} : null,
    accessContext: { subjectId: "human:a", workspaceGrants: [], accountGrants: [] },
    client: { readWorkspaceSkill: read, approveWorkspaceSkill: approve },
  } as unknown as AppContextValue;
  return { context, read, approve };
}

test("reviews exact text and approves without sending a chat message or interrupting the session", async () => {
  const f = fixture();
  const view = await renderComponent(
    <SessionSkillReviews context={f.context} workspaceId="workspace" events={events} />,
  );
  try {
    await flush();
    expect(f.read.mock.calls[0]).toEqual(["workspace", skillId, revisionId]);
    expect(view.container.textContent).toContain("Supporting text");
    expect(view.container.querySelector("script")).toBeNull();
    await act(async () => (view.container.querySelector("button") as HTMLButtonElement).click());
    expect(f.approve.mock.calls[0]).toMatchObject([
      "workspace",
      skillId,
      {
        revisionId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
      },
    ]);
    expect(view.container.textContent).toBe("");
  } finally {
    await view.unmount();
  }
});

test("settled or changed heads cannot be approved from historical receipts", async () => {
  for (const value of [
    { ...record, pendingRevisionIds: [] },
    { ...record, activeRevisionId: operationId },
    { ...record, scopeVersion: 2 },
  ]) {
    const f = fixture(value);
    const view = await renderComponent(
      <SessionSkillReviews context={f.context} workspaceId="workspace" events={events} />,
    );
    try {
      await flush();
      expect(view.container.textContent).toBe("");
      expect(f.approve).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  }
});

test("non-human viewers cannot approve", async () => {
  const f = fixture(record, false);
  const view = await renderComponent(
    <SessionSkillReviews context={f.context} workspaceId="workspace" events={events} />,
  );
  try {
    await flush();
    expect(view.container.textContent).toContain("do not have permission");
    expect(view.container.querySelector("button")).toBeNull();
  } finally {
    await view.unmount();
  }
});

test("account changes discard previously loaded Skill files", async () => {
  const f = fixture();
  const view = await renderComponent(
    <SessionSkillReviews context={f.context} workspaceId="workspace" events={events} />,
  );
  try {
    await flush();
    const other = {
      ...f.context,
      accessContext: { ...f.context.accessContext, subjectId: "human:b" },
      client: { ...f.context.client, readWorkspaceSkill: () => new Promise(() => {}) },
    } as unknown as AppContextValue;
    await view.rerender(
      <SessionSkillReviews context={other} workspaceId="workspace" events={events} />,
    );
    expect(view.container.textContent).not.toContain("Supporting text");
    expect(view.container.querySelector("button")).toBeNull();
  } finally {
    await view.unmount();
  }
});
