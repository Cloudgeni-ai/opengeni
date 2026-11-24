import { expect, mock, test } from "bun:test";
import { act } from "react";
import type { SkillRecord, SkillScope, SkillSummary, SkillWriteReceipt } from "@opengeni/sdk";

import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const { SkillsPanel } = await import("../src/skills");

const SKILL =
  "---\nname: release-notes\ndescription: Use when writing release notes.\n---\n\nSteps.\n";

const existing: SkillRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  stableKey: "release-notes",
  title: "release-notes",
  description: "Use when writing release notes. Covers tone and format.",
  scope: "workspace",
  scopeVersion: 1,
  activationMode: "workspace_managed",
  status: "active",
  activeRevisionId: "22222222-2222-4222-8222-222222222222",
  revisionId: "22222222-2222-4222-8222-222222222222",
  pendingRevisionIds: [],
  contentHash: null,
  source: null,
  files: [
    { path: "SKILL.md", content: SKILL },
    { path: "references/old.md", content: "Old" },
  ],
};

function client(skills: SkillRecord[] = [existing]) {
  const saves: unknown[] = [];
  const lists: unknown[] = [];
  return {
    saves,
    lists,
    value: {
      listWorkspaceSkills: mock(async (_workspaceId: string, options: unknown) => {
        lists.push(options);
        return {
          skills: skills.map(({ files: _files, ...summary }) => summary) as SkillSummary[],
          nextCursor: null,
        };
      }),
      readWorkspaceSkill: mock(async (_workspaceId: string, id: string) => {
        const found = skills.find((skill) => skill.id === id);
        if (!found) throw new Error("Skill not found");
        return found;
      }),
      saveWorkspaceSkill: mock(async (_workspaceId: string, request: { skillId: string }) => {
        saves.push(request);
        return {
          skillId: request.skillId,
          outcome: "applied",
          operationId: "op",
          revisionId: "rev",
          replayed: false,
        } as SkillWriteReceipt;
      }),
      removeWorkspaceSkill: mock(async () => ({ removed: true }) as SkillWriteReceipt),
    },
  };
}

const workspaceOnly: readonly SkillScope[] = ["workspace"];

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
}

async function click(label: string) {
  const button = buttonNamed(label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await flush();
}

async function pickFiles(files: File[]) {
  const input = document.body.querySelector<HTMLInputElement>(
    'input[type="file"]:not([webkitdirectory])',
  )!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(20);
}

test("members see the workspace's skills with their descriptions, read-only", async () => {
  const { value, lists } = client();
  const view = await renderComponent(
    <SkillsPanel client={value} workspaceId="ws" canManage={() => false} scopes={workspaceOnly} />,
  );
  try {
    await flush();
    expect(lists[0]).toEqual({ scope: "workspace" });
    expect(view.container.textContent).toContain("Release notes");
    expect(view.container.textContent).toContain("Use when writing release notes.");
    expect(view.container.textContent).toContain("Only admins can add or change skills here.");
    expect(buttonNamed("New skill")).toBeUndefined();
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    await act(async () => {
      (view.container.querySelector(".og-capability-catalog-row") as HTMLButtonElement).click();
    });
    await flush();
    const textarea = view.container.querySelector("textarea")!;
    expect(textarea.readOnly).toBe(true);
    expect(textarea.disabled).toBe(false);
    expect(view.container.textContent).not.toContain("Remove skill");
    expect(view.container.querySelector('[aria-label="Skill scope"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

test("an uploaded new skill opens as a draft and saves into the workspace", async () => {
  const { value, saves } = client([]);
  const view = await renderComponent(
    <SkillsPanel client={value} workspaceId="ws" canManage={() => true} scopes={workspaceOnly} />,
  );
  try {
    await flush();
    expect(view.container.textContent).toContain("No skills yet");
    const other = SKILL.replace("release-notes", "incident-review");
    await pickFiles([new File([other], "SKILL.md")]);
    expect(view.container.textContent).toContain("Uploaded 1 file. Check them, then save.");
    expect(view.container.querySelector("textarea")!.value).toBe(other);
    await click("Save skill");
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      scope: "workspace",
      expectedRevisionId: null,
      files: [{ path: "SKILL.md", content: other }],
      deletions: [],
    });
  } finally {
    await view.unmount();
  }
});

test("uploading a skill that is already here replaces its files instead of adding another", async () => {
  const { value, saves } = client();
  const view = await renderComponent(
    <SkillsPanel client={value} workspaceId="ws" canManage={() => true} scopes={workspaceOnly} />,
  );
  try {
    await flush();
    const updated = `${SKILL}More steps.\n`;
    await pickFiles([new File([updated], "skill.md")]);
    expect(view.container.textContent).toContain("The uploaded files replace this skill's files.");
    await click("Save skill");
    expect(saves[0]).toMatchObject({
      skillId: existing.id,
      expectedRevisionId: existing.activeRevisionId,
      files: [{ path: "SKILL.md", content: updated }],
      deletions: ["references/old.md"],
    });
  } finally {
    await view.unmount();
  }
});

test("a new skill can't take a name another skill here already uses, or save a broken header", async () => {
  const { value, saves } = client();
  const view = await renderComponent(
    <SkillsPanel client={value} workspaceId="ws" canManage={() => true} scopes={workspaceOnly} />,
  );
  try {
    await flush();
    await click("New skill");
    await click("Save skill");
    // The template's placeholder header is valid; the default name is free.
    expect(saves).toHaveLength(1);
    await click("New skill");
    const textarea = view.container.querySelector("textarea")!;
    const key = Object.keys(textarea).find((name) => name.startsWith("__reactProps$"))!;
    const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[
      key
    ]!;
    await act(async () => props.onChange({ target: { value: SKILL } }));
    await click("Save skill");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Another skill here is already called Release notes.",
    );
    await act(async () => props.onChange({ target: { value: "no header" } }));
    await click("Save skill");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Start SKILL.md with a header",
    );
    expect(saves).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});

test("a refusal the host's relay words for people shows its own sentence", async () => {
  const { OpenGeniApiError } = await import("@opengeni/sdk");
  const { value } = client([]);
  const sentence = "A built-in skill is already called release-notes. Choose another name.";
  value.saveWorkspaceSkill = mock(async () => {
    throw new OpenGeniApiError(
      409,
      JSON.stringify({
        error: {
          code: "skill_name_reserved",
          message: sentence,
          details: { code: "skill_name_reserved" },
        },
      }),
      { mutation: true },
    );
  });
  const view = await renderComponent(
    <SkillsPanel
      client={value}
      workspaceId="ws"
      canManage={() => true}
      scopes={workspaceOnly}
      refusalCodes={["skill_name_reserved"]}
    />,
  );
  try {
    await flush();
    await pickFiles([new File([SKILL], "SKILL.md")]);
    await click("Save skill");
    expect(view.container.textContent).toContain(`Couldn't save this skill. ${sentence}`);
  } finally {
    await view.unmount();
  }
});
