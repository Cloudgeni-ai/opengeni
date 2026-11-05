import { RotateCcwIcon } from "lucide-react";
import { OpengeniGlyph } from "./support-ticket";
import { Kbd, MOD_KEY, StatusGlyph } from "./ticket-glyphs";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AgentPanelLoadBoundary,
  AgentPanelPresenceGate,
  createAgentPanelLoadLifecycle,
  createBrowserAgentPanelLoadEnvironment,
  loadAgentPanelModule,
  removeAgentPanelReloadParameter,
  shouldRestoreAgentPanel,
} from "./agent-panel-load";
import { NorthstarMark, SupportInbox } from "./support-inbox";
import { SupportTicketView } from "./support-ticket";
import type { SupportCase } from "./types";
import { useSupportDemo } from "./use-support-demo";
import "./styles.css";

const agentPanelLoadEnvironment = createBrowserAgentPanelLoadEnvironment(import.meta.url);
const restoreAgentPanel = shouldRestoreAgentPanel(agentPanelLoadEnvironment);
const agentPanelLoadLifecycle = createAgentPanelLoadLifecycle(restoreAgentPanel);
removeAgentPanelReloadParameter();

const SupportAgentPanel = lazy(async () => {
  const loadGeneration = agentPanelLoadLifecycle.capture();
  const mod = await loadAgentPanelModule(
    () => import("./support-agent-panel"),
    agentPanelLoadEnvironment,
    () => agentPanelLoadLifecycle.isCurrent(loadGeneration),
  );
  return { default: mod.SupportAgentPanel };
});

declare global {
  interface Window {
    __northstarDemoRoot?: Root;
  }
}

function NorthstarApp() {
  const demo = useSupportDemo();
  const [agentEnabled, setAgentEnabled] = useState(restoreAgentPanel);
  const [agentPanelExpanded, setAgentPanelExpanded] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState("TKT-2847");

  function setAgent(enabled: boolean) {
    agentPanelLoadLifecycle.setEnabled(enabled);
    setAgentEnabled(enabled);
    if (!enabled) setAgentPanelExpanded(false);
    setSessionId(null);
  }

  // The shortcut always toggles from the latest rendered state.
  const toggleAgentRef = useRef(() => setAgent(!agentEnabled));
  toggleAgentRef.current = () => setAgent(!agentEnabled);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleAgentRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (demo.loading && !demo.state) {
    return <LoadingScreen />;
  }

  if (!demo.state) {
    return <BackendError message={demo.error?.message ?? "Demo backend unavailable."} />;
  }
  if (!Array.isArray(demo.state.cases)) {
    return <LoadingScreen />;
  }
  const selectedCase =
    demo.state.cases.find(({ ticket }) => ticket.id === selectedTicketId) ?? demo.state.cases[0];
  if (!selectedCase) {
    return <BackendError message="The demo ticket queue is empty." />;
  }
  const selectedState = { revision: demo.state.revision, ...selectedCase };

  return (
    <div
      className={
        agentEnabled
          ? agentPanelExpanded
            ? "northstar grid h-dvh min-w-[1120px] grid-cols-[236px_minmax(360px,1fr)_620px] gap-2 overflow-hidden bg-ns-canvas p-2 pl-0 transition-[grid-template-columns] duration-300 ease-out"
            : "northstar grid h-dvh min-w-[1120px] grid-cols-[252px_minmax(460px,1fr)_430px] gap-2 overflow-hidden bg-ns-canvas p-2 pl-0 transition-[grid-template-columns] duration-300 ease-out"
          : "northstar grid h-dvh min-w-[980px] grid-cols-[276px_minmax(0,1fr)] gap-2 overflow-hidden bg-ns-canvas p-2 pl-0 transition-[grid-template-columns] duration-300 ease-out"
      }
      data-agent-enabled={agentEnabled}
      data-og-density="compact"
      data-og-theme="light"
    >
      <SupportInbox
        state={demo.state}
        selectedTicketId={selectedCase.ticket.id}
        agentEnabled={agentEnabled}
        onSelectTicket={(ticketId) => {
          setSelectedTicketId(ticketId);
          setSessionId(null);
        }}
      />

      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-ns-sheet shadow-[0_1px_3px_rgba(18,26,51,0.06),0_0_0_1px_rgba(18,26,51,0.07)]">
        <ProductHeader
          supportCase={selectedCase}
          agentEnabled={agentEnabled}
          onAgentEnabledChange={setAgent}
          onReset={() => {
            setSessionId(null);
            setSelectedTicketId("TKT-2847");
            void demo.reset();
          }}
        />
        <SupportTicketView
          key={selectedCase.ticket.id}
          state={selectedState}
          lastEvent={demo.lastEvent?.ticketId === selectedCase.ticket.id ? demo.lastEvent : null}
          agentEnabled={agentEnabled}
          onUpdateTicket={(changes) => demo.updateTicket(selectedCase.ticket.id, changes)}
          onAddNote={(body) => demo.addNote(selectedCase.ticket.id, body)}
          onSendReply={(body) => demo.sendReply(selectedCase.ticket.id, body)}
        />
      </main>

      <AnimatePresence initial={false}>
        {agentEnabled ? (
          <motion.div
            key="opengeni-panel"
            initial={{ opacity: 0, x: 56 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 56 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="min-h-0 min-w-0 overflow-hidden rounded-xl shadow-[0_8px_30px_rgba(17,19,17,0.12),0_0_0_1px_rgba(17,19,17,0.9)]"
          >
            <AgentPanelPresenceGate>
              <AgentPanelLoadBoundary>
                <Suspense fallback={<AgentPanelSkeleton />}>
                  <SupportAgentPanel
                    health={demo.health}
                    supportCase={selectedCase}
                    sessionId={sessionId}
                    expanded={agentPanelExpanded}
                    onExpandedChange={setAgentPanelExpanded}
                    onSessionCreated={setSessionId}
                    onClearSession={() => setSessionId(null)}
                  />
                </Suspense>
              </AgentPanelLoadBoundary>
            </AgentPanelPresenceGate>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ProductHeader({
  supportCase,
  agentEnabled,
  onAgentEnabledChange,
  onReset,
}: {
  supportCase: SupportCase;
  agentEnabled: boolean;
  onAgentEnabledChange: (enabled: boolean) => void;
  onReset: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-6 border-b border-ns-line px-6">
      <p className="flex min-w-0 items-center gap-2 text-[13px] text-ns-muted">
        <span>{supportCase.ticket.inbox === "mine" ? "My inbox" : "Unassigned"}</span>
        <span className="text-ns-line-strong">/</span>
        <StatusGlyph status={supportCase.ticket.status} />
        <span className="font-semibold text-ns-ink">{supportCase.ticket.id}</span>
      </p>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onReset}
          title="Put every ticket back to its starting state"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-ns-muted transition-colors hover:bg-black/[0.04] hover:text-ns-ink"
        >
          <RotateCcwIcon className="size-3.5" />
          Reset demo
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={agentEnabled}
          aria-label="Opengeni"
          aria-keyshortcuts="Meta+J Control+J"
          onClick={() => onAgentEnabledChange(!agentEnabled)}
          className={
            agentEnabled
              ? "flex h-8 items-center gap-2 rounded-lg bg-og-ink pl-2.5 pr-1.5 text-[13px] font-medium text-white transition-colors"
              : "group flex h-8 items-center gap-2 rounded-lg bg-og-ink pl-2.5 pr-1.5 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(17,19,17,0.2)] transition-colors hover:bg-black"
          }
          style={{ fontFamily: "var(--font-og)" }}
        >
          <OpengeniGlyph
            className={agentEnabled ? "size-3.5 text-og-aqua" : "size-3.5 text-white"}
          />
          {agentEnabled ? "Close Opengeni" : "Ask Opengeni"}
          <Kbd tone="dark">{`${MOD_KEY}J`}</Kbd>
        </button>
      </div>
    </header>
  );
}

function LoadingScreen() {
  return (
    <div className="grid h-dvh place-items-center bg-ns-paper text-ns-ink">
      <div className="flex items-center gap-3 text-[14px] text-ns-muted">
        <NorthstarMark className="size-5 animate-pulse text-ns-navy" />
        Opening Northstar
      </div>
    </div>
  );
}

function AgentPanelSkeleton() {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-og-offwhite">
      <div className="flex h-16 items-center gap-3 bg-og-ink px-5">
        <div className="size-6 animate-pulse rounded bg-white/15" />
        <div className="h-3 w-24 animate-pulse rounded bg-white/20" />
      </div>
    </aside>
  );
}

function BackendError({ message }: { message: string }) {
  return (
    <div className="grid h-dvh place-items-center bg-ns-paper px-6 text-ns-ink">
      <div className="max-w-md">
        <NorthstarMark className="size-6 text-ns-navy" />
        <h1 className="mt-4 text-[20px] font-semibold tracking-[-0.01em]">
          Northstar can&apos;t reach its backend
        </h1>
        <p className="mt-2 text-[14px] leading-6 text-ns-muted">{message}</p>
        <p className="mt-4 text-[14px] leading-6 text-ns-muted">
          Start it from this example&apos;s folder with{" "}
          <code className="rounded bg-ns-rail px-1.5 py-0.5 text-[13px] text-ns-ink">
            bun run server
          </code>
          , then reload.
        </p>
      </div>
    </div>
  );
}

const container = document.getElementById("root")!;
const root = window.__northstarDemoRoot ?? createRoot(container);
window.__northstarDemoRoot = root;
root.render(<NorthstarApp />);
