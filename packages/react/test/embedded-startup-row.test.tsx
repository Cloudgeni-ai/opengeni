import { expect, test } from "bun:test";
import { PendingConversation } from "../src/components/pending-conversation";
import { SessionConversationView } from "../src/components/session-conversation";
import { useSessionConversation } from "../src/hooks/use-session-conversation";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function queuedSession(sessionId: string) {
  return {
    id: sessionId,
    workspaceId: WORKSPACE_ID,
    status: "queued",
    activeTurnId: null,
    effectiveControl: { state: "active", controlVersion: 1 },
    inputWait: null,
    dispatchWait: { state: "acknowledged", attempts: 1, nextAttemptAt: null, lastError: null },
    updatedAt: new Date().toISOString(),
    lastSequence: 0,
    queueVersion: 0,
  };
}

test("an embedded conversation shows the web app's startup row while its first turn starts", async () => {
  const sessionId = crypto.randomUUID();
  const client = fakeClient({
    getSession: async () => queuedSession(sessionId) as never,
    getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
  });
  function Host() {
    const conversation = useSessionConversation(sessionId, { client, workspaceId: WORKSPACE_ID });
    return <SessionConversationView conversation={conversation} />;
  }
  const view = await renderComponent(<Host />);
  try {
    await flush(80);
    expect(view.container.querySelector(".og-genie-loading")).not.toBeNull();
  } finally {
    await view.unmount();
  }
});

test("a host's pending prompt renders the same message and startup row before its session exists", async () => {
  const view = await renderComponent(
    <PendingConversation text="Explain my network" sentAt={new Date().toISOString()} />,
  );
  try {
    await flush(50);
    expect(view.container.textContent).toContain("Explain my network");
    expect(view.container.querySelector(".og-genie-loading")).not.toBeNull();
    expect(view.container.textContent).toContain("Thinking");
  } finally {
    await view.unmount();
  }
});
