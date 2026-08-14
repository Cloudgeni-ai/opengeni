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
import { MachineDetail } from "../src/components/machines/machine-detail";
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
    workspaceGeneration: null,
    archiveGeneration: null,
    archiveComplete: false,
    active: false,
    isSessionGroup: false,
    os: "linux",
    arch: "x86_64",
    hasDisplay: true,
    allowScreenControl: true,
    sharedSessionCount: 1,
    lastSeenAt: "2026-06-26T09:15:00.000Z",
    connectionAuthority: {
      state: "active",
      generation: 1,
      supersededCount: 0,
      leaseExpiresAt: "2026-06-26T09:16:00.000Z",
      duplicateRunnerDeniedCount: 0,
      duplicateRunnerDeniedAt: null,
    },
    runtime: null,
    metrics: idle,
    ...overrides,
    operationPolicy: overrides.operationPolicy ?? null,
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
  test("an outdated agent shows exact build truth and one-click update without opening detail", async () => {
    const updated: MachineView[] = [];
    const opened: MachineView[] = [];
    const m = machine({
      sandboxId: "sh-outdated",
      state: "online",
      runtime: {
        installedVersion: "0.1.15",
        binarySha256: "ab".repeat(32),
        updateChannel: "stable",
        desiredVersion: "0.1.16",
        versionState: "outdated",
        capabilities: {
          exec: true,
          filesystem: true,
          git: true,
          pty: true,
          desktop: true,
          opStream: true,
          browserBridge: true,
          operationResourcePolicy: true,
        },
        update: null,
      },
    });
    const r = await renderComponent(
      <MachineCard
        machine={m}
        onUpdateAgent={(value) => updated.push(value)}
        onOpenDetail={(value) => opened.push(value)}
      />,
    );
    await flush();
    expect(r.container.textContent).toContain("Agent v0.1.15");
    expect(r.container.textContent).toContain("Promoted v0.1.16");
    const button = r.container.querySelector("[data-update-agent]") as HTMLButtonElement;
    button.click();
    await flush();
    expect(updated.map((value) => value.sandboxId)).toEqual(["sh-outdated"]);
    expect(opened).toEqual([]);
    await r.unmount();
  });

  test("a draining update is truthful and cannot be started twice", async () => {
    const m = machine({
      sandboxId: "sh-updating",
      state: "online",
      runtime: {
        installedVersion: "0.1.15",
        binarySha256: "ab".repeat(32),
        updateChannel: "stable",
        desiredVersion: "0.1.16",
        versionState: "updating",
        capabilities: {
          exec: true,
          filesystem: true,
          git: true,
          pty: true,
          desktop: true,
          opStream: true,
          browserBridge: true,
          operationResourcePolicy: true,
        },
        update: {
          operationId: "00000000-0000-4000-8000-000000000001",
          status: "waiting_for_idle",
          targetVersion: "0.1.16",
          expectedBinarySha256: null,
          errorCode: null,
          retryable: false,
          rolledBack: false,
          requestedAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:01.000Z",
          completedAt: null,
        },
      },
    });
    const r = await renderComponent(<MachineCard machine={m} onUpdateAgent={() => {}} />);
    await flush();
    expect(r.container.textContent).toContain("Waiting for current work");
    expect(r.container.querySelector("[data-update-agent]")).toBeNull();
    await r.unmount();
  });

  test("an unconfirmed dispatch becomes safely redeliverable with the same operation", async () => {
    const retried: MachineView[] = [];
    const m = machine({
      sandboxId: "sh-awaiting-confirmation",
      state: "online",
      runtime: {
        installedVersion: "0.1.15",
        binarySha256: "ab".repeat(32),
        updateChannel: "stable",
        desiredVersion: "0.1.16",
        versionState: "updating",
        capabilities: {
          exec: true,
          filesystem: true,
          git: true,
          pty: true,
          desktop: true,
          opStream: true,
          browserBridge: true,
          operationResourcePolicy: true,
        },
        update: {
          operationId: "00000000-0000-4000-8000-000000000001",
          status: "requested",
          targetVersion: "0.1.16",
          expectedBinarySha256: null,
          errorCode: null,
          retryable: false,
          rolledBack: false,
          requestedAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
          completedAt: null,
        },
      },
    });
    const r = await renderComponent(
      <MachineCard
        machine={m}
        now={new Date("2026-08-13T12:00:31.000Z").getTime()}
        onUpdateAgent={(value) => retried.push(value)}
      />,
    );
    await flush();
    expect(r.container.textContent).toContain("Agent confirmation delayed");
    const button = r.container.querySelector("[data-update-agent]") as HTMLButtonElement;
    expect(button.textContent).toContain("Retry delivery");
    button.click();
    await flush();
    expect(retried.map((value) => value.sandboxId)).toEqual(["sh-awaiting-confirmation"]);
    await r.unmount();
  });

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

  test("a blocked competing runner is visible from the fleet card", async () => {
    const m = machine({
      sandboxId: "sh-conflict",
      state: "online",
      connectionAuthority: {
        state: "active",
        generation: 3,
        supersededCount: 2,
        leaseExpiresAt: "2026-06-26T09:16:00.000Z",
        duplicateRunnerDeniedCount: 1,
        duplicateRunnerDeniedAt: "2026-06-26T09:15:30.000Z",
      },
    });
    const r = await renderComponent(<MachineCard machine={m} />);
    await flush();
    expect(r.container.querySelector("[data-runner-conflict]")).not.toBeNull();
    expect(r.container.textContent).toContain("Competing agent process blocked");
    await r.unmount();
  });
});

describe("MachineDetail — runner authority diagnostics", () => {
  test("shows the live generation, fenced predecessors, and blocked competing runners", async () => {
    const m = machine({
      sandboxId: "sh-authority-detail",
      state: "online",
      connectionAuthority: {
        state: "active",
        generation: 4,
        supersededCount: 3,
        leaseExpiresAt: "2026-06-26T09:16:00.000Z",
        duplicateRunnerDeniedCount: 2,
        duplicateRunnerDeniedAt: "2026-06-26T09:15:30.000Z",
      },
    });
    const r = await renderComponent(
      <MachineDetail
        machine={m}
        series={[]}
        window="1h"
        onWindowChange={() => {}}
        now={new Date("2026-06-26T09:15:40.000Z").getTime()}
      />,
    );
    await flush();
    expect(r.container.querySelector('[data-connection-authority="active"]')).not.toBeNull();
    expect(r.container.textContent).toContain("generation 4");
    expect(r.container.textContent).toContain("3 earlier runners fenced");
    expect(r.container.textContent).toContain("Blocked 2 competing runners");
    await r.unmount();
  });

  test("shows configured policy incompatibility and saves with the current revision", async () => {
    const requests: unknown[] = [];
    const m = machine({
      sandboxId: "policy-machine",
      state: "online",
      operationPolicy: {
        memoryMaxBytes: 1_073_741_824,
        memoryHighBytes: 805_306_368,
        revision: 4,
        updatedAt: "2026-08-14T10:00:00.000Z",
      },
      runtime: {
        installedVersion: "0.1.15",
        binarySha256: "ab".repeat(32),
        updateChannel: "stable",
        desiredVersion: "0.1.16",
        versionState: "outdated",
        capabilities: {
          exec: true,
          filesystem: true,
          git: true,
          pty: true,
          desktop: true,
          opStream: true,
          browserBridge: true,
          operationResourcePolicy: false,
        },
        update: null,
      },
    });
    const r = await renderComponent(
      <MachineDetail
        machine={m}
        series={[]}
        window="1h"
        onWindowChange={() => {}}
        onUpdateOperationPolicy={async (_machine, request) => requests.push(request)}
      />,
    );
    await flush();
    expect(r.container.textContent).toContain("Command execution fails closed");
    (
      r.container.querySelector(
        '[data-machine-operation-policy] button[type="submit"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(requests).toEqual([
      {
        memoryMaxBytes: 1_073_741_824,
        memoryHighBytes: 805_306_368,
        expectedRevision: 4,
      },
    ]);
    await r.unmount();
  });

  test("surfaces an asynchronous policy-save failure", async () => {
    const m = machine({
      sandboxId: "policy-save-failure",
      state: "online",
      operationPolicy: {
        memoryMaxBytes: null,
        memoryHighBytes: null,
        revision: 2,
        updatedAt: null,
      },
    });
    const r = await renderComponent(
      <MachineDetail
        machine={m}
        series={[]}
        window="1h"
        onWindowChange={() => {}}
        onUpdateOperationPolicy={async () => {
          throw new Error("policy revision changed");
        }}
      />,
    );
    await flush();
    (
      r.container.querySelector(
        '[data-machine-operation-policy] button[type="submit"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(
      r.container.querySelector('[data-machine-operation-policy] [role="alert"]')?.textContent,
    ).toBe("policy revision changed");
    await r.unmount();
  });
});

describe("MachinesDashboard", () => {
  test("empty state renders the connect CTA", async () => {
    let enrolled = false;
    const r = await renderComponent(
      <MachinesDashboard machines={[]} onEnroll={() => (enrolled = true)} />,
    );
    await flush();
    expect(r.container.querySelector("[data-machines-empty]")).not.toBeNull();
    const cta = r.container.querySelector("[data-enroll-cta]") as HTMLButtonElement | null;
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain("Connect a machine");
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
