import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AgentLearningContext,
  AgentLearningOverrides,
  SaveAgentLearningSettingsRequest,
} from "@opengeni/sdk";

const defaults: AgentLearningOverrides = {
  knowledge: "automatic",
  instructions: "review_first",
  skills: "off",
};
const getSettings = mock(
  async (_workspace: string, scope: string, source?: AgentLearningContext) => ({
    ownerKey: scope,
    contextKey: source ? `${source.kind}:${source.id}` : "default",
    version: 1,
    settings: source ? {} : defaults,
  }),
);
const saveSettings = mock(async (_workspace: string, input: SaveAgentLearningSettingsRequest) => ({
  ownerKey: input.scope,
  contextKey: "chat:test",
  version: 2,
  settings: Object.fromEntries(
    Object.entries(input.settings).filter(([, mode]) => mode !== "inherit"),
  ),
}));
const context = {
  client: { getAgentLearningSettings: getSettings, saveAgentLearningSettings: saveSettings },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { AgentLearningSettingsEditor, AgentLearningDraftEditor } =
  await import("./agent-learning-settings");
let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  getSettings.mockClear();
  saveSettings.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function render(canEdit = true) {
  await act(async () =>
    root.render(
      <AgentLearningSettingsEditor
        compact
        workspaceId="workspace"
        scope="workspace"
        source={{ kind: "chat", id: "test" }}
        canEdit={canEdit}
      />,
    ),
  );
}
function field(label: string) {
  const node = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!node) throw new Error(`Missing ${label}`);
  return document.getElementById(node.htmlFor) as HTMLSelectElement;
}
async function change(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
test("compact settings show effective permission without a default badge or resource descriptions", async () => {
  await render();
  const select = field("Knowledge");
  expect(select.value).toBe("inherit");
  expect(select.parentElement?.querySelector("[aria-hidden]")?.textContent).toBe("Allow updates");
  expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
    "Use default (Allow updates)",
    "Allow updates",
    "Review first",
    "Don’t allow updates",
  ]);
  expect(
    field("Workspace instructions").parentElement?.querySelector("[aria-hidden]")?.textContent,
  ).toBe("Review first");
  expect(field("Skills").parentElement?.querySelector("[aria-hidden]")?.textContent).toBe(
    "Don’t allow updates",
  );
  expect(container.textContent).not.toContain("Retained sources");
  expect(container.textContent).not.toContain("Automatic saves become");
  expect(container.textContent).toContain(
    "Agents can still use these resources when updates are off.",
  );
});
test("compact override and reset keep the sparse API semantics", async () => {
  await render();
  await change(field("Knowledge"), "off");
  expect(saveSettings.mock.calls[0]?.[1]).toMatchObject({
    source: { kind: "chat", id: "test" },
    settings: { knowledge: "off" },
    expectedVersion: 1,
  });
  await change(field("Knowledge"), "inherit");
  expect(saveSettings.mock.calls[1]?.[1]).toMatchObject({
    settings: { knowledge: "inherit" },
    expectedVersion: 2,
  });
  expect(field("Knowledge").value).toBe("inherit");
  expect(field("Knowledge").parentElement?.querySelector("[aria-hidden]")?.textContent).toBe(
    "Allow updates",
  );
});
test("read-only compact settings cannot save even if a change event is dispatched", async () => {
  await render(false);
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  await change(field("Knowledge"), "off");
  expect(saveSettings).not.toHaveBeenCalled();
});
test("new-chat compact draft does not write settings and removes only the reset override", async () => {
  let current: AgentLearningOverrides = { skills: "automatic" };
  function Draft() {
    const [value, setValue] = useState(current);
    return (
      <AgentLearningDraftEditor
        compact
        workspaceId="workspace"
        scope="workspace"
        value={value}
        onChange={(next) => {
          current = next;
          setValue(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Draft />));
  await change(field("Knowledge"), "off");
  expect(current).toEqual({ skills: "automatic", knowledge: "off" });
  await change(field("Knowledge"), "inherit");
  expect(current).toEqual({ skills: "automatic" });
  expect(saveSettings).not.toHaveBeenCalled();
});
