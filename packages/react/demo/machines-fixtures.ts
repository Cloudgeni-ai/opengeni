// ----------------------------------------------------------------------------
// Seed data for the Machines / enrollment UI screenshot harness (M9 / V12).
//
// A workspace fixture with >=1 selfhosted machine in EACH state (online /
// reconnecting / offline / headless-no-desktop / consent_required /
// shared-by-2-sessions / enrolling), a Modal box AND a selfhosted machine so a
// SWAP is exercisable, plus idle-vs-contended metric samples. No live machine is
// needed — these drive every state-matrix cell in the headless render.
// ----------------------------------------------------------------------------
import type {
  EnrollmentConsentMachine,
  MachinesResponse,
  MachineView,
  MetricSample,
} from "../src/index";

const GiB = 1024 * 1024 * 1024;

/** An idle box — low CPU, plenty of headroom. */
export const idleMetrics: MetricSample = {
  cpuPct: 7,
  load1: 0.21,
  load5: 0.18,
  load15: 0.15,
  memUsedBytes: 3.1 * GiB,
  memTotalBytes: 16 * GiB,
  diskUsedBytes: 84 * GiB,
  diskTotalBytes: 512 * GiB,
  gpuUtilPct: null,
  gpuMemBytes: null,
  runQueue: 0,
  sampledAt: "2026-06-26T09:14:00.000Z",
};

/** A contended box — pegged CPU, high load, RAM/disk pressure, a run queue. */
export const contendedMetrics: MetricSample = {
  cpuPct: 96,
  load1: 9.4,
  load5: 7.8,
  load15: 6.1,
  memUsedBytes: 14.6 * GiB,
  memTotalBytes: 16 * GiB,
  diskUsedBytes: 471 * GiB,
  diskTotalBytes: 512 * GiB,
  gpuUtilPct: 88,
  gpuMemBytes: 22 * GiB,
  runQueue: 5,
  sampledAt: "2026-06-26T09:15:00.000Z",
};

function machine(overrides: Partial<MachineView> & Pick<MachineView, "sandboxId" | "name" | "state">): MachineView {
  return {
    enrollmentId: overrides.enrollmentId ?? "enr-" + overrides.sandboxId,
    kind: "selfhosted",
    active: false,
    isSessionGroup: false,
    os: "linux",
    arch: "x86_64",
    hasDisplay: true,
    allowScreenControl: true,
    sharedSessionCount: 1,
    lastSeenAt: "2026-06-26T09:15:00.000Z",
    metrics: idleMetrics,
    ...overrides,
  };
}

// The session's Modal group box (synthetic isSessionGroup entry) — the swap source.
export const modalBox: MachineView = machine({
  sandboxId: "modal-session-box",
  enrollmentId: null,
  name: "Session sandbox (Modal)",
  kind: "modal",
  isSessionGroup: true,
  os: "linux",
  arch: "x86_64",
  hasDisplay: true,
  allowScreenControl: true,
  state: "online",
  active: true,
  metrics: idleMetrics,
});

// A selfhosted machine, online + idle (the swap TARGET — heterogeneous swap).
export const onlineMachine: MachineView = machine({
  sandboxId: "sh-online",
  name: "jorgen-desktop",
  state: "online",
  metrics: idleMetrics,
});

// Online but CONTENDED (the contended-metrics cell).
export const contendedMachine: MachineView = machine({
  sandboxId: "sh-contended",
  name: "build-box-01",
  os: "linux",
  arch: "aarch64",
  state: "online",
  metrics: contendedMetrics,
});

export const reconnectingMachine: MachineView = machine({
  sandboxId: "sh-reconnecting",
  name: "wifi-laptop",
  state: "reconnecting",
  lastSeenAt: "2026-06-26T09:14:40.000Z",
  metrics: idleMetrics,
});

export const offlineMachine: MachineView = machine({
  sandboxId: "sh-offline",
  name: "office-mini",
  state: "offline",
  lastSeenAt: "2026-06-26T07:02:00.000Z",
  metrics: null,
});

export const consentRequiredMachine: MachineView = machine({
  sandboxId: "sh-consent",
  name: "new-macbook",
  os: "macos",
  arch: "arm64",
  state: "consent_required",
  allowScreenControl: false,
  metrics: idleMetrics,
});

export const displayUnavailableMachine: MachineView = machine({
  sandboxId: "sh-headless",
  name: "ci-runner-headless",
  state: "display_unavailable",
  hasDisplay: false,
  allowScreenControl: false,
  metrics: idleMetrics,
});

export const sharedMachine: MachineView = machine({
  sandboxId: "sh-shared",
  name: "shared-gpu-rig",
  state: "online",
  sharedSessionCount: 2,
  metrics: contendedMetrics,
});

export const enrollingMachine: MachineView = machine({
  sandboxId: "sh-enrolling",
  name: "windows-tower",
  os: "windows",
  arch: "x86_64",
  state: "enrolling",
  lastSeenAt: null,
  metrics: null,
});

// The full populated dashboard — a Modal box + a selfhosted online machine (swap
// pair) + one machine in each remaining state.
export const fullMachinesResponse: MachinesResponse = {
  activeSandboxId: "modal-session-box",
  activeEpoch: 7,
  machines: [
    modalBox,
    onlineMachine,
    contendedMachine,
    sharedMachine,
    reconnectingMachine,
    consentRequiredMachine,
    displayUnavailableMachine,
    offlineMachine,
    enrollingMachine,
  ],
};

// The empty-state dashboard (no machines yet).
export const emptyMachinesResponse: MachinesResponse = {
  activeSandboxId: null,
  activeEpoch: 0,
  machines: [],
};

// After a SWAP: the selfhosted machine is now active, the Modal box demoted.
export const swappedMachinesResponse: MachinesResponse = {
  activeSandboxId: "sh-online",
  activeEpoch: 8,
  machines: fullMachinesResponse.machines.map((m) => ({
    ...m,
    active: m.sandboxId === "sh-online",
  })),
};

// Consent-screen seed: a machine offering a display + requesting screen control.
export const consentMachine: EnrollmentConsentMachine = {
  machineName: "jorgen-desktop",
  os: "linux",
  arch: "x86_64",
  canOfferDisplay: true,
  requestsScreenControl: true,
};

// A headless machine for the consent screen (no display → no screen-control toggle).
export const consentHeadlessMachine: EnrollmentConsentMachine = {
  machineName: "ci-runner-headless",
  os: "linux",
  arch: "x86_64",
  canOfferDisplay: false,
  requestsScreenControl: false,
};

export const deviceFlowSeed = {
  userCode: "WXYZ-4821",
  verificationUri: "https://get.opengeni.ai/device",
  verificationUriComplete: "https://get.opengeni.ai/device?code=WXYZ-4821",
  installCommand: "curl -fsSL https://get.opengeni.ai/install.sh | sh",
  intervalSeconds: 5,
  expiresInSeconds: 900,
};
