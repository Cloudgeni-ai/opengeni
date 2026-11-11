import { act } from "react";
import { expect, mock, test } from "bun:test";
import type { SkillRecord, SkillSummary } from "@opengeni/sdk";
import type { AppContextValue } from "@opengeni/react/app/app-context";
import { registerDom, renderComponent, flush } from "../../../../packages/react/test/render-hook";
registerDom();
const { SkillsPanelContent } = await import("./skills-panel");
const skill: SkillRecord = {
  id: "existing",
  stableKey: "existing",
  title: "Existing skill",
  description: "Existing instructions",
  scope: "workspace",
  scopeVersion: 1,
  activationMode: "workspace_managed",
  status: "active",
  activeRevisionId: "revision",
  revisionId: "revision",
  pendingRevisionIds: [],
  contentHash: null,
  source: null,
  files: [{ path: "SKILL.md", content: "# Existing skill" }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (value: T) => resolve(value),
  };
}
test("an imported inventory refresh survives opening a skill and ignores an older response", async () => {
  const first = deferred<{ skills: SkillSummary[] }>();
  const second = deferred<{ skills: SkillSummary[] }>();
  const list = mock(async (): Promise<{ skills: SkillSummary[] }> => ({ skills: [skill] }))
    .mockImplementationOnce(async () => ({ skills: [skill] }))
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const context = {
    authSession: null,
    accessContext: { accountGrants: [], workspaceGrants: [] },
    client: {
      listWorkspaceSkills: list,
      readWorkspaceSkill: async () => skill,
      getPreferenceRegistry: async () => ({ revisions: [] }),
    },
  } as unknown as AppContextValue;
  const onSkillsChange = mock((_skills: SkillSummary[]) => {});
  const openSkillRef = { current: null as ((id: string) => void) | null };
  const render = (refreshRevision: number) => (
    <SkillsPanelContent
      context={context}
      workspaceId="workspace"
      refreshRevision={refreshRevision}
      onSkillsChange={onSkillsChange}
      openSkillRef={openSkillRef}
    />
  );
  const view = await renderComponent(render(0));
  try {
    await flush();
    await view.rerender(render(1));
    await act(async () => openSkillRef.current!(skill.id));
    await flush();
    const imported = { ...skill, id: "imported", title: "Imported skill" };
    await view.rerender(render(2));
    second.resolve({ skills: [skill, imported] });
    await flush();
    expect(onSkillsChange.mock.calls.at(-1)?.[0].map((row) => row.id)).toEqual([
      "existing",
      "imported",
    ]);
    expect(document.querySelector("[data-capability-page]")?.textContent).toContain(
      "Existing skill",
    );
    first.resolve({ skills: [skill] });
    await flush();
    expect(onSkillsChange.mock.calls.at(-1)?.[0].map((row) => row.id)).toEqual([
      "existing",
      "imported",
    ]);
    expect(view.container.textContent).toContain("Imported skill");
  } finally {
    await view.unmount();
  }
});

const elsewhere: SkillRecord = {
  ...skill,
  id: "elsewhere",
  stableKey: "elsewhere",
  title: "Release checklist",
  scope: "organization",
  reach: { allowedWorkspaceIds: ["other-workspace"], allowPersonalWorkspaces: false },
  availableHere: false,
};

function reachContext(
  accountPermissions: string[],
  updateSkillReach: (...args: unknown[]) => Promise<unknown> = async () => ({}),
) {
  return {
    authSession: null,
    accessContext: {
      accountGrants: [{ accountId: "account", permissions: accountPermissions }],
      workspaceGrants: [
        {
          accountId: "account",
          workspaceId: "workspace",
          subjectId: "user:alice",
          principalKind: "human_session",
          permissions: ["workspace:read", "documents:manage"],
        },
      ],
    },
    client: {
      listWorkspaceSkills: async () => ({ skills: [skill, elsewhere] }),
      readWorkspaceSkill: async (_workspaceId: string, id: string) =>
        id === elsewhere.id ? elsewhere : skill,
      getPreferenceRegistry: async () => ({ revisions: [] }),
      getOrganizationAdministrationOverview: async () => ({
        organization: { name: "Acme" },
        workspaces: [
          { id: "workspace", name: "Team" },
          { id: "other-workspace", name: "Support" },
        ],
      }),
      updateSkillReach,
    },
  } as unknown as AppContextValue;
}

test("an organization Skill this workspace doesn't use is shown only to whoever can change that", async () => {
  const memberChanges = mock((_skills: SkillSummary[]) => {});
  const member = await renderComponent(
    <SkillsPanelContent
      context={reachContext([])}
      workspaceId="workspace"
      onSkillsChange={memberChanges}
    />,
  );
  try {
    await flush();
    expect(member.container.textContent).toContain("Existing skill");
    expect(member.container.textContent).not.toContain("Release checklist");
    expect(memberChanges.mock.calls.at(-1)?.[0].map((row) => row.id)).toEqual(["existing"]);
  } finally {
    await member.unmount();
  }

  const openSkillRef = { current: null as ((id: string) => void) | null };
  const updateSkillReach = mock(
    async (_workspaceId: unknown, _skillId: unknown, reach: unknown) => ({
      reach,
    }),
  );
  const owner = await renderComponent(
    <SkillsPanelContent
      context={reachContext(["account:admin"], updateSkillReach)}
      workspaceId="workspace"
      openSkillRef={openSkillRef}
    />,
  );
  try {
    await flush();
    expect(owner.container.textContent).toContain("Release checklist");
    expect(owner.container.textContent).toContain("Not used here");
    await act(async () => openSkillRef.current!(elsewhere.id));
    await flush();
    const page = owner.container.textContent ?? "";
    expect(page).toContain("Available in");
    expect(page).toContain("Agents in this workspace don't use it.");
    const change = [...owner.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Change",
    );
    expect(change).toBeDefined();
    await act(async () => change!.click());
    await flush();
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("Release checklist");
    expect(dialog?.textContent).toContain("Support");
    const save = [...dialog!.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    await act(async () => save!.click());
    await flush();
    expect(updateSkillReach.mock.calls[0]?.slice(0, 2)).toEqual(["workspace", elsewhere.id]);
  } finally {
    await owner.unmount();
  }
});
