import { act } from "react";
import { afterAll, expect, mock, test } from "bun:test";
import type { KnowledgeEntryReach, KnowledgeEntryReachRecord } from "@opengeni/sdk";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();

const records = new Map<string, KnowledgeEntryReachRecord>();
const getKnowledgeEntryReach = mock(async (_workspaceId: string, entryId: string) => {
  const record = records.get(entryId);
  if (!record) throw new Error("not found");
  return record;
});
const updateKnowledgeEntryReach = mock(
  async (_workspaceId: string, entryId: string, reach: KnowledgeEntryReach) => ({
    ...records.get(entryId)!,
    reach,
  }),
);
const context = {
  accessContext: {
    subjectId: "user:alice",
    accountGrants: [{ accountId: "account", permissions: ["account:admin"] }],
    workspaceGrants: [],
  },
  workspaces: [
    { id: "team", name: "Team", accountId: "account", kind: "shared" },
    { id: "support", name: "Support", accountId: "account", kind: "shared" },
    { id: "mine", name: "Personal", accountId: "account", kind: "personal" },
  ],
  client: {
    getKnowledgeEntryReach,
    updateKnowledgeEntryReach,
    getOrganizationAdministrationOverview: async () => ({
      organization: { name: "Acme" },
      workspaces: [
        { id: "team", name: "Team" },
        { id: "support", name: "Support" },
      ],
    }),
  },
};
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => context,
  useOptionalAppContext: () => context,
}));
const { KnowledgeReachItem } = await import("./knowledge-reach");

afterAll(() => mock.restore());

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

test("workspace Knowledge shows nothing and never asks where it works", async () => {
  const view = await renderComponent(
    <KnowledgeReachItem workspaceId="team" entryId="w" scope="workspace" title="Runbook" />,
  );
  try {
    await flush();
    expect(view.container.textContent).toBe("");
    expect(getKnowledgeEntryReach).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

test("an organization entry's managers choose its workspaces; the one it was added in stays", async () => {
  records.set("org", {
    entryId: "org",
    scope: "organization",
    originWorkspaceId: "team",
    reach: { allowedWorkspaceIds: [], allowPersonalWorkspaces: false },
    canChange: true,
  });
  const view = await renderComponent(
    <KnowledgeReachItem workspaceId="team" entryId="org" scope="organization" title="Pricing" />,
  );
  try {
    await flush();
    expect(view.container.textContent).toContain("Available in");
    expect(view.container.textContent).toContain("1 workspace");
    await act(async () => button(view.container, "Change")!.click());
    await flush();
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Where can Pricing be used?");
    expect(dialog.textContent).toContain("Support");
    expect(dialog.textContent).toContain("It was added here, so it's always included.");
    await act(async () => button(dialog, "Save")!.click());
    await flush();
    expect(updateKnowledgeEntryReach.mock.calls.at(-1)).toEqual([
      "team",
      "org",
      { allowedWorkspaceIds: [], allowPersonalWorkspaces: false },
    ]);
  } finally {
    await view.unmount();
  }
});

test("a personal entry counts where it was added; only its owner can change it", async () => {
  records.set("own", {
    entryId: "own",
    scope: "personal",
    originWorkspaceId: "team",
    reach: { allowedWorkspaceIds: [], allowPersonalWorkspaces: true },
    canChange: true,
  });
  records.set("added-in-personal", {
    entryId: "added-in-personal",
    scope: "personal",
    originWorkspaceId: "mine",
    reach: { allowedWorkspaceIds: [], allowPersonalWorkspaces: true },
    canChange: false,
  });
  const own = await renderComponent(
    <KnowledgeReachItem workspaceId="team" entryId="own" scope="personal" title="My notes" />,
  );
  try {
    await flush();
    expect(own.container.textContent).toContain("Personal + 1 workspace");
    await act(async () => button(own.container, "Change")!.click());
    await flush();
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("“My notes” stays personal");
    expect(dialog.textContent).toContain("Support");
  } finally {
    await own.unmount();
  }
  const elsewhere = await renderComponent(
    <KnowledgeReachItem
      workspaceId="mine"
      entryId="added-in-personal"
      scope="personal"
      title="Ideas"
    />,
  );
  try {
    await flush();
    expect(elsewhere.container.textContent).toContain("Only Personal");
    expect(button(elsewhere.container, "Change")).toBeUndefined();
  } finally {
    await elsewhere.unmount();
  }
});
