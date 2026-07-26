// ----------------------------------------------------------------------------
// Machines / enrollment UI screenshot harness (M9 / V12).
//
// A self-contained, hooks-free render of every state-matrix cell + the
// enrollment flow + dock-parity + polish surfaces. The screenshot script drives
// it by `?view=<id>&w=<width>` (width simulates desktop/tablet/mobile) and clips
// to the `[data-shot]` root. Purely presentational components fed seed fixtures
// — no client, no network, deterministic for the headless capture.
// ----------------------------------------------------------------------------
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EnrollmentConsent,
  EnrollmentDeviceFlow,
  MachineCard,
  MachineDockBar,
  MachineStatusPill,
  MachinesDashboard,
  SharedMachineDisclosure,
  type MachinesResponse,
  type MachineView,
} from "../src/index";
import {
  consentHeadlessMachine,
  consentMachine,
  contendedMachine,
  deviceFlowSeed,
  displayUnavailableMachine,
  emptyMachinesResponse,
  enrollingMachine,
  fullMachinesResponse,
  modalBox,
  offlineMachine,
  onlineMachine,
  reconnectingMachine,
  consentRequiredMachine,
  sharedMachine,
  swappedMachinesResponse,
} from "./machines-fixtures";
import "./styles.css";

/** A single named machine card centered on the page (state-matrix cell). */
function CardCell({ machine }: { machine: MachineView }) {
  return (
    <div className="mx-auto w-full max-w-md">
      <MachineCard machine={machine} onAttach={() => {}} />
    </div>
  );
}

function Dashboard({ data }: { data: MachinesResponse }) {
  return (
    <MachinesDashboard
      machines={data.machines}
      activeSandboxId={data.activeSandboxId}
      onAttach={() => {}}
      onEnroll={() => {}}
      onRefresh={() => {}}
    />
  );
}

function SurfaceStub() {
  return (
    <div className="flex h-40 flex-col gap-2 p-2 font-og-mono text-[11px] text-og-fg-muted">
      <div className="flex gap-3 border-b border-og-border pb-1 text-og-fg">
        <span className="border-b-2 border-og-accent pb-1 text-og-fg">Files</span>
        <span>Terminal</span>
        <span>Desktop</span>
      </div>
      <div className="text-og-status-running">+ src/app.ts</div>
      <div className="text-og-status-waiting">~ README.md</div>
      <div className="text-og-fg-subtle">$ echo $HOSTNAME</div>
    </div>
  );
}

/** Side-by-side dock-parity: Modal vs selfhosted render IDENTICALLY below the bar. */
function DockParity() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1">
        <p className="px-2.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
          Modal box
        </p>
        <MachineDockBar name="Session sandbox (Modal)" kind="modal" state="online" />
        <SurfaceStub />
      </div>
      <div className="overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1">
        <p className="px-2.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
          Selfhosted machine
        </p>
        <MachineDockBar
          name="dev-desktop"
          kind="selfhosted"
          state="online"
          sharedSessionCount={2}
        />
        <SharedMachineDisclosure sharedSessionCount={2} />
        <SurfaceStub />
      </div>
    </div>
  );
}

/** All connection pills + state badges in one strip (the polish status-pill view). */
function StatusPills() {
  const states = [
    "online",
    "reconnecting",
    "offline",
    "consent_required",
    "display_unavailable",
    "enrolling",
  ] as const;
  return (
    <div className="flex flex-col gap-3">
      {states.map((s) => (
        <div key={s} className="flex items-center gap-3">
          <span className="w-44 font-og-mono text-[11px] text-og-fg-subtle">{s}</span>
          <MachineStatusPill state={s} sharedSessionCount={s === "online" ? 3 : 1} />
        </div>
      ))}
    </div>
  );
}

/** The swap transition: before (Modal active) → after (selfhosted active). */
function SwapTransition() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-og-fg-subtle">
          Before · Modal active
        </p>
        <Dashboard data={fullMachinesResponse} />
      </div>
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-og-fg-subtle">
          After · swapped to machine
        </p>
        <Dashboard data={swappedMachinesResponse} />
      </div>
    </div>
  );
}

type ViewDef = { id: string; node: ReactNode; padded?: boolean };

const VIEWS: Record<string, ViewDef> = {
  // --- IA / flow (pass 1) ---
  "flow-device": {
    id: "flow-device",
    node: (
      <div className="mx-auto max-w-md">
        <EnrollmentDeviceFlow {...deviceFlowSeed} phase="pending" onCopyCode={() => {}} />
      </div>
    ),
  },
  "flow-list": { id: "flow-list", node: <Dashboard data={fullMachinesResponse} /> },
  "flow-swap": { id: "flow-swap", node: <SwapTransition /> },
  // --- dock parity (pass 2) ---
  "dock-parity": { id: "dock-parity", node: <DockParity /> },
  // --- state coverage (pass 3): one card per state ---
  "state-empty": { id: "state-empty", node: <Dashboard data={emptyMachinesResponse} /> },
  "state-enrolling": { id: "state-enrolling", node: <CardCell machine={enrollingMachine} /> },
  "state-online": { id: "state-online", node: <CardCell machine={onlineMachine} /> },
  "state-reconnecting": {
    id: "state-reconnecting",
    node: <CardCell machine={reconnectingMachine} />,
  },
  "state-offline": { id: "state-offline", node: <CardCell machine={offlineMachine} /> },
  "state-consent_required": {
    id: "state-consent_required",
    node: <CardCell machine={consentRequiredMachine} />,
  },
  "state-display_unavailable": {
    id: "state-display_unavailable",
    node: <CardCell machine={displayUnavailableMachine} />,
  },
  "state-shared": { id: "state-shared", node: <CardCell machine={sharedMachine} /> },
  // The full grid (all states at once) — the headline dashboard shot.
  "dashboard-full": { id: "dashboard-full", node: <Dashboard data={fullMachinesResponse} /> },
  "dashboard-contended": {
    id: "dashboard-contended",
    node: <CardCell machine={contendedMachine} />,
  },
  "dashboard-modal": { id: "dashboard-modal", node: <CardCell machine={modalBox} /> },
  // --- polish (pass 5) ---
  "status-pills": { id: "status-pills", node: <StatusPills /> },
  "shared-disclosure": {
    id: "shared-disclosure",
    node: (
      <div className="mx-auto max-w-md">
        <SharedMachineDisclosure sharedSessionCount={2} density="full" />
      </div>
    ),
  },
  "consent-whole-machine": {
    id: "consent-whole-machine",
    node: (
      <EnrollmentConsent
        userCode="WXYZ-4821"
        machine={consentMachine}
        phase="review"
        onApprove={() => {}}
        onDeny={() => {}}
      />
    ),
  },
  "consent-headless": {
    id: "consent-headless",
    node: (
      <EnrollmentConsent
        userCode="WXYZ-4821"
        machine={consentHeadlessMachine}
        phase="review"
        onApprove={() => {}}
        onDeny={() => {}}
      />
    ),
  },
  "consent-approved": {
    id: "consent-approved",
    node: <EnrollmentConsent userCode="WXYZ-4821" machine={consentMachine} phase="approved" />,
  },
  "consent-denied": {
    id: "consent-denied",
    node: <EnrollmentConsent userCode="WXYZ-4821" machine={consentMachine} phase="denied" />,
  },
};

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const viewId = params.get("view") ?? "dashboard-full";
  const theme = params.get("theme") === "light" ? "light" : "dark";
  const view = VIEWS[viewId] ?? VIEWS["dashboard-full"]!;

  // Signal "rendered" to the screenshot driver once layout settles.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className="og-root min-h-dvh bg-og-bg"
      data-og-theme={theme === "light" ? "light" : undefined}
      data-ready={ready ? "true" : "false"}
    >
      <div data-shot data-view={viewId} className="p-5">
        {view.node}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
