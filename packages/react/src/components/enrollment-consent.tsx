import { type ReactNode, useState } from "react";
import {
  CircleAlertIcon,
  LaptopIcon,
  MonitorIcon,
  ScreenShareIcon,
  ShieldAlertIcon,
  TerminalIcon,
  UsersIcon,
} from "lucide-react";
import { cn } from "../lib/cn";

/** The machine identity surfaced to the approver, from the device-flow start. */
export type EnrollmentConsentMachine = {
  /** Human-friendly name (hostname by default). */
  machineName: string;
  os: string;
  arch: string;
  /** The agent can offer a display (a real screen / Xvfb is available). */
  canOfferDisplay: boolean;
  /** The agent requests screen control (computer-use). */
  requestsScreenControl: boolean;
};

/** The phase of the approve page (drives the rendered panel). */
export type EnrollmentConsentPhase = "review" | "approving" | "approved" | "denied" | "error";

export type EnrollmentConsentProps = {
  /** The short code the user typed / scanned (echoed back for confirmation). */
  userCode: string;
  machine: EnrollmentConsentMachine;
  phase?: EnrollmentConsentPhase | undefined;
  /** Approve with the chosen screen-control consent. */
  onApprove?: ((allowScreenControl: boolean) => void) | undefined;
  onDeny?: (() => void) | undefined;
  /** Error message when phase === "error". */
  errorMessage?: string | undefined;
  className?: string | undefined;
};

function Capability({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-og-status-failed">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-og-fg">{title}</span>
        <span className="block text-[12px] text-og-fg-muted">{body}</span>
      </span>
    </li>
  );
}

/**
 * The user-facing APPROVE page for the device-flow enrollment: a LOUD,
 * un-minimised whole-machine consent. Approving grants the agent FULL access to
 * this machine — exec, files, terminal — and (when toggled) live screen control.
 * The danger framing is deliberate (§18 hardening: whole-machine = loud consent),
 * never buried. Renders review / approving / approved / denied / error phases.
 */
export function EnrollmentConsent({
  userCode,
  machine,
  phase = "review",
  onApprove,
  onDeny,
  errorMessage,
  className,
}: EnrollmentConsentProps) {
  const [allowScreenControl, setAllowScreenControl] = useState(machine.requestsScreenControl);
  const busy = phase === "approving";

  if (phase === "approved") {
    return (
      <ConsentResult
        className={className}
        tone="ok"
        title="Machine connected"
        body={`${machine.machineName} is now enrolled in this workspace. You can close this page — it will appear in your Machines dashboard.`}
      />
    );
  }
  if (phase === "denied") {
    return (
      <ConsentResult
        className={className}
        tone="muted"
        title="Enrollment denied"
        body={`You declined to connect ${machine.machineName}. The agent has no access to this machine. You can re-run the install one-liner to try again.`}
      />
    );
  }
  if (phase === "error") {
    return (
      <ConsentResult
        className={className}
        tone="danger"
        title="Could not complete enrollment"
        body={errorMessage ?? "The code may have expired. Re-run the install one-liner on the machine for a fresh code."}
      />
    );
  }

  return (
    <div
      data-enrollment-consent
      className={cn(
        "og-root mx-auto flex w-full max-w-md flex-col gap-5 rounded-og-lg border border-og-status-failed/30 bg-og-surface-1 p-6 shadow-og-md",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-og-status-failed/15 text-og-status-failed">
          <ShieldAlertIcon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-og-fg">Give the agent your whole machine?</h1>
          <p className="mt-1 text-[13px] text-og-fg-muted">
            Approving lets the OpenGeni agent run on <span className="font-medium text-og-fg">{machine.machineName}</span> with
            full access. This is your real computer — not a sandbox.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-og-md border border-og-border bg-og-surface-2 px-3 py-2 text-[12px]">
        <LaptopIcon className="size-4 text-og-fg-subtle" aria-hidden />
        <span className="font-medium text-og-fg">{machine.machineName}</span>
        <span className="font-og-mono text-og-fg-subtle">
          {machine.os}/{machine.arch}
        </span>
        <span aria-hidden className="text-og-fg-subtle">·</span>
        <span className="text-og-fg-subtle">
          code <span className="font-og-mono font-medium text-og-fg">{userCode}</span>
        </span>
      </div>

      <ul className="flex flex-col gap-3">
        <Capability
          icon={<TerminalIcon className="size-4" aria-hidden />}
          title="Read, write & run anything"
          body="The agent can read and modify any file, run any command, and use your git credentials — as if it were you at the keyboard."
        />
        {machine.canOfferDisplay ? (
          <Capability
            icon={<MonitorIcon className="size-4" aria-hidden />}
            title="See your screen"
            body="The agent can capture this machine's display to watch what it is doing."
          />
        ) : null}
        <Capability
          icon={<UsersIcon className="size-4" aria-hidden />}
          title="Shared while connected"
          body="Any session in this workspace can use this machine while it is online. Disconnect the agent to revoke access instantly."
        />
      </ul>

      {machine.canOfferDisplay ? (
        <label
          data-screen-control-toggle
          className="flex cursor-pointer items-start gap-3 rounded-og-md border border-og-border bg-og-bg px-3 py-2.5"
        >
          <input
            type="checkbox"
            checked={allowScreenControl}
            disabled={busy}
            onChange={(e) => setAllowScreenControl(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--og-color-accent)]"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-og-fg">
              <ScreenShareIcon className="size-3.5 text-og-fg-muted" aria-hidden />
              Also let the agent control my mouse & keyboard
            </span>
            <span className="mt-0.5 block text-[12px] text-og-fg-muted">
              Optional. Enables computer-use — the agent can move the pointer, type, and click on this machine's desktop. Leave
              off to let it only watch.
            </span>
          </span>
        </label>
      ) : (
        <p className="flex items-start gap-2 rounded-og-md border border-og-border bg-og-bg px-3 py-2 text-[12px] text-og-fg-muted">
          <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-og-fg-subtle" aria-hidden />
          This machine has no display, so screen control isn't available — files, terminal, and git only.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-deny
          disabled={busy}
          onClick={() => onDeny?.()}
          className="flex-1 rounded-og-sm border border-og-border px-3 py-2 text-sm font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          data-approve
          disabled={busy}
          onClick={() => onApprove?.(allowScreenControl)}
          className="flex-1 rounded-og-sm bg-og-status-failed px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Grant full access"}
        </button>
      </div>
    </div>
  );
}

function ConsentResult({
  tone,
  title,
  body,
  className,
}: {
  tone: "ok" | "muted" | "danger";
  title: string;
  body: string;
  className?: string | undefined;
}) {
  const ring =
    tone === "ok"
      ? "border-og-status-running/30"
      : tone === "danger"
        ? "border-og-status-failed/30"
        : "border-og-border";
  const iconClass =
    tone === "ok" ? "text-og-status-running" : tone === "danger" ? "text-og-status-failed" : "text-og-fg-subtle";
  return (
    <div
      data-enrollment-result={tone}
      className={cn(
        "og-root mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-og-lg border bg-og-surface-1 p-6 text-center shadow-og-md",
        ring,
        className,
      )}
    >
      <span className={cn("flex size-10 items-center justify-center rounded-full bg-og-surface-2", iconClass)}>
        <LaptopIcon className="size-5" aria-hidden />
      </span>
      <h1 className="text-base font-semibold text-og-fg">{title}</h1>
      <p className="max-w-sm text-[13px] text-og-fg-muted">{body}</p>
    </div>
  );
}
