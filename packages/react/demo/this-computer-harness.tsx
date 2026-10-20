// "Use this computer" reference: every state of the setup, offer, settings
// panel and conversation card against a simulated desktop host.
//   ?theme=light|dark  ?view=board|setup  ?state=<preset>  ?grant=auto|manual
import type { MachineView } from "@opengeni/sdk";
import {
  ThisComputerCard,
  ThisComputerOffer,
  ThisComputerPanel,
  ThisComputerSetup,
  useThisComputer,
  type ThisComputerHost,
  type ThisComputerPermissionId,
  type ThisComputerStatus,
} from "@opengeni/react/this-computer";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "@opengeni/react/this-computer.css";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const view = params.get("view") ?? "board";
const preset = params.get("state") ?? "off";
const autoGrant = params.get("grant") !== "manual";
const platform = (params.get("platform") ?? "macos") as "macos" | "linux" | "windows";

const APP_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a3d"/><stop offset="1" stop-color="#e2452b"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><path d="M20 18l12 28 12-28" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

function statusFor(name: string): ThisComputerStatus {
  const base: ThisComputerStatus = {
    state: "not_connected",
    busy: false,
    error: null,
    machineName: "Kari's MacBook Air",
    ...(params.get("management") === "service"
      ? { management: "service" as const, permissionAppName: "Opengeni Agent" }
      : {}),
  };
  const perms = (granted: number) =>
    (["screenRecording", "accessibility", "inputMonitoring"] as const).map((id, index) => ({
      id,
      granted: index < granted,
    }));
  switch (name) {
    case "downloading":
      return { ...base, busy: true, setupProgress: 0.42 };
    case "connecting":
      return { ...base, busy: true };
    case "perm0":
      return { ...base, state: "connected", permissions: perms(0), setupPending: true };
    case "perm1":
      return { ...base, state: "connected", permissions: perms(1), setupPending: true };
    case "perm2":
      return { ...base, state: "connected", permissions: perms(2), setupPending: true };
    case "ready":
      return platform === "macos"
        ? { ...base, state: "connected", permissions: perms(3) }
        : { ...base, state: "connected" };
    case "paused":
      return { ...base, state: "paused" };
    case "resuming":
      return { ...base, state: "paused", busy: true };
    case "reconnecting":
      return platform === "macos"
        ? { ...base, state: "connected", permissions: perms(3), reconnecting: true }
        : { ...base, state: "connected", reconnecting: true };
    case "error":
      return {
        ...base,
        error: "Couldn't reach the server.",
        errorCode: "offline",
      };
    default:
      return base;
  }
}

class FakeHost implements ThisComputerHost {
  readonly platform = platform;
  readonly productName = "Acme";
  private current: ThisComputerStatus;
  private listeners = new Set<() => void>();
  constructor(initial: string) {
    this.current = statusFor(initial);
  }
  private set(next: ThisComputerStatus) {
    this.current = next;
    for (const listener of this.listeners) listener();
  }
  async status() {
    return this.current;
  }
  async connect(): Promise<ThisComputerStatus> {
    if (preset === "error") {
      await new Promise((resolve) => setTimeout(resolve, 900));
      this.set(statusFor("error"));
      return this.current;
    }
    for (let progress = 0; progress <= 1; progress += 0.1) {
      this.set({ ...statusFor("downloading"), setupProgress: progress });
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    this.set(platform === "macos" ? statusFor("perm0") : statusFor("ready"));
    return this.current;
  }
  async pause() {
    this.set({
      ...statusFor("paused"),
      ...(this.current.management === "service" ? { permissions: this.current.permissions } : {}),
    });
  }
  async resume() {
    this.set(statusFor("resuming"));
    await new Promise((resolve) => setTimeout(resolve, 900));
    this.set(statusFor("ready"));
  }
  async disconnect() {
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.set(statusFor("off"));
  }
  async requestPermission(id: ThisComputerPermissionId) {
    if (!autoGrant) return;
    setTimeout(() => {
      const permissions = (this.current.permissions ?? []).map((permission) =>
        permission.id === id ? { ...permission, granted: true } : permission,
      );
      this.set({ ...this.current, permissions, setupPending: permissions.some((p) => !p.granted) });
    }, 2_200);
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const agentMark = (
  <svg viewBox="0 0 40 40" aria-hidden>
    <rect width="40" height="40" fill="#3b82f6" />
    <circle cx="20" cy="16" r="7" fill="#fff" />
    <rect x="9" y="26" width="22" height="12" rx="6" fill="#fff" />
  </svg>
);

function machine(state: MachineView["state"]): MachineView {
  return {
    sandboxId: "m1",
    enrollmentId: "e1",
    scope: "user",
    name: "Kari's MacBook Air",
    state,
  } as MachineView;
}

function Tile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
      <p style={{ margin: 0, fontSize: 11, color: "var(--og-color-fg-muted)" }}>{title}</p>
      {children}
    </div>
  );
}

function HostedPieces({ state }: { state: string }) {
  const [host] = useState(() => new FakeHost(state));
  const computer = useThisComputer(host, "ws");
  const [open, setOpen] = useState(false);
  return (
    <Tile title={state}>
      <div style={{ width: 260 }}>
        <ThisComputerOffer computer={computer} onSetup={() => setOpen(true)} onDismiss={() => {}} />
      </div>
      <ThisComputerPanel computer={computer} platform={platform} onSetup={() => setOpen(true)} />
      <ThisComputerCard
        computer={computer}
        productName="Acme"
        rationale="I can sort the files in your Downloads folder directly on your computer."
        onSetup={() => setOpen(true)}
      />
      <ThisComputerSetup
        open={open}
        onOpenChange={setOpen}
        computer={computer}
        platform={platform}
        productName="Acme"
        appIcon={APP_ICON}
        agentMark={agentMark}
      />
    </Tile>
  );
}

function Board() {
  return (
    <div style={{ padding: 24, display: "grid", gap: 28 }}>
      <div
        style={{
          display: "grid",
          gap: 24,
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
        }}
      >
        {[
          "off",
          "downloading",
          "perm1",
          "ready",
          "reconnecting",
          "paused",
          "resuming",
          "error",
        ].map((state) => (
          <HostedPieces key={state} state={state} />
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gap: 24,
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
        }}
      >
        <Tile title="web: computer ready">
          <ThisComputerCard
            productName="Acme"
            machines={[machine("online")]}
            rationale="Sort my files."
          />
        </Tile>
        <Tile title="web: computer offline">
          <ThisComputerCard
            productName="Acme"
            machines={[machine("offline")]}
            rationale="Sort my files."
          />
        </Tile>
        <Tile title="web: no computer">
          <ThisComputerCard
            productName="Acme"
            machines={[]}
            downloadUrl="https://example.com/download"
            rationale="I can sort the files in your Downloads folder directly on your computer."
          />
        </Tile>
      </div>
    </div>
  );
}

function SetupOnly() {
  const [host] = useState(() => new FakeHost(preset));
  const computer = useThisComputer(host, "ws");
  const [open, setOpen] = useState(true);
  return (
    <div style={{ padding: 24 }}>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {computer.status ? (
        <ThisComputerSetup
          open={open}
          onOpenChange={setOpen}
          computer={computer}
          platform={platform}
          productName="Acme"
          appIcon={APP_ICON}
          agentMark={agentMark}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div
    className="og-root"
    data-og-theme={theme}
    style={{ minHeight: "100dvh", background: "var(--og-color-bg)", color: "var(--og-color-fg)" }}
  >
    {view === "setup" ? <SetupOnly /> : <Board />}
  </div>,
);
