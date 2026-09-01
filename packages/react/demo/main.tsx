import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatComposer,
  ApprovalSurface,
  HumanInputSurface,
  MessageTimeline,
  OpenGeniProvider,
  SessionStatus,
  projectPendingApprovals,
  useAvailableModels,
  useComposer,
  useFileAttachments,
  useHumanInputRequests,
  useOpenGeni,
  useSession,
  useSessionEvents,
  useSessionControl,
} from "@opengeni/react";
import { MANAGER_SESSION_ID, MockOpenGeniClient } from "./mock";
import { FRAMEWORK_DEMO_DESCRIPTION } from "../../../test/fixtures/framework-session/demo-scenario";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
function Demo() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  return (
    <div className="sdk-demo" data-og-theme={theme === "light" ? "light" : undefined}>
      <header className="sdk-demo__header">
        <div>
          <p className="sdk-demo__eyebrow">OpenGeni frontend SDK</p>
          <h1>Session SDK showcase</h1>
          <p>Deterministic fixture · native React components</p>
        </div>
        <div className="sdk-demo__actions">
          <span className="sdk-demo__framework">React</span>
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>
      <main className="sdk-demo__main">
        <SessionShowcase />
      </main>
    </div>
  );
}

function SessionShowcase() {
  const { client, workspaceId } = useOpenGeni();
  const { session } = useSession(MANAGER_SESSION_ID, { pollIntervalMs: 5000 });
  const sessionEvents = useSessionEvents(MANAGER_SESSION_ID);
  const { timeline, events, sessionStatus, connectionState } = sessionEvents;
  const { models } = useAvailableModels();
  const composer = useComposer(MANAGER_SESSION_ID, {
    effectiveControl: session?.effectiveControl,
  });
  const status = sessionStatus ?? session?.status ?? null;
  const humanInput = useHumanInputRequests(MANAGER_SESSION_ID, { events });
  const approvals = projectPendingApprovals(events);
  const control = useSessionControl(MANAGER_SESSION_ID);
  const attachments = useFileAttachments();

  return (
    <section className="sdk-session" data-demo-surface="session">
      <header className="sdk-session__header">
        <div>
          <h2>Deterministic session</h2>
          <p>{FRAMEWORK_DEMO_DESCRIPTION}</p>
        </div>
        <div className="sdk-session__status">
          <span>{connectionState === "live" ? "stream live" : connectionState}</span>
          {status ? <SessionStatus status={status} /> : null}
        </div>
      </header>
      <MessageTimeline items={timeline} status={status} className="min-h-0 flex-1" />
      <div className="sdk-session__decisions" data-og-part="controls">
        <ApprovalSurface
          approvals={approvals}
          responding={control.responding}
          error={control.error}
          onApprove={async (approval) => {
            await control.approve(approval.id);
          }}
          onReject={async (approval) => {
            await control.reject(approval.id);
          }}
        />
        <HumanInputSurface
          requests={humanInput.requests}
          respondingRequestId={humanInput.respondingRequestId}
          error={humanInput.mutationError?.message ?? humanInput.error?.message ?? null}
          onSubmit={async (requestId, response) => {
            await humanInput.respond(requestId, response);
          }}
          className="sdk-session__input"
        />
      </div>
      <div className="sdk-session__composer">
        <ChatComposer
          composer={composer}
          placeholder="Message OpenGeni…"
          autoFocus
          commandContext={{
            client,
            workspaceId,
            sessionId: MANAGER_SESSION_ID,
            status,
            permissions: ["sessions:control"],
          }}
          models={models}
          selectedModel={composer.policy?.model}
          onSelectModel={composer.setModel}
          attachments={attachments}
        />
      </div>
    </section>
  );
}

const client = new MockOpenGeniClient();
Object.assign(window, { __OPENGENI_DEMO_REQUESTS__: client.requests });

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
    <Demo />
  </OpenGeniProvider>,
);
