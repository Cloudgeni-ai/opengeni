import { act } from "react";
import { expect, mock, test } from "bun:test";
import type { SkillRecord, SkillSummary } from "@opengeni/sdk";
import type { AppContextValue } from "@/context";
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
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Existing skill");
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
