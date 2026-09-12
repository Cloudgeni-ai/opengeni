import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentLearningContext, SaveAgentLearningSettingsRequest } from "@opengeni/sdk";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const defaults = {
  knowledge: "automatic",
  instructions: "review_first",
  skills: "review_first",
} as const;
const getSettings = mock(async (_id: string, scope: string, source?: AgentLearningContext) => ({
  ownerKey: scope,
  contextKey: source ? `${source.kind}:${source.id}` : "default",
  version: 2,
  settings: source ? { knowledge: "review_first" as const } : defaults,
}));
const saveSettings = mock(async (_id: string, input: SaveAgentLearningSettingsRequest) => ({
  ownerKey: input.scope,
  contextKey: "default",
  version: 3,
  settings: { ...defaults, ...input.settings },
}));
const listOverrides = mock(async (_workspaceId: string, _scope: string) => [
  {
    contextKey: "scheduled_task:00000000-0000-4000-8000-000000000002",
    version: 1,
    settings: { knowledge: "review_first" },
    label: "Read support feedback",
    updatedAt: "2026-09-10T00:00:00Z",
  },
]);
const context = {
  workspaces: [{ id: workspaceId, kind: "shared" }],
  managedSelfContext: null,
  client: {
    getAgentLearningSettings: getSettings,
    saveAgentLearningSettings: saveSettings,
    listAgentLearningOverrides: listOverrides,
  },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
  accessContext: {
    mode: "managed",
    subjectId: "user:admin",
    accountGrants: [],
    workspaceGrants: [{ workspaceId, permissions: ["workspace:read", "workspace:admin"] }],
  },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { WorkspaceLearningAdministration } = await import("./workspace-learning-admin");
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  getSettings.mockClear();
  saveSettings.mockClear();
  listOverrides.mockClear();
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<WorkspaceLearningAdministration workspaceId={workspaceId} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    dispose: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
function field(container: HTMLElement, label: string) {
  const element = [...container.querySelectorAll("label")].find(
    (item) => item.textContent === label,
  );
  if (!element) throw new Error(`Missing field ${label}`);
  return document.getElementById(element.htmlFor) as HTMLSelectElement;
}
test("shows all three defaults together and saves one change without resetting the others", async () => {
  const view = await render();
  try {
    expect(field(view.container, "Knowledge").value).toBe("automatic");
    expect(field(view.container, "Workspace instructions").value).toBe("review_first");
    expect(field(view.container, "Skills").value).toBe("review_first");
    const select = field(view.container, "Knowledge");
    await act(async () => {
      select.value = "off";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saveSettings.mock.calls[0]?.[1]).toMatchObject({
      scope: "workspace",
      expectedVersion: 2,
      settings: { knowledge: "off", instructions: "review_first", skills: "review_first" },
    });
    expect(view.container.textContent).toContain("Saved. Applies from the next agent run.");
    expect(view.container.textContent).toContain("Read support feedback");
  } finally {
    await view.dispose();
  }
});
test("personal defaults use their own settings and override inventory", async () => {
  const view = await render();
  try {
    const select = view.container.querySelector(
      '[aria-label="Agent learning defaults for"]',
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = "personal";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getSettings.mock.calls.some((call) => call[1] === "personal")).toBe(true);
    expect(listOverrides.mock.calls.at(-1)).toEqual([workspaceId, "personal"]);
    expect(saveSettings).not.toHaveBeenCalled();
  } finally {
    await view.dispose();
  }
});
