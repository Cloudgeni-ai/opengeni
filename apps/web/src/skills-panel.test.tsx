import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SkillRecord, SkillWriteReceipt } from "@opengeni/sdk";
import type { AppContextValue } from "./context";
import { SkillsPanelContent } from "./routes/skills-panel";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
    const button = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes(label),
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  return {
    container,
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
    expect(view.container.textContent).toContain("No Skills yet.");
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
