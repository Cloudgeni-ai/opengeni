import { act } from "react";
import { expect, mock, test } from "bun:test";
import type { SessionEvent, SkillRecord } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { AppContextValue } from "@opengeni/react/app/app-context";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";
registerDom();
const { SessionSkillReviews } =
  await import("@opengeni/react/app/components/session/session-skill-reviews");
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
function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
}
/** The Skill's name opens its description and files. */
function details(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>("button[aria-expanded]");
}

function fixture(value = record, human = true) {
  const read = mock(async (_workspaceId: string, _skillId: string, _revisionId: string) => value);
  const approve = mock(async (_workspaceId: string, _skillId: string, _request: unknown) => ({
    outcome: "applied",
  }));
  // The server preserves a rejected revision rather than applying it.
  const reject = mock(async (_workspaceId: string, _skillId: string, _request: unknown) => ({
    outcome: "preserved",
    decision: "rejected",
  }));
  const context = {
    authSession: human ? {} : null,
    accessContext: { subjectId: "human:a", workspaceGrants: [], accountGrants: [] },
    client: {
      readWorkspaceSkill: read,
      approveWorkspaceSkill: approve,
      rejectWorkspaceSkill: reject,
      listWorkspaceSkills: async () => ({ skills: [record], nextCursor: null }),
    },
  } as unknown as AppContextValue;
  return { context, read, approve, reject };
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
    await act(async () => details(view.container)!.click());
    expect(view.container.textContent).toContain("Supporting text");
    expect(view.container.querySelector("script")).toBeNull();
    await act(async () => button(view.container, "Approve")!.click());
    expect(f.approve.mock.calls[0]).toMatchObject([
      "workspace",
      skillId,
      {
        revisionId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
      },
    ]);
    expect(view.container.textContent).toContain(
      "Approved · Agents can use it from your next message",
    );
    expect(button(view.container, "Approve")).toBeUndefined();
    // Focus stays on the card, not the removed button.
    expect(document.activeElement?.textContent).toBe("Test Skill");
  } finally {
    await view.unmount();
  }
});

test("the approval confirmation survives a catalog refresh until the next turn starts", async () => {
  const f = fixture();
  let approved = false;
  f.context.client.listWorkspaceSkills = async () => ({
    skills: approved ? [] : [record],
    nextCursor: null,
  });
  f.approve.mockImplementation(async () => {
    approved = true;
    return { outcome: "applied" };
  });
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
    await act(async () => button(view.container, "Approve")!.click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(view.container.textContent).toContain("Agents can use it from your next message");
    await view.rerender(
      <SessionSkillReviews
        context={f.context}
        workspaceId="workspace"
        sessionId="session"
        events={[...events, { id: "turn-2", type: "turn.started", payload: {} } as SessionEvent]}
      />,
    );
    await flush();
    expect(view.container.textContent).toBe("");
  } finally {
    await view.unmount();
  }
});

test("declining rejects the exact revision, never approves it, and leaves at the next turn", async () => {
  const f = fixture();
  let declined = false;
  f.context.client.listWorkspaceSkills = async () => ({
    skills: declined ? [] : [record],
    nextCursor: null,
  });
  f.reject.mockImplementation(async () => {
    declined = true;
    return { outcome: "preserved", decision: "rejected" };
  });
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
    await act(async () => button(view.container, "Decline")!.click());
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.reject.mock.calls[0]).toMatchObject([
      "workspace",
      skillId,
      { revisionId, expectedRevisionId: null, expectedScopeVersion: 1 },
    ]);
    expect(view.container.textContent).toContain("Declined · Agents won't use it");
    expect(button(view.container, "Approve")).toBeUndefined();
    expect(document.activeElement?.textContent).toBe("Test Skill");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(view.container.textContent).toContain("Declined");
    await view.rerender(
      <SessionSkillReviews
        context={f.context}
        workspaceId="workspace"
        sessionId="session"
        events={[...events, { id: "turn-2", type: "turn.started", payload: {} } as SessionEvent]}
      />,
    );
    await flush();
    expect(view.container.textContent).toBe("");
  } finally {
    await view.unmount();
  }
});

test("a decided review doesn't come back from the stale catalog at the next turn", async () => {
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
    await act(async () => button(view.container, "Approve")!.click());
    // No window focus: the catalog still lists the revision as pending.
    await view.rerender(
      <SessionSkillReviews
        context={f.context}
        workspaceId="workspace"
        sessionId="session"
        events={[...events, { id: "turn-2", type: "turn.started", payload: {} } as SessionEvent]}
      />,
    );
    await flush();
    expect(view.container.textContent).toBe("");
    expect(f.read.mock.calls.length).toBe(1);
  } finally {
    await view.unmount();
  }
});

test("declining a change says the current version stays", async () => {
  const update = { ...record, activeRevisionId: operationId, status: "active" as const };
  const f = fixture(update);
  f.context.client.listWorkspaceSkills = async () => ({ skills: [update], nextCursor: null });
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
    await act(async () => button(view.container, "Decline")!.click());
    expect(view.container.textContent).toContain("Declined · The current version stays");
  } finally {
    await view.unmount();
  }
});

test("an unexpected decline receipt is never shown as declined or approved", async () => {
  const f = fixture();
  f.reject.mockImplementation(async () => ({ outcome: "applied" }) as never);
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
    await act(async () => button(view.container, "Decline")!.click());
    expect(view.container.textContent).toContain("Couldn't decline this Skill.");
    expect(view.container.textContent).not.toContain("Declined ·");
    expect(view.container.textContent).not.toContain("Approved");
  } finally {
    await view.unmount();
  }
});

test("a confirmation never takes focus from where the person moved on to", async () => {
  const f = fixture();
  let finish: () => void = () => {};
  f.approve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ outcome: "applied" });
      }),
  );
  const composer = document.createElement("textarea");
  document.body.append(composer);
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
    await act(async () => button(view.container, "Approve")!.click());
    composer.focus();
    await act(async () => finish());
    await flush();
    expect(view.container.textContent).toContain("Approved");
    expect(document.activeElement).toBe(composer);
  } finally {
    await view.unmount();
    composer.remove();
  }
});

test("approve and decline use their own operations, each replayed on retry", async () => {
  const f = fixture();
  f.reject.mockImplementationOnce(async () => {
    throw new Error("Connection interrupted");
  });
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
    await act(async () => button(view.container, "Decline")!.click());
    await act(async () => button(view.container, "Approve")!.click());
    await act(async () => button(view.container, "Decline")!.click());
    const declines = f.reject.mock.calls.map((call) => call[2]);
    expect(declines).toHaveLength(2);
    expect(declines[0]).toEqual(declines[1]);
    const approval = f.approve.mock.calls[0];
    expect(approval).toBeDefined();
    expect((approval![2] as { operationId: string }).operationId).not.toBe(
      (declines[0] as { operationId: string }).operationId,
    );
    expect(view.container.textContent).toContain("Declined · Agents won't use it");
  } finally {
    await view.unmount();
  }
});

test("an approval that comes back rejected is never shown as approved", async () => {
  const f = fixture();
  f.approve.mockImplementation(async () => ({ outcome: "applied", decision: "rejected" }) as never);
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
    await act(async () => button(view.container, "Approve")!.click());
    expect(view.container.textContent).toContain("Couldn't approve this Skill.");
    expect(view.container.textContent).not.toContain("Approved ·");
  } finally {
    await view.unmount();
  }
});

test("a workspace Skill needs documents:manage to approve or decline", async () => {
  const shared = { ...record, scope: "workspace" as const };
  for (const permissions of [["documents:search"], ["documents:manage"]]) {
    const f = fixture(shared);
    f.context.client.listWorkspaceSkills = async () => ({ skills: [shared], nextCursor: null });
    (f.context as { accessContext: unknown }).accessContext = {
      subjectId: "human:a",
      accountGrants: [],
      workspaceGrants: [{ workspaceId: "workspace", principalKind: "human_session", permissions }],
    };
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
      const manage = permissions.includes("documents:manage");
      expect(view.container.textContent).toContain("New Skill · Not active until approved");
      expect(button(view.container, "Approve") !== undefined).toBe(manage);
      expect(button(view.container, "Decline") !== undefined).toBe(manage);
    } finally {
      await view.unmount();
    }
  }
});

test("a failed decision returns focus to the button the person used", async () => {
  const f = fixture();
  f.approve.mockImplementationOnce(async () => {
    // Browsers move focus to the page body when the focused button becomes disabled.
    (document.activeElement as HTMLElement | null)?.blur();
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
    const approve = button(view.container, "Approve")!;
    approve.focus();
    await act(async () => approve.click());
    await flush();
    expect(view.container.textContent).toContain("Couldn't approve this Skill.");
    expect(document.activeElement).toBe(button(view.container, "Approve")!);
  } finally {
    await view.unmount();
  }
});

test("approving a change says agents use the new version", async () => {
  const update = { ...record, activeRevisionId: operationId, status: "active" as const };
  const f = fixture(update);
  f.context.client.listWorkspaceSkills = async () => ({ skills: [update], nextCursor: null });
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
    await act(async () => button(view.container, "Approve")!.click());
    expect(view.container.textContent).toContain(
      "Approved · Agents use this version from your next message",
    );
  } finally {
    await view.unmount();
  }
});

test("a deletion proposal deletes with the danger action and confirms the deletion", async () => {
  const removal = { ...record, removalOperationId: operationId };
  const f = fixture(removal);
  f.context.client.listWorkspaceSkills = async () => ({ skills: [removal], nextCursor: null });
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
    expect(view.container.textContent).toContain("Delete Skill · Can't be undone once approved");
    expect(button(view.container, "Approve")).toBeUndefined();
    expect(button(view.container, "Keep")).toBeDefined();
    await act(async () => button(view.container, "Delete")!.click());
    expect(f.approve.mock.calls[0]?.[2]).toMatchObject({ removalOperationId: operationId });
    expect(view.container.textContent).toContain("Deleted");
    expect(view.container.textContent).not.toContain("next message");
  } finally {
    await view.unmount();
  }
});

test("a pending Skill says, without expanding, that agents won't use it until approved", async () => {
  const f = fixture({ ...record, description: "Use when releasing the web app." });
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
    const text = view.container.textContent;
    expect(text).toContain("Test Skill");
    expect(text).toContain("New Skill · Not active until approved");
    expect(button(view.container, "Approve")).toBeDefined();
    expect(button(view.container, "Decline")).toBeDefined();
    // The bar stays compact: description and files wait until it's opened.
    expect(text).not.toContain("Use when releasing the web app.");
    expect(view.container.querySelector("details")).toBeNull();
    await act(async () => details(view.container)!.click());
    expect(view.container.textContent).toContain("Use when releasing the web app.");
    expect(view.container.querySelectorAll("details").length).toBe(2);
  } finally {
    await view.unmount();
  }
});

test("a pending change to a Skill says it isn't applied until approved", async () => {
  const update = { ...record, activeRevisionId: operationId, status: "active" as const };
  const f = fixture(update);
  f.context.client.listWorkspaceSkills = async () => ({ skills: [update], nextCursor: null });
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
    expect(view.container.textContent).toContain("Skill update · Not applied until approved");
    await act(async () => button(view.container, "Approve")!.click());
    expect(f.approve.mock.calls[0]?.[2]).toMatchObject({ expectedRevisionId: operationId });
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
    expect(view.container.textContent).toContain("New Skill · Not active until approved");
    expect(button(view.container, "Approve")).toBeUndefined();
    expect(button(view.container, "Decline")).toBeUndefined();
    const toggle = details(view.container)!;
    await act(async () => toggle.click());
    const body = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(body?.textContent).toContain("Someone who can manage Skills can approve it.");
    expect(body?.textContent).toContain("Supporting text");
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
    expect(view.container.textContent).toContain("Test Skill");
    expect(button(view.container, "Approve")).toBeDefined();
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
    await act(async () => button(view.container, "Approve")!.click());
    expect(view.container.textContent).toContain("Connection interrupted");
    await act(async () => button(view.container, "Approve")!.click());
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
      (entry) => entry.textContent === "More pending Skills",
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
    expect(view.container.textContent).toContain("Earlier Skill");
    expect(view.container.textContent).not.toContain("Test Skill");
  } finally {
    await view.unmount();
  }
});
