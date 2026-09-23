import { act } from "react";
import { expect, mock, test } from "bun:test";
import type { SessionEvent, SkillRecord } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
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
    client: {
      readWorkspaceSkill: read,
      approveWorkspaceSkill: approve,
      listWorkspaceSkills: async () => ({ skills: [record], nextCursor: null }),
    },
  } as unknown as AppContextValue;
  return { context, read, approve };
}

test("reviews exact text and approves without sending a chat message or interrupting the session", async () => {
  const f = fixture();
  const view = await renderComponent(
    <SessionSkillReviews
      context={f.context}
      workspaceId="workspace"
      sessionId="session"
      events={events}
    />,
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
      <SessionSkillReviews
        context={f.context}
        workspaceId="workspace"
        sessionId="session"
        events={events}
      />,
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
    <SessionSkillReviews
      context={f.context}
      workspaceId="workspace"
      sessionId="session"
      events={events}
    />,
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
    <SessionSkillReviews
      context={f.context}
      workspaceId="workspace"
      sessionId="session"
      events={events}
    />,
  );
  try {
    await flush();
    const other = {
      ...f.context,
      accessContext: { ...f.context.accessContext, subjectId: "human:b" },
      client: { ...f.context.client, readWorkspaceSkill: () => new Promise(() => {}) },
    } as unknown as AppContextValue;
    await view.rerender(
      <SessionSkillReviews
        context={other}
        workspaceId="workspace"
        sessionId="session"
        events={events}
      />,
    );
    expect(view.container.textContent).not.toContain("Supporting text");
    expect(view.container.querySelector("button")).toBeNull();
  } finally {
    await view.unmount();
  }
});

test("reopening outside the receipt history window still discovers pending Skills", async () => {
  const f = fixture();
  const list = mock(async () => ({ skills: [record], nextCursor: null }));
  f.context.client.listWorkspaceSkills = list;
  const view = await renderComponent(
    <SessionSkillReviews
      context={f.context}
      workspaceId="workspace"
      sessionId="session"
      events={[]}
    />,
  );
  try {
    await flush();
    expect(list.mock.calls.length).toBe(1);
    expect(view.container.textContent).toContain("Review Test Skill");
    expect(view.container.querySelector("button")?.textContent).toBe("Approve Skill");
  } finally {
    await view.unmount();
  }
});

test("historical receipts do not resurrect deleted or settled reviews", async () => {
  const f = fixture();
  f.context.client.listWorkspaceSkills = async () => ({ skills: [], nextCursor: null });
  const view = await renderComponent(
    <SessionSkillReviews
      context={f.context}
      workspaceId="workspace"
      sessionId="session"
      events={events}
    />,
  );
  try {
    await flush();
    expect(view.container.textContent).toBe("");
    expect(f.read).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

test("a deletion racing the preview settles a 404 instead of leaving a retry card", async () => {
  const f = fixture();
  f.read.mockImplementation(async () => {
    throw new OpenGeniApiError(404, "Skill not found");
  });
  const view = await renderComponent(
    <SessionSkillReviews
      context={f.context}
      workspaceId="workspace"
      sessionId="session"
      events={[]}
    />,
  );
  try {
    await flush();
    expect(view.container.textContent).toBe("");
  } finally {
    await view.unmount();
  }
});

test("uncertain approval retries keep the same operation and exact revision", async () => {
  const f = fixture();
  f.approve.mockImplementationOnce(async () => {
    throw new Error("Connection interrupted");
  });
  const view = await renderComponent(
    <SessionSkillReviews
      context={f.context}
      workspaceId="workspace"
      sessionId="session"
      events={[]}
    />,
  );
  try {
    await flush();
    await act(async () => (view.container.querySelector("button") as HTMLButtonElement).click());
    expect(view.container.textContent).toContain("Connection interrupted");
    await act(async () => (view.container.querySelector("button") as HTMLButtonElement).click());
    expect(f.approve.mock.calls[0]).toEqual(f.approve.mock.calls[1]);
  } finally {
    await view.unmount();
  }
});

test("a new receipt restarts discovery after loading another page", async () => {
  const f = fixture();
  const earlier = {
    ...record,
    id: operationId,
    revisionId: operationId,
    pendingRevisionIds: [operationId],
    title: "Earlier Skill",
  };
  const list = mock(async (_workspaceId: string, _options: unknown) => ({
    skills: [record],
    nextCursor: "next" as string | null,
  }))
    .mockImplementationOnce(async () => ({ skills: [record], nextCursor: "next" }))
    .mockImplementationOnce(async () => ({ skills: [], nextCursor: null }))
    .mockImplementationOnce(async () => ({ skills: [earlier], nextCursor: null }));
  f.context.client.listWorkspaceSkills = list;
  f.read.mockImplementation(async (_workspaceId, id) => (id === operationId ? earlier : record));
  const view = await renderComponent(
    <SessionSkillReviews
      context={f.context}
      workspaceId="workspace"
      sessionId="session"
      events={[]}
    />,
  );
  try {
    await flush();
    const more = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "More pending Skills",
    )!;
    await act(async () => more.click());
    await flush();
    expect(list.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: "next" });
    await view.rerender(
      <SessionSkillReviews
        context={f.context}
        workspaceId="workspace"
        sessionId="session"
        events={events}
      />,
    );
    await flush();
    expect(list.mock.calls.at(-1)?.[1]).toEqual({ sessionId: "session", limit: 100 });
    expect(view.container.textContent).toContain("Review Earlier Skill");
    expect(view.container.textContent).not.toContain("Review Test Skill");
  } finally {
    await view.unmount();
  }
});
