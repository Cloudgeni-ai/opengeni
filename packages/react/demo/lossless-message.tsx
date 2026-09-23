import { createRoot } from "react-dom/client";
import { MessageTimeline, TooltipProvider, useSessionEvents } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "../test/fake-client";
import "./styles.css";

// Deliberately above both former per-string and per-event preview thresholds.
const text = Array.from(
  { length: 900 },
  (_, index) =>
    `Paragraph ${index}: ${"Complete text 界🙂 stays readable and copyable. ".repeat(4).trimEnd()}`,
).join("\n\n");
const message: SessionEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  sequence: 1,
  type: "agent.message.completed",
  payload: { text },
  occurredAt: "2026-01-01T00:00:00.000Z",
};
const live = new URLSearchParams(location.search).get("live") === "1";
const client = fakeClient({
  listEvents: async () => (live ? [] : [message]),
  streamEvents: async function* () {
    if (live) yield message;
  },
});

function App() {
  const { events, error } = useSessionEvents(SESSION_ID, {
    client,
    workspaceId: WORKSPACE_ID,
    replay: live ? "full" : "windowed",
  });
  return (
    <TooltipProvider>
      <main style={{ width: "min(760px, 100%)", margin: "auto" }}>
        {error ? <p role="alert">{error.message}</p> : null}
        <MessageTimeline events={events} />
      </main>
    </TooltipProvider>
  );
}

Object.assign(window, { losslessExpectedText: text });
createRoot(document.getElementById("root")!).render(<App />);
