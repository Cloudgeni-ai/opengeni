import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SkillRecord, SkillWriteReceipt } from "@opengeni/sdk";
import type { AppContextValue } from "./context";

let SkillsPanelContent: typeof import("./routes/skills-panel").SkillsPanelContent;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  ({ SkillsPanelContent } = await import("./routes/skills-panel"));
});
afterAll(() => GlobalRegistrator.unregister());

const record: SkillRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  stableKey: "example",
  scope: "workspace",
  scopeVersion: 1,
  activationMode: "workspace_managed",
  pendingRevisionIds: [],
  status: "active",
  activeRevisionId: "22222222-2222-4222-8222-222222222222",
  revisionId: "22222222-2222-4222-8222-222222222222",
  title: "example",
  description: "Use for examples",
  contentHash: "a".repeat(64),
  source: null,
  files: [
    {
      path: "SKILL.md",
      content: "---\nname: example\ndescription: Use for examples\n---\nInstructions",
    },
    { path: "references/example.txt", content: "Supporting text" },
  ],
};

function fixture(overrides: Record<string, unknown> = {}, admin = true) {
  const calls: Array<{ method: string; workspaceId: string; request?: unknown }> = [];
  const context = {
    authSession: null,
    accessContext: {
      accountGrants: [],
      workspaceGrants: ["one", "two"].map((workspaceId) => ({
        workspaceId,
        accountId: "account",
        principalKind: "human_session",
        permissions: admin ? ["workspace:admin"] : ["workspace:read"],
      })),
    },
    client: {
      async listWorkspaceSkills(workspaceId: string) {
        calls.push({ method: "list", workspaceId });
        return { skills: workspaceId === "one" ? [record] : [] };
      },
      async readWorkspaceSkill(workspaceId: string) {
        calls.push({ method: "read", workspaceId });
        return record;
      },
      async getPreferenceRegistry() {
        return { revisions: [] };
      },
      async saveWorkspaceSkill(workspaceId: string, request: unknown) {
        calls.push({ method: "save", workspaceId, request });
        return { skillId: record.id, outcome: "applied" };
      },
      ...overrides,
    },
  } as unknown as AppContextValue;
  return { context, calls };
}

async function mount(context: AppContextValue) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (workspaceId: string) =>
    act(async () => {
      root.render(<SkillsPanelContent context={context} workspaceId={workspaceId} />);
    });
  await render("one");
  const click = async (label: string) => {
    const button = [...document.body.querySelectorAll("button")].find((node) =>
      node.textContent?.includes(label),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.focus();
      button!.click();
    });
  };
  return {
    container: document.body,
    render,
    click,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("Skills list loads metadata first and saves the full edited folder without dropping supporting files", async () => {
  const { context, calls } = fixture();
  const view = await mount(context);
  try {
    expect(calls.map((call) => call.method)).toEqual(["list"]);
    await view.click("example");
    expect(view.container.querySelector("textarea")?.value).toBe(record.files[0]!.content);
    await view.click("Save Skill");
    expect(calls.find((call) => call.method === "save")?.request).toMatchObject({
      skillId: record.id,
      expectedRevisionId: record.activeRevisionId,
      expectedScopeVersion: 1,
      files: record.files,
      deletions: [],
    });
    expect(view.container.textContent).toContain("Skill saved and active.");
    const saved = calls.find((call) => call.method === "save")!.request as Record<string, unknown>;
    expect(saved).not.toHaveProperty("title");
    expect(saved).not.toHaveProperty("description");
    expect(view.container.textContent).toContain(
      "Edit the name and description at the top of SKILL.md.",
    );
  } finally {
    await view.dispose();
  }
});

test("a save finishing after workspace navigation cannot read or display old-workspace content", async () => {
  let resolve!: (receipt: SkillWriteReceipt) => void;
  const pending = new Promise<SkillWriteReceipt>((done) => {
    resolve = done;
  });
  const { context, calls } = fixture({ saveWorkspaceSkill: () => pending });
  const view = await mount(context);
  try {
    await view.click("example");
    await view.click("Save Skill");
    await view.render("two");
    const readCount = calls.filter((call) => call.method === "read").length;
    await act(async () =>
      resolve({
        operationId: "op",
        skillId: record.id,
        revisionId: record.revisionId!,
        outcome: "applied",
        replayed: false,
      }),
    );
    expect(calls.filter((call) => call.method === "read")).toHaveLength(readCount);
    expect(view.container.querySelector("textarea")).toBeNull();
    expect(view.container.textContent).not.toContain("Skill saved and active.");
    expect(view.container.textContent).toContain("No skills yet.");
  } finally {
    await view.dispose();
  }
});

test("workspace readers can inspect Skill files without edit controls", async () => {
  const { context } = fixture({}, false);
  const view = await mount(context);
  try {
    await view.click("example");
    expect(view.container.querySelector("textarea")?.disabled).toBe(true);
    expect(view.container.textContent).not.toContain("Save Skill");
    expect(view.container.textContent).not.toContain("Add text file");
  } finally {
    await view.dispose();
  }
});

test("catalog pagination appends metadata without opening Skill files", async () => {
  const cursors: Array<string | undefined> = [];
  const { context, calls } = fixture({
    async listWorkspaceSkills(_workspaceId: string, options?: { cursor?: string }) {
      cursors.push(options?.cursor);
      return options?.cursor
        ? { skills: [{ ...record, id: "another-skill", title: "Another Skill" }], nextCursor: null }
        : { skills: [record], nextCursor: "page-two" };
    },
  });
  const view = await mount(context);
  try {
    await view.click("Load more Skills");
    expect(cursors).toEqual([undefined, "page-two"]);
    expect(view.container.textContent).toContain("example");
    expect(view.container.textContent).toContain("Another Skill");
    expect(view.container.textContent).not.toContain("Load more Skills");
    expect(calls.filter((call) => call.method === "read")).toHaveLength(0);
  } finally {
    await view.dispose();
  }
});

test("installed shortcuts use Skill icons and truthful active/pending/inactive labels", async () => {
  const { context, calls } = fixture({
    async listWorkspaceSkills() {
      return {
        skills: [
          record,
          { ...record, id: "pending", title: "Pending", pendingRevisionIds: ["proposal"] },
          {
            ...record,
            id: "proposed",
            title: "Proposed",
            status: "proposed",
            activeRevisionId: null,
            pendingRevisionIds: ["proposal"],
          },
          { ...record, id: "inactive", title: "Inactive", status: "disabled", description: null },
        ],
      };
    },
  });
  const view = await mount(context);
  try {
    const rows = [...view.container.querySelectorAll(".og-connection-installed button")];
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.querySelector(".lucide-book-open"))).toBe(true);
    expect(rows.map((row) => row.getAttribute("title"))).toEqual([
      "Installed",
      "Pending changes",
      "Pending changes",
      "Not active · disabled",
    ]);
    expect(rows[1]!.querySelector('[aria-label="Needs attention"]')).not.toBeNull();
    expect(rows[2]!.querySelector('[aria-label="Needs attention"]')).not.toBeNull();
    expect(rows.every((row) => row.querySelectorAll("button").length === 0)).toBe(true);
    expect(calls.filter((call) => call.method === "read")).toHaveLength(0);
  } finally {
    await view.dispose();
  }
});

test("editor has a labelled shared dialog and restores focus to its catalog opener", async () => {
  const { context } = fixture();
  const view = await mount(context);
  try {
    const opener = view.container.querySelector<HTMLButtonElement>(
      ".og-connection-installed button",
    )!;
    await view.click("example");
    const dialog = view.container.querySelector('[role="dialog"]')!;
    expect(opener.getAttribute("aria-label")).toContain("example");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "example",
    );
    expect(dialog.className).toContain("sm:max-w-[42rem]");
    expect(dialog.className).toContain("sm:top-1/2");
    expect(dialog.querySelector("textarea")).not.toBeNull();
    await view.click("Close");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  } finally {
    await view.dispose();
  }
});

test("save errors stay accessible inside the dialog without dropping the folder", async () => {
  const { context } = fixture({
    async saveWorkspaceSkill() {
      throw new Error("Save denied by workspace policy");
    },
  });
  const view = await mount(context);
  try {
    await view.click("example");
    await view.click("Save Skill");
    const dialog = view.container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      "Save denied by workspace policy",
    );
    expect(view.container.querySelector("section > [role='alert']")).toBeNull();
    expect(dialog.querySelector("textarea")?.value).toBe(record.files[0]!.content);
  } finally {
    await view.dispose();
  }
});

test("pending saves are announced inside the dialog without claiming activation", async () => {
  const { context } = fixture({
    async saveWorkspaceSkill() {
      return { skillId: record.id, outcome: "pending" };
    },
  });
  const view = await mount(context);
  try {
    await view.click("example");
    await view.click("Save Skill");
    expect(view.container.querySelector('[role="dialog"] [role="status"]')?.textContent).toBe(
      "Saved for approval; not active yet.",
    );
    expect(view.container.textContent).not.toContain("Skill saved and active.");
  } finally {
    await view.dispose();
  }
});

test("history keeps inactive revisions read-only and routes approval and restore through existing version guards", async () => {
  const mutations: unknown[] = [];
  const { context } = fixture({
    async readWorkspaceSkill(_workspaceId: string, _skillId: string, revisionId?: string) {
      return {
        ...record,
        revisionId: revisionId ?? record.revisionId,
        pendingRevisionIds: ["pending"],
      };
    },
    async getPreferenceRegistry() {
      return {
        revisions: [
          { id: record.revisionId, revision: 1 },
          { id: "pending", revision: 2 },
          { id: "historical", revision: 0 },
        ],
      };
    },
    async approveWorkspaceSkill(workspaceId: string, skillId: string, request: unknown) {
      mutations.push({ operation: "approve", workspaceId, skillId, request });
      return { skillId, outcome: "applied" };
    },
    async restoreWorkspaceSkill(workspaceId: string, skillId: string, request: unknown) {
      mutations.push({ operation: "restore", workspaceId, skillId, request });
      return { skillId, outcome: "applied" };
    },
  });
  const view = await mount(context);
  try {
    await view.click("example");
    for (const [revisionId, label, operation] of [
      ["pending", "Approve this revision", "approve"],
      ["historical", "Restore as a new revision", "restore"],
    ]) {
      await act(async () => {
        const history = view.container.querySelector<HTMLSelectElement>('[aria-label="History"]')!;
        history.value = revisionId!;
        history.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(view.container.querySelector("textarea")?.disabled).toBe(true);
      expect(view.container.textContent).not.toContain("Save Skill");
      await view.click(label!);
      expect(mutations.at(-1)).toMatchObject({
        operation,
        workspaceId: "one",
        skillId: record.id,
        request: {
          revisionId,
          expectedRevisionId: record.activeRevisionId,
          expectedScopeVersion: 1,
        },
      });
    }
  } finally {
    await view.dispose();
  }
});

test("workspace readers cannot approve inactive revisions or broaden their scope", async () => {
  const { context } = fixture(
    {
      async readWorkspaceSkill() {
        return { ...record, revisionId: "pending", pendingRevisionIds: ["pending"] };
      },
    },
    false,
  );
  const view = await mount(context);
  try {
    await view.click("example");
    expect(view.container.textContent).not.toContain("Approve this revision");
    expect(view.container.textContent).not.toContain("Save Skill");
    expect(
      view.container.querySelector<HTMLSelectElement>('[aria-label="Skill scope"]')?.disabled,
    ).toBe(true);
  } finally {
    await view.dispose();
  }
});

test("a delayed open cannot reveal old-workspace files after switching workspaces", async () => {
  let resolve!: (record: SkillRecord) => void;
  const pending = new Promise<SkillRecord>((done) => {
    resolve = done;
  });
  const { context } = fixture({ readWorkspaceSkill: () => pending });
  const view = await mount(context);
  try {
    await view.click("example");
    await view.render("two");
    await act(async () => resolve(record));
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(view.container.textContent).toContain("No skills yet.");
  } finally {
    await view.dispose();
  }
});

test("scope changes keep the existing authority/version guard and report failures inside the editor", async () => {
  const requests: unknown[] = [];
  const { context } = fixture({
    async changePreferenceRegistryScope(workspaceId: string, skillId: string, request: unknown) {
      requests.push({ workspaceId, skillId, request });
      throw new Error("Scope change denied");
    },
  });
  const view = await mount(context);
  try {
    await view.click("example");
    const scope = view.container.querySelector<HTMLSelectElement>('[aria-label="Skill scope"]')!;
    expect([...scope.options].map((option) => option.value)).toEqual(["user", "workspace"]);
    await act(async () => {
      scope.value = "user";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(requests).toEqual([
      {
        workspaceId: "one",
        skillId: record.id,
        request: { scope: "user", expectedScopeVersion: 1, reason: "Change skill scope" },
      },
    ]);
    expect(view.container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      "Scope change denied",
    );
    expect(scope.value).toBe("workspace");
    expect(view.container.querySelector("textarea")?.value).toBe(record.files[0]!.content);
  } finally {
    await view.dispose();
  }
});
