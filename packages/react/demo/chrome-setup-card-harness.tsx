// Chrome setup card preview: the console's real SessionCapabilityCard inside the
// real MessageTimeline, for the turn where browser_open finds no connected
// Chrome and posts the card itself. Machines and Chrome profiles come from a
// synthetic client, so each state is deterministic and nothing reaches an API.
//   ?state=no-computer|computer|chrome|before   ?theme=light|dark
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { MachinesResponse, MachineView, SessionEvent } from "@opengeni/sdk";
import { MessageTimeline, OpenGeniProvider, type AuthNeededItem } from "@opengeni/react";
import { AppContext } from "../src/app/app-context";
import { AppHostProvider } from "../src/app/lib/app-host";
import { SessionCapabilityCard } from "../src/app/components/capabilities/session-capability-card";
import { EventLog } from "./timeline-fixtures";
import { MockOpenGeniClient } from "./mock";
import { onlineMachine } from "./machines-fixtures";
import "../../../apps/web/src/styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "no-computer";
const dark = params.get("theme") === "dark";

const mac: MachineView = {
  ...onlineMachine,
  sandboxId: "sh-mac",
  enrollmentId: "enr-mac",
  name: "Kari's MacBook Air",
  os: "macos",
  arch: "arm64",
  hasDisplay: true,
  scope: "user",
  active: false,
};

class PreviewClient extends MockOpenGeniClient {
  override async listMachines(): Promise<MachinesResponse> {
    return {
      activeSandboxId: null,
      activeEpoch: 1,
      machines: state === "no-computer" ? [] : [mac],
    };
  }
  override async listAttachedBrowsers() {
    return {
      revision: 2,
      bridges: [],
      devices:
        state === "chrome"
          ? [
              {
                id: "device-work",
                enrollmentId: "enr-mac",
                name: "Work",
                profileLabel: "Work",
                browserName: "Chrome",
                state: "connected",
                capabilities: { debuggerAttachment: true },
              },
            ]
          : [],
    } as never;
  }
}

/** The first turn as the agent now sees it: browser_open fails and posts the card. */
function afterEvents(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-linkedin";
  log.push("user.message", {
    text: "Use LinkedIn in my browser and draft a reply to my latest message.",
  });
  log.tool(
    {
      name: "browser_open",
      id: "call-open",
      arguments: {
        placement: { kind: "attached_device" },
        initialUrl: "https://www.linkedin.com/messaging/",
      },
      output: {
        error: {
          code: "attached_browser_unavailable",
          message:
            "No Chrome profile is connected through the browser extension. A card that fixes this is now posted in this chat…",
        },
      },
      error: true,
    },
    turn,
  );
  log.push(
    "tool.auth_needed",
    {
      serverId: "opengeni",
      toolName: "browser_open",
      providerDomain: "opengeni.ai",
      reason: "missing_connection",
      purpose: "chrome",
      capability: {
        id: "api:connected-machine",
        name: "Connected Machine",
        kind: "api",
        source: "built_in",
        action: "connect",
        rationale: "Connect your Chrome so the agent can use it.",
        requiredVariables: [],
      },
    },
    turn,
  );
  log.push(
    "agent.message.completed",
    {
      text: "Your Chrome isn't connected yet. Use the card above and I'll open LinkedIn once it is.",
    },
    turn,
  );
  log.push("turn.completed", {}, turn);
  return log.events;
}

/** What the person saw before: a text reply with no way forward. */
function beforeEvents(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-linkedin";
  log.push("user.message", {
    text: "Use LinkedIn in my browser and draft a reply to my latest message.",
  });
  log.tool(
    {
      name: "browser_open",
      id: "call-open",
      arguments: { placement: { kind: "attached_device" } },
      output: { error: { code: "attached_browser_unavailable" } },
      error: true,
    },
    turn,
  );
  log.push(
    "agent.message.completed",
    {
      text: "Browser isn't connected. Connect your Chrome browser to Opengeni and I'll continue with LinkedIn.",
    },
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
          subjectId: "user:kari",
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
  const events = state === "before" ? beforeEvents() : afterEvents();
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
                events={events}
                renderAuthNeeded={(item: AuthNeededItem) => (
                  <SessionCapabilityCard
                    item={item}
                    workspaceId={WORKSPACE_ID}
                    sessionId="session-linkedin"
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
