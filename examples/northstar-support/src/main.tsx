import { OpenGeniProvider } from "@opengeni/react";
import { OpenGeniClient } from "@opengeni/sdk";
import { CheckIcon, LifeBuoyIcon, RotateCcwIcon, SparklesIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SupportAgentPanel } from "./support-agent-panel";
import { SupportInbox } from "./support-inbox";
import { SupportTicketView } from "./support-ticket";
import type { SupportCase } from "./types";
import { useSupportDemo } from "./use-support-demo";
import "./styles.css";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });

declare global {
  interface Window {
    __northstarDemoRoot?: Root;
  }
}

function NorthstarApp() {
  const demo = useSupportDemo();
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [agentPanelExpanded, setAgentPanelExpanded] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState("TKT-2847");

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
    <OpenGeniProvider client={client} workspaceId={demo.health?.workspaceId ?? "unconfigured"}>
      <div
        className={
          agentEnabled
            ? agentPanelExpanded
              ? "northstar grid h-dvh min-w-[1120px] grid-cols-[240px_minmax(360px,1fr)_620px] overflow-hidden bg-[#f7f7f5] transition-[grid-template-columns] duration-300 ease-out"
              : "northstar grid h-dvh min-w-[1120px] grid-cols-[260px_minmax(460px,1fr)_420px] overflow-hidden bg-[#f7f7f5] transition-[grid-template-columns] duration-300 ease-out"
            : "northstar grid h-dvh min-w-[980px] grid-cols-[320px_minmax(0,1fr)] overflow-hidden bg-[#f7f7f5] transition-[grid-template-columns] duration-300 ease-out"
        }
        data-agent-enabled={agentEnabled}
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

        <main className="flex min-h-0 min-w-0 flex-col bg-[#f7f7f5]">
          <ProductHeader
            supportCase={selectedCase}
            agentEnabled={agentEnabled}
            onAgentEnabledChange={(enabled) => {
              setAgentEnabled(enabled);
              if (!enabled) setAgentPanelExpanded(false);
              setSessionId(null);
            }}
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
              className="min-h-0 min-w-0 overflow-hidden"
            >
              <SupportAgentPanel
                health={demo.health}
                supportCase={selectedCase}
                sessionId={sessionId}
                expanded={agentPanelExpanded}
                onExpandedChange={setAgentPanelExpanded}
                onSessionCreated={setSessionId}
                onClearSession={() => setSessionId(null)}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </OpenGeniProvider>
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
    <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-[#deded9] bg-white px-7">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[11px] font-medium text-[#85857f]">
          <span>Inbox</span>
          <span className="text-[#c1beb5]">/</span>
          <span>{supportCase.ticket.id}</span>
        </div>
        <div className="mt-1 flex items-center gap-2.5">
          <span
            className={
              supportCase.ticket.unread
                ? "size-2 rounded-full bg-[#d86c4f]"
                : "size-2 rounded-full bg-[#59917e]"
            }
          />
          <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[#252a27]">
            {supportCase.customer.name} · {supportCase.ticket.subject}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-9 items-center gap-2 px-1 text-[12px] font-medium text-[#777771] transition hover:text-[#30332f]"
        >
          <RotateCcwIcon className="size-3.5" />
          Reset
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={agentEnabled}
          onClick={() => onAgentEnabledChange(!agentEnabled)}
          className={
            agentEnabled
              ? "group flex h-10 items-center gap-3 border-l border-[#d9d8d3] pl-5 text-left transition"
              : "group flex h-10 items-center gap-3 border-l border-[#d9d8d3] pl-5 text-left transition"
          }
        >
          <SparklesIcon
            className={agentEnabled ? "size-4 text-[#5f50c7]" : "size-4 text-[#96938e]"}
          />
          <span className="min-w-[88px]">
            <span className="block text-[12px] font-semibold text-[#333632]">OpenGeni</span>
            <span
              className={
                agentEnabled
                  ? "mt-0.5 block text-[10px] font-medium text-[#5f50c7]"
                  : "mt-0.5 block text-[10px] text-[#92918b]"
              }
            >
              {agentEnabled ? "Active" : "Off"}
            </span>
          </span>
          <span
            aria-hidden="true"
            className={
              agentEnabled
                ? "relative h-6 w-10 rounded-full bg-[#6254c7]"
                : "relative h-6 w-10 rounded-full bg-[#d2d2ce]"
            }
          >
            <motion.span
              className="absolute top-1 grid size-4 place-items-center rounded-full bg-white shadow-sm"
              animate={{ left: agentEnabled ? 20 : 4 }}
              transition={{ type: "spring", stiffness: 500, damping: 34 }}
            >
              {agentEnabled ? <CheckIcon className="size-2.5 text-[#6255d0]" /> : null}
            </motion.span>
          </span>
        </button>
      </div>
    </header>
  );
}

function LoadingScreen() {
  return (
    <div className="grid h-dvh place-items-center bg-[#f4f6f7] text-[#242b31]">
      <div className="text-center">
        <div className="mx-auto size-7 animate-spin rounded-full border-2 border-[#d7dce0] border-t-[#28715f]" />
        <p className="mt-4 text-sm text-[#7c848b]">Opening Northstar…</p>
      </div>
    </div>
  );
}

function BackendError({ message }: { message: string }) {
  return (
    <div className="grid h-dvh place-items-center bg-[#f4f6f7] px-6 text-[#242b31]">
      <div className="max-w-md rounded-2xl border border-black/[0.07] bg-white p-6 text-center shadow-sm">
        <LifeBuoyIcon className="mx-auto size-6 text-[#28715f]" />
        <h1 className="mt-3 text-lg font-semibold">Start the Northstar backend</h1>
        <p className="mt-2 text-sm leading-6 text-[#757d84]">{message}</p>
        <code className="mt-4 block rounded-xl bg-[#f4f5f6] px-3 py-2 text-xs">bun run server</code>
      </div>
    </div>
  );
}

const container = document.getElementById("root")!;
const root = window.__northstarDemoRoot ?? createRoot(container);
window.__northstarDemoRoot = root;
root.render(<NorthstarApp />);
