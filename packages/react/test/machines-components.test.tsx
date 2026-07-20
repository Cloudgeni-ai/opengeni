/* ----------------------------------------------------------------------------
   M9 component tests: the Machines dashboard + enrollment flow render against
   seed view-model data; every state-matrix cell renders (online / reconnecting /
   offline / consent_required / display_unavailable / enrolling / shared-in-use /
   empty); the connection-status pill maps correctly; the swap affordance gates;
   the consent screen's whole-machine + screen-control toggle render.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { registerDom, renderComponent, flush } from "./render-hook";
import { MachineCard } from "../src/components/machine-card";
import { MachinesDashboard } from "../src/components/machines-dashboard";
import { MachineMetrics } from "../src/components/machine-metrics";
import { ConnectionStatusPill, MachineStatusPill } from "../src/components/machine-status-pill";
import { MachineDockBar, SharedMachineDisclosure } from "../src/components/machine-dock-bar";
import { EnrollmentConsent } from "../src/components/enrollment-consent";
import { EnrollmentDeviceFlow } from "../src/components/enrollment-device-flow";
import {
  connectionStatusForState,
  type MachineState,
  type MachineView,
  type MetricSample,
} from "../src/types/machines";

registerDom();

const GiB = 1024 * 1024 * 1024;
const idle: MetricSample = {
  cpuPct: 7,
  load1: 0.2,
  load5: 0.18,
  load15: 0.15,
  memUsedBytes: 3 * GiB,
  memTotalBytes: 16 * GiB,
  diskUsedBytes: 80 * GiB,
  diskTotalBytes: 512 * GiB,
  gpuUtilPct: null,
  gpuMemBytes: null,
  runQueue: 0,
  sampledAt: "2026-06-26T09:14:00.000Z",
};
const contended: MetricSample = {
  ...idle,
  cpuPct: 96,
  load1: 9.4,
  memUsedBytes: 15 * GiB,
  gpuUtilPct: 88,
  gpuMemBytes: 22 * GiB,
  runQueue: 5,
};

function machine(
  overrides: Partial<MachineView> & Pick<MachineView, "sandboxId" | "state">,
): MachineView {
  return {
    enrollmentId: "enr-" + overrides.sandboxId,
    name: "test-machine",
    kind: "selfhosted",
    active: false,
    isSessionGroup: false,
    os: "linux",
    arch: "x86_64",
    hasDisplay: true,
    allowScreenControl: true,
    sharedSessionCount: 1,
    lastSeenAt: "2026-06-26T09:15:00.000Z",
    metrics: idle,
    ...overrides,
  };
}

const ALL_STATES: MachineState[] = [
  "online",
  "reconnecting",
  "offline",
  "consent_required",
  "display_unavailable",
  "enrolling",
];

describe("connectionStatusForState", () => {
  test("maps every state onto a connection pill value", () => {
    expect(connectionStatusForState("online")).toBe("online");
    expect(connectionStatusForState("consent_required")).toBe("online");
    expect(connectionStatusForState("display_unavailable")).toBe("online");
    expect(connectionStatusForState("reconnecting")).toBe("reconnecting");
    expect(connectionStatusForState("enrolling")).toBe("reconnecting");
    expect(connectionStatusForState("offline")).toBe("offline");
  });
});

describe("ConnectionStatusPill", () => {
  test("renders the three connection states with their labels", async () => {
    for (const [status, label] of [
      ["online", "Online"],
      ["reconnecting", "Reconnecting"],
      ["offline", "Offline"],
    ] as const) {
      const r = await renderComponent(<ConnectionStatusPill status={status} />);
      await flush();
      const pill = r.container.querySelector(`[data-connection-status="${status}"]`);
      expect(pill).not.toBeNull();
      expect(r.container.textContent).toContain(label);
      await r.unmount();
    }
  });
});

describe("MachineStatusPill — state matrix", () => {
  test("every state renders without crashing and carries its data attr", async () => {
    for (const state of ALL_STATES) {
      const r = await renderComponent(<MachineStatusPill state={state} />);
      await flush();
      expect(r.container.querySelector(`[data-machine-state="${state}"]`)).not.toBeNull();
      await r.unmount();
    }
  });

  test("consent_required / display_unavailable / enrolling carry a state badge", async () => {
    for (const [state, label] of [
      ["consent_required", "Consent required"],
      ["display_unavailable", "No display"],
      ["enrolling", "Enrolling"],
    ] as const) {
      const r = await renderComponent(<MachineStatusPill state={state} />);
      await flush();
      expect(r.container.querySelector(`[data-state-badge="${state}"]`)).not.toBeNull();
      expect(r.container.textContent).toContain(label);
      await r.unmount();
    }
  });

  test("shared lease (>1) renders a Shared chip", async () => {
    const r = await renderComponent(<MachineStatusPill state="online" sharedSessionCount={3} />);
    await flush();
    expect(r.container.querySelector("[data-shared-chip]")).not.toBeNull();
    expect(r.container.textContent).toContain("Shared · 3");
    await r.unmount();
  });
});

describe("MachineMetrics", () => {
  test("renders cpu/mem/disk meters from a sample", async () => {
    const r = await renderComponent(<MachineMetrics metrics={idle} />);
    await flush();
    expect(r.container.querySelector("[data-machine-metrics]")).not.toBeNull();
    expect(r.container.querySelector('[data-metric="cpu"]')).not.toBeNull();
    expect(r.container.querySelector('[data-metric="memory"]')).not.toBeNull();
    expect(r.container.querySelector('[data-metric="disk"]')).not.toBeNull();
    await r.unmount();
  });

  test("GPU meter only renders when gpuUtilPct is present", async () => {
    const without = await renderComponent(<MachineMetrics metrics={idle} />);
    await flush();
    expect(without.container.querySelector('[data-metric="gpu"]')).toBeNull();
    await without.unmount();

    const withGpu = await renderComponent(<MachineMetrics metrics={contended} />);
    await flush();
    expect(withGpu.container.querySelector('[data-metric="gpu"]')).not.toBeNull();
    expect(withGpu.container.querySelector('[data-metric="runqueue"]')).not.toBeNull();
    await withGpu.unmount();
  });

  test("null metrics shows the empty placeholder", async () => {
    const r = await renderComponent(<MachineMetrics metrics={null} />);
    await flush();
    expect(r.container.querySelector("[data-metrics-empty]")).not.toBeNull();
    await r.unmount();
  });
});

describe("MachineCard — attach/swap affordance", () => {
  test("an online, inactive machine shows an Attach button", async () => {
    const attached: MachineView[] = [];
    const m = machine({ sandboxId: "sh-a", state: "online" });
    const r = await renderComponent(<MachineCard machine={m} onAttach={(x) => attached.push(x)} />);
    await flush();
    const btn = r.container.querySelector("[data-attach]") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn!.click();
    await flush();
    expect(attached.length).toBe(1);
    expect(attached[0]?.sandboxId).toBe("sh-a");
    await r.unmount();
  });

  test("the active machine shows an Active marker and NO attach button", async () => {
    const m = machine({ sandboxId: "sh-active", state: "online", active: true });
    const r = await renderComponent(<MachineCard machine={m} onAttach={() => {}} />);
    await flush();
    expect(r.container.querySelector("[data-active-marker]")).not.toBeNull();
    expect(r.container.querySelector("[data-attach]")).toBeNull();
    await r.unmount();
  });

  test("an offline machine is not attachable", async () => {
    const m = machine({ sandboxId: "sh-off", state: "offline", metrics: null });
    const r = await renderComponent(<MachineCard machine={m} onAttach={() => {}} />);
    await flush();
    expect(r.container.querySelector("[data-attach]")).toBeNull();
    await r.unmount();
  });

  test("a shared machine renders the shared disclosure", async () => {
    const m = machine({ sandboxId: "sh-shared", state: "online", sharedSessionCount: 2 });
    const r = await renderComponent(<MachineCard machine={m} onAttach={() => {}} />);
    await flush();
    expect(r.container.querySelector("[data-shared-disclosure]")).not.toBeNull();
    expect(r.container.textContent).toContain("2 sessions are on this machine");
    await r.unmount();
  });
});

describe("MachinesDashboard", () => {
  test("empty state renders the enroll CTA", async () => {
    let enrolled = false;
    const r = await renderComponent(
      <MachinesDashboard machines={[]} onEnroll={() => (enrolled = true)} />,
    );
    await flush();
    expect(r.container.querySelector("[data-machines-empty]")).not.toBeNull();
    const cta = r.container.querySelector("[data-enroll-cta]") as HTMLButtonElement | null;
    expect(cta).not.toBeNull();
    cta!.click();
    await flush();
    expect(enrolled).toBe(true);
    await r.unmount();
  });

  test("renders a grid of machines with the active marker on the active sandbox", async () => {
    const machines = [
      machine({ sandboxId: "modal-box", state: "online", kind: "modal", isSessionGroup: true }),
      machine({ sandboxId: "sh-1", state: "online" }),
      machine({ sandboxId: "sh-2", state: "reconnecting" }),
    ];
    const r = await renderComponent(
      <MachinesDashboard machines={machines} activeSandboxId="modal-box" onAttach={() => {}} />,
    );
    await flush();
    expect(r.container.querySelector("[data-machines-grid]")).not.toBeNull();
    expect(r.container.querySelectorAll("[data-machine-card]").length).toBe(3);
    const activeCard = r.container.querySelector('[data-machine-card="modal-box"]');
    expect(activeCard?.getAttribute("data-active")).toBe("true");
    await r.unmount();
  });

  test("renders a load error", async () => {
    const r = await renderComponent(
      <MachinesDashboard machines={[]} error={new Error("nats down")} />,
    );
    await flush();
    expect(r.container.querySelector("[data-machines-error]")).not.toBeNull();
    expect(r.container.textContent).toContain("nats down");
    await r.unmount();
  });
});

describe("MachineDockBar + SharedMachineDisclosure (dock parity)", () => {
  test("the dock bar surfaces the active machine + connection pill", async () => {
    const r = await renderComponent(
      <MachineDockBar name="dev-desktop" kind="selfhosted" state="online" />,
    );
    await flush();
    expect(r.container.querySelector("[data-machine-dock-bar]")).not.toBeNull();
    expect(r.container.textContent).toContain("dev-desktop");
    expect(r.container.querySelector('[data-connection-status="online"]')).not.toBeNull();
    await r.unmount();
  });

  test("shared disclosure names the other sessions", async () => {
    const r = await renderComponent(<SharedMachineDisclosure sharedSessionCount={3} />);
    await flush();
    expect(r.container.querySelector("[data-shared-disclosure]")).not.toBeNull();
    expect(r.container.textContent).toContain("2 other sessions are on this machine");
    await r.unmount();
  });
});

describe("EnrollmentConsent — loud whole-machine consent", () => {
  const display = {
    machineName: "dev-desktop",
    os: "linux",
    arch: "x86_64",
    canOfferDisplay: true,
    requestsScreenControl: true,
  };
  const headless = {
    machineName: "ci-runner",
    os: "linux",
    arch: "x86_64",
    canOfferDisplay: false,
    requestsScreenControl: false,
  };

  test("review phase renders the consent + the screen-control toggle (display machine)", async () => {
    const r = await renderComponent(
      <EnrollmentConsent
        userCode="WXYZ-4821"
        machine={display}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    await flush();
    expect(r.container.querySelector("[data-enrollment-consent]")).not.toBeNull();
    expect(r.container.textContent).toContain("whole machine");
    expect(r.container.querySelector("[data-screen-control-toggle]")).not.toBeNull();
    expect(r.container.querySelector("[data-approve]")).not.toBeNull();
    expect(r.container.textContent).toContain("WXYZ-4821");
    await r.unmount();
  });

  test("a headless machine hides the screen-control toggle", async () => {
    const r = await renderComponent(
      <EnrollmentConsent userCode="A" machine={headless} onApprove={() => {}} onDeny={() => {}} />,
    );
    await flush();
    expect(r.container.querySelector("[data-screen-control-toggle]")).toBeNull();
    await r.unmount();
  });

  test("approve passes the screen-control consent through", async () => {
    const got: boolean[] = [];
    const r = await renderComponent(
      <EnrollmentConsent
        userCode="A"
        machine={display}
        onApprove={(v) => got.push(v)}
        onDeny={() => {}}
      />,
    );
    await flush();
    (r.container.querySelector("[data-approve]") as HTMLButtonElement).click();
    await flush();
    // The toggle defaults to requestsScreenControl (true) for a display machine.
    expect(got).toEqual([true]);
    await r.unmount();
  });

  test("approved / denied / error phases render their result panels", async () => {
    for (const [phase, marker] of [
      ["approved", "ok"],
      ["denied", "muted"],
      ["error", "danger"],
    ] as const) {
      const r = await renderComponent(
        <EnrollmentConsent userCode="A" machine={display} phase={phase} />,
      );
      await flush();
      expect(r.container.querySelector(`[data-enrollment-result="${marker}"]`)).not.toBeNull();
      await r.unmount();
    }
  });
});

describe("EnrollmentDeviceFlow", () => {
  test("shows the user code + verification URI", async () => {
    let copied = false;
    const r = await renderComponent(
      <EnrollmentDeviceFlow
        userCode="WXYZ-4821"
        verificationUri="https://get.opengeni.ai/device"
        installCommand="curl -fsSL https://get.opengeni.ai/install.sh | sh"
        onCopyCode={() => (copied = true)}
      />,
    );
    await flush();
    expect(r.container.querySelector("[data-enrollment-device-flow]")).not.toBeNull();
    expect(r.container.querySelector("[data-user-code]")?.textContent).toContain("WXYZ-4821");
    expect(r.container.textContent).toContain("get.opengeni.ai/device");
    (r.container.querySelector("[data-copy-code]") as HTMLButtonElement).click();
    await flush();
    expect(copied).toBe(true);
    await r.unmount();
  });
});
