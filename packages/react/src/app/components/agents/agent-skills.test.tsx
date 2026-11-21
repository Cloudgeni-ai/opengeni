import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Agent, SkillSummary } from "@opengeni/sdk";
import type { Root } from "react-dom/client";

// Register the DOM before React DOM and Radix load (see select-menu.test.tsx).
GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const updates: unknown[] = [];
const navigations: unknown[] = [];
let catalog: SkillSummary[] = [];
// One client for every render, as the app's is.
const context = {
  client: {
    listWorkspaceSkills: async () => ({ skills: catalog, nextCursor: null }),
    updateAgent: async (_workspace: string, _id: string, patch: { skills: unknown }) => {
      updates.push(patch.skills);
      return { ...agent, skills: patch.skills };
    },
  },
};
mock.module("../../app-context", () => ({ useAppContext: () => context }));
mock.module("../../lib/navigation", () => ({
  useNavigate: () => (target: unknown) => navigations.push(target),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentSkills, agentSkillChoices, agentSkillHref, findAgentSkill } =
  await import("./agent-skills");
const { skillDisplayName, skillShortDescription } = await import("../../lib/skill-names");

afterAll(() => GlobalRegistrator.unregister());

const GENERATED = "authored-4f1c9a2e0b7d4e6f8a1b2c3d4e5f6a7b";
const skill = (overrides: Partial<SkillSummary>): SkillSummary =>
  ({
    id: "skill-id",
    stableKey: "key",
    title: null,
    description: null,
    scope: "workspace",
    status: "active",
    ...overrides,
  }) as SkillSummary;
const authored = skill({
  id: "11111111-1111-4111-8111-111111111111",
  stableKey: GENERATED,
  title: "weekly-metrics-digest",
  description: "Summarize the week's product metrics. Flag notable changes and owners.",
  scope: "organization",
});
const notes = skill({
  id: "22222222-2222-4222-8222-222222222222",
  stableKey: "release-notes-style",
  title: "release-notes-style",
  description: "Write release notes in the house style.",
});
const triage = skill({
  id: "33333333-3333-4333-8333-333333333333",
  stableKey: "incident-triage",
  title: "incident-triage",
  description: "Triage a production incident.",
});
const agent = {
  id: "agent-1",
  version: 3,
  viewer: { canEdit: true },
  skills: [{ name: GENERATED }, { name: "Release notes style" }],
} as unknown as Agent;

describe("Skill names", () => {
  test("a generated key is never shown as the name", () => {
    expect(skillDisplayName({ title: null, stableKey: GENERATED })).toBe("Untitled Skill");
    expect(skillDisplayName({ title: "sql-review", stableKey: GENERATED })).toBe("Sql review");
    expect(skillDisplayName({ title: null, stableKey: "incident-triage" })).toBe("Incident triage");
  });

  test("the short description is the first sentence", () => {
    expect(skillShortDescription("Summarize the week's metrics. Then more.")).toBe(
      "Summarize the week's metrics.",
    );
    expect(skillShortDescription("  ")).toBeNull();
    expect(skillShortDescription("x".repeat(200))!.length).toBe(138);
  });
});

describe("chosen Skills resolve from the catalog", () => {
  test("by key, then by title, and an unknown reference keeps a readable name", () => {
    expect(findAgentSkill(GENERATED, [notes, authored])?.id).toBe(authored.id);
    expect(findAgentSkill("Release notes style", [notes, authored])?.id).toBe(notes.id);
    const choices = agentSkillChoices(
      [{ name: GENERATED }, { name: "missing-skill" }],
      [notes, authored],
    );
    expect(choices).toEqual([
      {
        ref: GENERATED,
        name: "Weekly metrics digest",
        description: "Summarize the week's product metrics.",
        skillId: authored.id,
      },
      { ref: "missing-skill", name: "Missing skill", description: null, skillId: null },
    ]);
  });

  test("a Skill that works here wins over one that doesn't", () => {
    const elsewhere = { ...notes, id: "elsewhere", availableHere: false };
    expect(findAgentSkill("release-notes-style", [elsewhere, notes])?.id).toBe(notes.id);
  });

  test("links open the Skill's page", () => {
    expect(agentSkillHref("ws 1", "abc")).toBe(
      "/workspaces/ws%201/plugins?section=skills&open=skill%3Aabc",
    );
  });
});

describe("AgentSkills", () => {
  let container: HTMLDivElement;
  let root: Root;
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  beforeEach(() => {
    catalog = [authored, notes, triage];
    updates.length = 0;
    navigations.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  test("shows chosen Skills by name, linked to each, and adds one from the searchable list", async () => {
    const saved = mock();
    await act(async () =>
      root.render(
        <AgentSkills agent={agent} workspaceId="ws" onSaved={saved} onError={() => undefined} />,
      ),
    );
    await settle();
    const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.textContent)).toEqual([
      "Weekly metrics digest",
      "Release notes style",
    ]);
    expect(container.textContent).not.toContain("authored");
    expect(links[0]!.getAttribute("href")).toBe(agentSkillHref("ws", authored.id));
    await act(async () => links[0]!.click());
    expect(navigations).toEqual([{ href: agentSkillHref("ws", authored.id) }]);

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add a Skill"]')!;
    await act(async () => trigger.click());
    await settle();
    // Chosen Skills are not offered again; each option has its description.
    const options = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("Incident triage");
    expect(options[0]!.textContent).toContain("Triage a production incident.");
    await act(async () => (options[0] as HTMLElement).click());
    await settle();
    expect(updates).toEqual([[...agent.skills, { name: "incident-triage" }]]);
    expect(saved).toHaveBeenCalledTimes(1);
  });

  test("removes a chosen Skill by its reference", async () => {
    await act(async () =>
      root.render(
        <AgentSkills
          agent={agent}
          workspaceId="ws"
          onSaved={() => undefined}
          onError={() => undefined}
        />,
      ),
    );
    await settle();
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove Weekly metrics digest"]',
    )!;
    await act(async () => remove.click());
    await settle();
    expect(updates).toEqual([[{ name: "Release notes style" }]]);
  });
});
