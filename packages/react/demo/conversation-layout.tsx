import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { SessionEvent, SessionQueueSnapshot } from "@opengeni/sdk";
import { SessionConversation } from "@opengeni/react";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "../test/fake-client";
import "@opengeni/react/compiled.css";

const control: SessionQueueSnapshot["effectiveControl"] = {
  state: "active",
  directState: "active",
  controlVersion: 1,
  controlEtag: "one",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};
const events: SessionEvent[] = Array.from({ length: 8 }, (_, i) => ({
  id: `message-${i}`,
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  sequence: i + 1,
  type: "user.message",
  payload: { text: `Message ${i}\n` + "Expandable message content. ".repeat(120) },
  occurredAt: new Date().toISOString(),
}));
events.push({
  ...events[0]!,
  id: "assistant-reply",
  sequence: 9,
  type: "agent.message.completed",
  payload: { text: "Readable assistant reply in the selected theme." },
});
let release: (() => void) | undefined;
const pending: SessionEvent[] = [];
const client = fakeClient({
  getSession: async () =>
    ({ id: SESSION_ID, status: "idle", activeTurnId: null, effectiveControl: control }) as never,
  getQueue: async () => ({
    version: 1,
    effectiveControl: control,
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    items: [],
    pendingInputs: [],
    pendingInputAttachment: null,
  }),
  getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
  listHumanInputRequests: async () => [],
  listEvents: async () => events,
  streamEvents: async function* (_w, _s, options) {
    options?.signal?.addEventListener("abort", () => release?.(), { once: true });
    while (!options?.signal?.aborted) {
      if (!pending.length)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      while (pending.length) yield pending.shift()!;
    }
  },
});
function append() {
  const event = {
    ...events[0]!,
    id: crypto.randomUUID(),
    sequence: events.length + 1,
    payload: { text: "New streamed content. ".repeat(160) },
  };
  events.push(event);
  pending.push(event);
  release?.();
}
function App() {
  const [height, setHeight] = useState(500);
  return (
    <main
      data-og-theme={
        new URLSearchParams(location.search).get("theme") === "light" ? "light" : undefined
      }
      style={{ width: "min(760px,100%)", background: "#fffdf9", padding: 16 }}
    >
      <button onClick={append}>Append live message</button>
      <button onClick={() => setHeight(height === 500 ? 350 : 500)}>Resize host</button>
      <section style={{ height, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <SessionConversation sessionId={SESSION_ID} client={client} workspaceId={WORKSPACE_ID} />
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
