// Computer use in the desktop app when turning on never connects: the real
// switch row (as the Machines page's panel draws it) and the real sidebar
// notice, driven by the real `useThisComputer` against a simulated host whose
// agent runs but can't sign in to the server. Inside a macOS window frame.
//   ?theme=light|dark  ?limit=<ms before turning on counts as stalled>
//   ?waiting=sign_in|server|agent|another_agent|handover
import type {
  ThisComputerHost,
  ThisComputerStatus,
  ThisComputerWaitingOn,
} from "@opengeni/sdk/this-computer";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { defaultThisComputerLabels, useThisComputer } from "../src/this-computer";
import { ComputerUseNotice, ComputerUseRow } from "../src/app/components/desktop/computer-use";
import type { DesktopThisComputer } from "../src/app/components/desktop/this-computer";
import { MachineCard } from "../src/components/machine-card";
import { offlineMachine, onlineMachine } from "./machines-fixtures";
import "../../../apps/web/src/styles.css";

const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") !== "light";
const limit = Number(params.get("limit") ?? 1500);
const waitingOn = (params.get("waiting") ?? "sign_in") as ThisComputerWaitingOn;
document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
document.documentElement.classList.toggle("dark", dark);

const reading: ThisComputerStatus = {
  state: "connected",
  busy: false,
  error: null,
  machineName: "Bendik-sin-MacBook-Pro",
  management: "service",
  permissionAppName: "Opengeni Agent",
  enrollmentId: "enr-mac",
  reconnecting: true,
  waitingOn,
  ...(waitingOn === "sign_in"
    ? {
        waitingDetail:
          "Authentication rejected; transport retries paused while credentials are renewed.",
      }
    : {}),
};

const host: ThisComputerHost = {
  platform: "macos",
  productName: "Opengeni",
  status: async () => ({ ...reading }),
  connect: async () => ({ ...reading }),
  pause: async () => undefined,
  resume: async () => undefined,
  onChange: () => () => undefined,
};

const mac = {
  ...offlineMachine,
  sandboxId: "sh-mac",
  enrollmentId: "enr-mac",
  name: "Bendik-sin-MacBook-Pro",
  os: "macos",
  arch: "aarch64",
  scope: "user" as const,
  lastSeenAt: "2026-10-27T20:29:04.000Z",
};
const server = {
  ...onlineMachine,
  sandboxId: "sh-staging",
  enrollmentId: "enr-staging",
  name: "cloudgeni-staging-workspace",
  scope: "workspace" as const,
  lastSeenAt: "2026-10-28T07:39:58.000Z",
  metrics: onlineMachine.metrics && {
    ...onlineMachine.metrics,
    sampledAt: "2026-10-28T07:39:58.000Z",
  },
};

function App() {
  const computer = useThisComputer(host, "workspace", { turnOnLimitMs: limit });
  const labels = useMemo(() => defaultThisComputerLabels(), []);
  const desktop: DesktopThisComputer = {
    workspaceId: "workspace",
    computer,
    platform: "macos",
    productName: "Opengeni",
    labels,
    allowPermissions: computer.allowPermissions,
    signIn: null,
  };
  const now = Date.parse("2026-10-28T07:40:00.000Z");
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-subtle p-8">
      <div className="flex h-[640px] w-[1080px] overflow-hidden rounded-xl border border-border bg-bg shadow-2xl">
        <aside className="flex w-[248px] shrink-0 flex-col border-r border-border bg-surface">
          <div className="flex h-11 items-center gap-2 px-4">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
          <nav className="flex flex-col gap-0.5 px-2 text-sm text-fg-muted">
            {["Chats", "Automations", "Artifacts", "Machines", "Settings"].map((item) => (
              <span
                key={item}
                className={
                  item === "Machines"
                    ? "rounded-md bg-bg px-2.5 py-1.5 font-medium text-fg"
                    : "px-2.5 py-1.5"
                }
              >
                {item}
              </span>
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-2 p-2">
            <ComputerUseNotice desktop={desktop} />
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg">
              <span className="flex size-6 items-center justify-center rounded-full bg-accent text-xs text-white">
                B
              </span>
              bendik@cloudgeni.ai
            </div>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden px-8 pt-10">
          <h1 className="mb-6 text-xl font-semibold text-fg">Machines</h1>
          {/* As DesktopThisComputerPanel draws it on the Machines page. */}
          <div className="mb-6 min-w-0 rounded-lg border border-border bg-surface px-5 py-1">
            <ComputerUseRow desktop={desktop} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <MachineCard machine={mac} now={now} />
            <MachineCard machine={server} now={now} />
          </div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
