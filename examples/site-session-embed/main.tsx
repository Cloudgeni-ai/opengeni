import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { createOpenGeniSiteClient } from "@opengeni/sdk/site";
import { OpenGeniProvider, SessionConversation } from "@opengeni/react";
import "@opengeni/react/compiled.css";
import "./style.css";

const site = createOpenGeniSiteClient();

function Conversation({ id }: { id: string }) {
  return (
    <SessionConversation
      sessionId={id}
      composerProps={{ placeholder: "Send a message through OpenGeni…" }}
    />
  );
}

function App() {
  const [id, setId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await site.client.createSession(site.workspaceId, {
        startMode: "realtime",
        resources: [],
        skills: [],
        tools: [],
        metadata: {},
        visibility: "workspace",
        idempotencyKey: crypto.randomUUID(),
      });
      setId(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <span>OPENGENI · EMBED TEST</span>
        <h1>A real conversation. Inside a Site.</h1>
        <p>
          Standard SDK, React timeline, durable composer and live events. No credentials in the
          page.
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {id ? (
        <section className="conversation-panel">
          <Conversation id={id} />
        </section>
      ) : (
        <button disabled={busy} onClick={create}>
          {busy ? "Creating…" : "Start a conversation"}
        </button>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={site.client} workspaceId={site.workspaceId}>
    <App />
  </OpenGeniProvider>,
);
