import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const records: Record<string, { version: number; settings: Record<string, string> }> = {
  workspace: { version: 4, settings: { knowledge: "automatic", instructions: "review_first" } },
  personal: { version: 1, settings: {} },
};
const saveAgentLearningSettings = mock(
  async (_workspace: string, request: { scope: string; settings: Record<string, string> }) => ({
    ownerKey: request.scope,
    contextKey: "defaults",
    version: records[request.scope]!.version + 1,
    settings: request.settings,
  }),
);
const context = {
  client: {
    getAgentLearningSettings: mock(async (_workspace: string, scope: string) => ({
      ownerKey: scope,
      contextKey: "defaults",
      ...records[scope]!,
    })),
    saveAgentLearningSettings,
  },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: Object.assign(() => 0, { error: () => 0 }) }));
const { LearningPage, learningSummary, reviewLearningLine, useLearningDefaults } =
  await import("./knowledge-learning");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function Harness({ canManageWorkspace }: { canManageWorkspace: boolean }) {
  const shared = useLearningDefaults(workspaceId, "workspace");
  const mine = useLearningDefaults(workspaceId, "personal");
  return (
    <LearningPage
      workspaceName="Design preview"
      organizationName="Acme Robotics"
      personal={false}
      canManageWorkspace={canManageWorkspace}
      shared={shared}
      mine={mine}
      onClose={() => undefined}
    />
  );
}

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

test("one vocabulary, a summary for the header and a reason on Review", () => {
  expect(learningSummary({ knowledge: "off", instructions: "off", skills: "off" })).toBe("Off");
  expect(
    learningSummary({ knowledge: "automatic", instructions: "review_first", skills: "off" }),
  ).toBe("Mixed");
  expect(
    reviewLearningLine({
      knowledge: "review_first",
      instructions: "automatic",
      skills: "review_first",
    }),
  ).toBe("These wait for you because Knowledge and Skills are set to Review first.");
  expect(
    reviewLearningLine({ knowledge: "automatic", instructions: "automatic", skills: "automatic" }),
  ).toContain("won't wait here");
});

test("shared and private chats are two labelled groups; a change saves at once", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness canManageWorkspace />));
    await settle();
    expect(container.textContent).toContain("Shared chats in Design preview");
    expect(container.textContent).toContain("Your private chats (all workspaces)");
    const groups = [...container.querySelectorAll("section")];
    // Private instructions only apply in the Personal workspace, so there is no row for them.
    const privateRows = [...groups[1]!.querySelectorAll("[data-slot=setting-row]")];
    expect(privateRows.map((row) => row.textContent?.startsWith("Instructions"))).not.toContain(
      true,
    );
    expect(privateRows).toHaveLength(2);
    expect(container.textContent).not.toContain("Allow updates");
    const knowledgeReview = [...container.querySelectorAll<HTMLElement>("[role=radio]")].find(
      (radio) =>
        radio.textContent === "Review first" &&
        radio.closest("[data-slot=setting-row]")?.textContent?.includes("Knowledge"),
    );
    expect(knowledgeReview).toBeDefined();
    await act(async () => knowledgeReview!.click());
    await settle();
    expect(saveAgentLearningSettings).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        scope: "workspace",
        expectedVersion: 4,
        settings: { knowledge: "review_first", instructions: "review_first" },
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("people who aren't workspace admins see the shared defaults but can't change them", async () => {
  saveAgentLearningSettings.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness canManageWorkspace={false} />));
    await settle();
    expect(container.textContent).toContain("Only workspace admins can change this.");
    const shared = container.querySelectorAll("section")[0]!;
    const radios = [...shared.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    expect(radios.length).toBeGreaterThan(0);
    expect(radios.every((radio) => radio.disabled)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
