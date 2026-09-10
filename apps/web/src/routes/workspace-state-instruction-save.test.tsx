import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniClient, type WorkspaceStateResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const initialHead = {
  workspaceId,
  kind: "policy",
  scope: "global",
  roleKey: null,
  revisionId: "initial",
  revision: 1,
  activationVersion: 1,
  contentHash: "a".repeat(64),
  activatedAt: "2026-09-01T00:00:00.000Z",
};
const requests: { path: string; body: any }[] = [];
let failActivation = false;
const client = new OpenGeniClient({
  baseUrl: "https://api.example.test",
  sessionCommandTimeoutMs: 20,
  fetch: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path, body });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/initial") || path.endsWith("/new"))
      return json({ content: "Keep updates concise." });
    if (path.endsWith("/drafts")) return json({ id: "saved", content: body.content });
    if (path.endsWith("/activate")) {
      if (failActivation) return await new Promise<Response>(() => {});
      return json({
        head: {
          ...initialHead,
          revisionId: "saved",
          revision: 2,
          activationVersion: 2,
        },
      });
    }
    // Re-reading either the full inventory or the saved revision never completes.
    return await new Promise<Response>(() => {});
  }) as typeof fetch,
});
mock.module("@/context", () => ({
  useAppContext: () => ({
    client,
    accessContext: {
      accountGrants: [],
      workspaceGrants: [
        {
          workspaceId,
          permissions: ["workspace:admin", "workspace:read"],
        },
      ],
    },
  }),
}));
mock.module("./agent-brain-prompt", () => ({ AgentKnowledgePrompt: () => null }));
const { FocusedInstructions } = await import("./workspace-state");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function mount() {
  requests.length = 0;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (head = initialHead) =>
    await act(async () =>
      root.render(
        <FocusedInstructions
          workspaceId={workspaceId}
          personalWorkspace={false}
          state={
            {
              policy: {
                activeHeads: [head],
                legacyRuntime: {
                  workspaceOverrideConfigured: false,
                },
              },
            } as unknown as WorkspaceStateResponse
          }
        />,
      ),
    );
  await render();
  const submit = async () => {
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  return { container, root, submit, render };
}

test("confirms activation without another read and uses its head for the next save", async () => {
  failActivation = false;
  const { container, root, submit } = await mount();
  try {
    await submit();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved.");
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    expect(container.querySelector("textarea")!.value).toBe("Keep updates concise.");
    expect(requests.filter((request) => !request.body)).toHaveLength(1);
    await submit();
    const activations = requests.filter((request) => request.path.endsWith("/activate"));
    expect(activations[1]!.body.expectedCurrentRevisionId).toBe("saved");
    expect(activations[1]!.body.expectedActivationVersion).toBe(2);
  } finally {
    await act(async () => root.unmount());
  }
});

test("unlocks after a stalled activation and retries the same logical save", async () => {
  failActivation = true;
  const { container, root, submit } = await mount();
  try {
    await submit();
    expect(container.textContent).not.toContain("Saving…");
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    failActivation = false;
    await submit();
    const drafts = requests.filter((request) => request.path.endsWith("/drafts"));
    const activations = requests.filter((request) => request.path.endsWith("/activate"));
    expect(drafts[1]!.body).toEqual(drafts[0]!.body);
    expect(activations[1]!.body).toEqual(activations[0]!.body);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved.");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a refreshed baseline starts a new save even when the instruction text is unchanged", async () => {
  failActivation = true;
  const { root, submit, render } = await mount();
  try {
    await submit();
    await render({ ...initialHead, revisionId: "new", activationVersion: 2 });
    failActivation = false;
    await submit();
    const activations = requests.filter((request) => request.path.endsWith("/activate"));
    expect(activations[1]!.body.expectedCurrentRevisionId).toBe("new");
    expect(activations[1]!.body.expectedActivationVersion).toBe(2);
    expect(activations[1]!.body.operationId).not.toBe(activations[0]!.body.operationId);
  } finally {
    await act(async () => root.unmount());
  }
});
