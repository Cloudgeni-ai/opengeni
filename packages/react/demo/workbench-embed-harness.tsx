import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniClient, type SessionEvent } from "@opengeni/sdk";
import { OpenGeniProvider, SandboxWorkspace, useSessionEvents } from "../src/index";
import "./styles.css";

/* ----------------------------------------------------------------------------
   M8 real-client embedder harness — the EXACT integration tracked issue uses:
   `<OpenGeniProvider>` + `<SandboxWorkspace>` wired to a real `@opengeni/sdk`
   client, with NO host-injected tabs and NO host `initialTab`. This isolates
   the WORKBENCH's own behavior from apps/web's warm-on-open session chrome, so
   the cold-paint thesis (paint tree+Changes from capture, zero Channel-A before
   first paint) and D1 (workbench picks its own default tab pre-paint) can be
   proven against real capture data.

   Query params: ?ws=<workspaceId>&sid=<sessionId>&theme=dark|light
   The client's baseUrl is the page origin — the evidence server proxies /v1 to
   the real API, so everything is same-origin (no CORS, SSE proxied cleanly).
   -------------------------------------------------------------------------- */

const params = new URLSearchParams(location.search);
const WS = params.get("ws") ?? "";
const SID = params.get("sid") ?? "";
const theme = params.get("theme") === "light" ? "light" : "dark";
// `preload=1` = the embedder fetches the session event log (which carries the
// `workspace.revision.captured` announce) BEFORE mounting the dock, exactly as
// apps/web does. That makes `initialWorkspaceTab` see the announce at mount and
// pick Changes pre-paint (D1). Without it, events arrive async → the pre-paint
// default falls back to Files (documented embedder contract).
const preload = params.get("preload") === "1";

const client = new OpenGeniClient({ baseUrl: location.origin });

function EmbedHarness() {
  const live = useSessionEvents(SID);
  const [preloaded, setPreloaded] = useState<SessionEvent[] | null>(preload ? null : []);
  useEffect(() => {
    if (!preload) return;
    void client
      .listEvents(WS, SID, { compact: true })
      .then((e) => setPreloaded(e))
      .catch(() => setPreloaded([]));
  }, []);
  // In preload mode, block the dock mount until events are in hand (embedder
  // owns this gate); otherwise feed the live async stream.
  if (preload && preloaded === null) return <div className="og-root h-dvh bg-og-bg" />;
  const events = preload ? preloaded! : live.events;
  return (
    <div className="og-root h-dvh bg-og-bg" data-og-theme={theme === "light" ? "light" : undefined}>
      <div className="mx-auto flex h-dvh max-w-7xl flex-col px-4 py-4">
        <SandboxWorkspace
          sessionId={SID}
          events={events}
          autoSaveId="og.embed.dock"
          collapsed={false}
          primary={
            <div className="flex h-full items-center justify-center text-xs text-og-fg-subtle">
              host primary surface (embedder chat)
            </div>
          }
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client} workspaceId={WS}>
    <EmbedHarness />
  </OpenGeniProvider>,
);
