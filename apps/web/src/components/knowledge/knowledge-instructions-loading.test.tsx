import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceInstructionPolicyHead, WorkspaceStateResponse } from "@opengeni/sdk";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const head: WorkspaceInstructionPolicyHead = {
  workspaceId,
  kind: "policy",
  scope: "global",
  roleKey: null,
  revisionId: "00000000-0000-4000-8000-000000000010",
  revision: 1,
  activationVersion: 1,
  contentHash: "a".repeat(64),
  activatedAt: "2026-09-20T00:00:00.000Z",
};
const state = {
  workspaceId,
  policy: {
    activeHeads: [head],
    legacyRuntime: { workspaceOverrideConfigured: false },
  },
} as unknown as WorkspaceStateResponse;
const getWorkspaceState = mock(async (_workspace: string) => state);
const getWorkspaceInstructionPolicyRevision = mock(
  async (_workspace: string, _revision: string) => ({ content: "Keep updates concise." }),
);
const context = {
  client: {
    getWorkspaceState,
    getWorkspaceInstructionPolicyRevision,
    listCompanyProfile: async () => ({ current: null, activeRevision: null }),
    getWorkspaceModelCatalog: async () => ({ models: [] }),
  },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { InstructionsTab, InstructionsEditPage, useWorkspaceInstructions } =
  await import("./knowledge-instructions");
let observed!: ReturnType<typeof useWorkspaceInstructions>;
function Harness({ edit = false }: { edit?: boolean }) {
  observed = useWorkspaceInstructions(workspaceId);
  return edit ? (
    <InstructionsEditPage
      workspaceName="Test workspace"
      personal={false}
      instructions={observed}
      onClose={() => undefined}
    />
  ) : (
    <InstructionsTab
      workspaceId={workspaceId}
      workspaceName="Test workspace"
      personal={false}
      canEdit
      canManageOrganization={false}
      instructions={observed}
      onEdit={() => undefined}
      onOpenHistory={() => undefined}
      onGoToLibrary={() => undefined}
    />
  );
}
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
async function settle() {
  for (let index = 0; index < 5; index += 1)
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
}

test("a failed initial inventory shows error and retry, then enables the instruction editor", async () => {
  getWorkspaceState.mockRejectedValueOnce(new Error("Couldn't load workspace state."));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(observed.loading).toBe(false);
    expect(container.textContent).toContain("Couldn't load the instructions");
    expect(container.textContent).toContain("Couldn't load workspace state.");
    expect(container.querySelector('[aria-label="Loading the instructions"]')).toBeNull();
    const buttons = () => [...container.querySelectorAll("button")];
    expect(
      buttons().find((button) => button.textContent?.trim() === "Write instructions")?.disabled,
    ).toBe(true);
    const retry = buttons().find((button) => button.textContent?.trim() === "Try again");
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    await settle();
    expect(observed.loading).toBe(false);
    expect(observed.error).toBeNull();
    expect(container.textContent).toContain("Keep updates concise.");
    expect(buttons().find((button) => button.textContent?.trim() === "Edit")?.disabled).toBe(false);
    await act(async () => root.render(<Harness edit />));
    await settle();
    expect(container.querySelector("textarea")?.value).toBe("Keep updates concise.");
    expect(container.querySelector("textarea")?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a late content read from an unmounted instance cannot overwrite a remount", async () => {
  let resolveStale!: (value: { content: string }) => void;
  const stale = new Promise<{ content: string }>((resolve) => {
    resolveStale = resolve;
  });
  getWorkspaceInstructionPolicyRevision.mockImplementationOnce(async () => await stale);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness key="old" />
        </StrictMode>,
      ),
    );
    await settle();
    expect(observed.loading).toBe(true);
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness key="new" />
        </StrictMode>,
      ),
    );
    await settle();
    expect(container.textContent).toContain("Keep updates concise.");
    await act(async () => resolveStale({ content: "Stale old text" }));
    await settle();
    expect(container.textContent).not.toContain("Stale old text");
    expect(observed.loading).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
