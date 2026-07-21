import { OpenGeniClient } from "@opengeni/sdk";
import { LifeBuoyIcon, SearchIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { SupportAgentPanel } from "./support-agent-panel";
import { SupportTicketView } from "./support-ticket";
import { useSupportDemo } from "./use-support-demo";
import "./styles.css";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });

declare global {
  interface Window {
    __northstarDemoRoot?: Root;
  }
}

function WorkspaceChatApp() {
  const demo = useSupportDemo();
  const [sessionId, setSessionId] = useState<string | null>(null);

  function selectSession(next: string | null) {
    setSessionId(next);
  }

  if (demo.loading && !demo.state) {
    return <LoadingScreen />;
  }

  if (!demo.state) {
    return <BackendError message={demo.error?.message ?? "Demo backend unavailable."} />;
  }

  return (
    <OpenGeniProvider client={client} workspaceId={demo.health?.workspaceId ?? "unconfigured"}>
      <div className="northstar og-root h-dvh overflow-hidden bg-[#f7f7f9]" data-og-theme="light">
        <TopNavigation />
        <div className="grid h-[calc(100dvh-57px)] min-h-0 grid-cols-[minmax(520px,1fr)_minmax(390px,42%)] max-lg:grid-cols-[minmax(460px,1fr)_420px] max-md:block max-md:overflow-y-auto">
          <SupportTicketView state={demo.state} lastEvent={demo.lastEvent} onReset={demo.reset} />
          <div className="min-h-0 max-md:h-[780px]">
            <SupportAgentPanel
              health={demo.health}
              sessionId={sessionId}
              onSessionCreated={(id) => selectSession(id)}
              onClearSession={() => selectSession(null)}
            />
          </div>
        </div>
      </div>
    </OpenGeniProvider>
  );
}

function TopNavigation() {
  return (
    <nav className="flex h-[57px] items-center justify-between border-b border-black/[0.07] bg-white px-5 text-[#242631]">
      <div className="flex items-center gap-7">
        <div className="flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded-[10px] bg-[#6762df] text-[13px] font-bold text-white shadow-[0_4px_10px_rgba(103,98,223,0.25)]">
            N
          </div>
          <span className="text-sm font-semibold tracking-[-0.015em]">Northstar</span>
        </div>
        <div className="flex items-center gap-1 max-sm:hidden">
          <span className="rounded-lg bg-[#f1f1f5] px-3 py-1.5 text-xs font-semibold text-[#40434d]">
            Inbox
          </span>
          <span className="px-3 py-1.5 text-xs text-[#868a95]">Customers</span>
          <span className="px-3 py-1.5 text-xs text-[#868a95]">Reports</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Search"
          className="grid size-8 place-items-center rounded-lg text-[#898c96] hover:bg-[#f3f3f5]"
        >
          <SearchIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Settings"
          className="grid size-8 place-items-center rounded-lg text-[#898c96] hover:bg-[#f3f3f5]"
        >
          <Settings2Icon className="size-4" />
        </button>
        <div className="ml-1 grid size-8 place-items-center rounded-full bg-[#e8e4db] text-[10px] font-bold text-[#6c6455]">
          MC
        </div>
      </div>
    </nav>
  );
}

function LoadingScreen() {
  return (
    <div className="grid h-dvh place-items-center bg-[#f7f7f9] text-[#242631]">
      <div className="text-center">
        <div className="mx-auto size-7 animate-spin rounded-full border-2 border-[#d8d8e4] border-t-[#6762df]" />
        <p className="mt-4 text-sm text-[#7c808b]">Loading Northstar…</p>
      </div>
    </div>
  );
}

function BackendError({ message }: { message: string }) {
  return (
    <div className="grid h-dvh place-items-center bg-[#f7f7f9] px-6 text-[#242631]">
      <div className="max-w-md rounded-2xl border border-black/[0.07] bg-white p-6 text-center shadow-sm">
        <LifeBuoyIcon className="mx-auto size-6 text-[#6762df]" />
        <h1 className="mt-3 text-lg font-semibold">Start the demo backend</h1>
        <p className="mt-2 text-sm leading-6 text-[#757985]">{message}</p>
        <code className="mt-4 block rounded-xl bg-[#f4f4f6] px-3 py-2 text-xs">bun run server</code>
      </div>
    </div>
  );
}

const container = document.getElementById("root")!;
const root = window.__northstarDemoRoot ?? createRoot(container);
window.__northstarDemoRoot = root;
root.render(<WorkspaceChatApp />);
