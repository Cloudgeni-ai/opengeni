import { createRoot } from "react-dom/client";
import { SessionConversation } from "@opengeni/react/session-ui";
import { fakeClient } from "../test/fake-client";
import {
  ARCHIVED_SESSION_ID,
  ARCHIVED_WORKSPACE_ID,
  archivedTranscriptEvents,
} from "../test/fixtures/archived-transcript";
import "./styles.css";

// Deterministic sample data, rendered by the production conversation and styles.
const client = fakeClient({
  getSession: async () =>
    ({
      id: ARCHIVED_SESSION_ID,
      status: "idle",
      importedArchive: {
        importId: "old-host/chat-42",
        importedAt: "2026-10-01T06:30:00.000Z",
        readOnly: true,
      },
    }) as never,
  getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
  listHumanInputRequests: async () => [],
  streamEvents: async function* () {},
  listEvents: async () => archivedTranscriptEvents(),
});

createRoot(document.getElementById("root")!).render(
  <main className="og-root mx-auto flex h-full max-w-4xl flex-col bg-og-bg p-4 text-og-fg">
    <header className="shrink-0 border-b border-og-border pb-3">
      <h1 className="text-lg font-medium">Customer migration plan</h1>
      <p className="text-sm text-og-muted">March 1, 2024 · Sample imported conversation</p>
    </header>
    <SessionConversation
      client={client}
      workspaceId={ARCHIVED_WORKSPACE_ID}
      sessionId={ARCHIVED_SESSION_ID}
      modelPicker={false}
    />
  </main>,
);
