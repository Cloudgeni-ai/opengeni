// Connected Machine card preview: the console's real SessionCapabilityCard
// inside the real MessageTimeline, for a turn where the person needs a computer
// that isn't connected yet. Machines come from a synthetic client, so each state
// is deterministic and nothing reaches an API.
//   ?state=other|active|offline|none   ?theme=light|dark
//   other:   a desktop that isn't the one the person means is online, their
//            laptop is offline, and this chat runs on neither.
//   active:  this chat already runs on the desktop.
//   offline: only the offline laptop is connected.
//   none:    nothing is connected yet.
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { MachinesResponse, MachineView, SessionEvent } from "@opengeni/sdk";
import { MessageTimeline, OpenGeniProvider, type AuthNeededItem } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { SessionCapabilityCard } from "@opengeni/react/app/components/capabilities/session-capability-card";
import { EventLog } from "./timeline-fixtures";
import { MockOpenGeniClient } from "./mock";
import { offlineMachine, onlineMachine } from "./machines-fixtures";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "other";
const dark = params.get("theme") === "dark";

const desktop: MachineView = {
  ...onlineMachine,
  sandboxId: "sh-desktop",
  enrollmentId: "enr-desktop",
  name: "Studio desktop",
  os: "linux",
  hasDisplay: true,
  allowScreenControl: true,
  scope: "user",
  active: state === "active",
};
const laptop: MachineView = {
  ...offlineMachine,
  sandboxId: "sh-laptop",
  enrollmentId: "enr-laptop",
  name: "Home laptop",
  os: "windows",
  hasDisplay: true,
  allowScreenControl: false,
  scope: "user",
  active: false,
};

class PreviewClient extends MockOpenGeniClient {
  override async listMachines(): Promise<MachinesResponse> {
    const machines = state === "none" ? [] : state === "offline" ? [laptop] : [desktop, laptop];
    return {
      activeSandboxId: state === "active" ? desktop.sandboxId : null,
      activeEpoch: 1,
      machines,
    };
  }
  override async listAttachedBrowsers() {
    return { revision: 1, bridges: [], devices: [] } as never;
  }
  // The card offers "Use" only where the chat can move; nothing moves here.
  async swapActiveSandbox() {
    return {} as never;
  }
}

function events(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-downloads";
  log.push("user.message", { text: "Tidy up the Downloads folder on my laptop." });
  log.push("user.message", {
    text: "The desktop isn't my laptop. My laptop is a Windows laptop I have at home.",
  });
  log.push(
    "tool.auth_needed",
    {
      serverId: "opengeni",
      toolName: "capability_authorization_request",
      providerDomain: "opengeni.ai",
      reason: "missing_connection",
      capability: {
        id: "api:connected-machine",
        name: "Connected Machine",
        kind: "api",
        source: "built_in",
        action: "connect",
        rationale: "Connect the Windows laptop at home so I can tidy its Downloads folder.",
        requiredVariables: [],
      },
    },
    turn,
  );
  log.push(
    "agent.message.completed",
    { text: "Connect your laptop with the card above and I'll tidy its Downloads folder." },
    turn,
  );
  log.push("turn.completed", {}, turn);
  return log.events;
}

function Preview() {
  const client = useMemo(() => new PreviewClient(), []);
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  const context = useMemo(
    () =>
      ({
        client,
        accessContext: {
          subjectId: "user:preview",
          workspaceGrants: [
            {
              workspaceId: WORKSPACE_ID,
              permissions: [
                "sessions:read",
                "sessions:control",
                "enrollments:read",
                "enrollments:manage",
              ],
            },
          ],
        },
        workspaces: [{ id: WORKSPACE_ID, kind: "personal" }],
        workspaceCapabilityCatalog: [],
      }) as never,
    [client],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppHostProvider
        host={{
          api: { apiBaseUrl: "https://app.opengeni.ai" } as never,
          navigation: undefined as never,
        }}
      >
        <AppContext.Provider value={context}>
          <div className="og-root h-screen overflow-auto bg-bg text-fg">
            <main className="mx-auto max-w-[760px] px-4 py-8" data-shot="">
              <MessageTimeline
                events={events()}
                renderAuthNeeded={(item: AuthNeededItem) => (
                  <SessionCapabilityCard
                    item={item}
                    workspaceId={WORKSPACE_ID}
                    sessionId="session-downloads"
                    sendContext={() => ({ blocked: null, awaitingHuman: false, extras: {} })}
                  />
                )}
              />
            </main>
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
