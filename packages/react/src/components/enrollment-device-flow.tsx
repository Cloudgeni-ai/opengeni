import { type ReactNode } from "react";
import { CopyIcon, ExternalLinkIcon, LaptopIcon, TerminalIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { MachineState } from "../types/machines";
import { ConnectionStatusPill } from "./machine-status-pill";

/** The poll state of an in-flight device-flow enrollment. */
export type DeviceFlowPhase = "pending" | "authorized" | "denied" | "expired" | "disabled";

export type EnrollmentDeviceFlowProps = {
  /** The short user code the agent printed (shown big for the human to confirm). */
  userCode: string;
  /** Where the user approves — the same-origin device page. */
  verificationUri: string;
  /** The complete URI (code pre-filled) for a one-click / QR open. */
  verificationUriComplete?: string | undefined;
  /** The install one-liner the user ran (echoed for context). Optional. */
  installCommand?: string | undefined;
  phase?: DeviceFlowPhase | undefined;
  /** Seconds remaining before the code expires (drives a quiet countdown). */
  expiresInSeconds?: number | undefined;
  onCopyCode?: (() => void) | undefined;
  onCopyInstall?: (() => void) | undefined;
  onOpenVerification?: (() => void) | undefined;
  className?: string | undefined;
};

const PHASE_TO_STATE: Record<DeviceFlowPhase, MachineState> = {
  pending: "enrolling",
  authorized: "online",
  denied: "offline",
  expired: "offline",
  disabled: "offline",
};

function PhaseLabel({ phase }: { phase: DeviceFlowPhase }): ReactNode {
  const text: Record<DeviceFlowPhase, string> = {
    pending: "Waiting for approval",
    authorized: "Connected",
    denied: "Denied",
    expired: "Code expired",
    disabled: "Enrollment disabled",
  };
  return <span>{text[phase]}</span>;
}

/**
 * The IN-SESSION device-flow panel: the agent (after the install one-liner) prints
 * a short `userCode` + a `verificationUri`; this surfaces them so the user can open
 * the approve page and confirm the code. Polls in the caller; this renders the
 * pending → authorized/denied/expired progression with a connection pill. This is
 * the FIRST step of the IA flow (device-flow → Machines list → attach/swap).
 */
export function EnrollmentDeviceFlow({
  userCode,
  verificationUri,
  verificationUriComplete,
  installCommand,
  phase = "pending",
  expiresInSeconds,
  onCopyCode,
  onCopyInstall,
  onOpenVerification,
  className,
}: EnrollmentDeviceFlowProps) {
  const href = verificationUriComplete ?? verificationUri;
  // Before the one-liner runs the caller passes a placeholder (dashes) for the
  // code — surface that as an explicit waiting state rather than dashes that look
  // like a real code to type.
  const codeIsPlaceholder = !/[A-Za-z0-9]/.test(userCode);
  const awaitingCode = phase === "pending" && codeIsPlaceholder;
  return (
    <div
      data-enrollment-device-flow
      className={cn(
        "og-root flex w-full max-w-md flex-col gap-4 rounded-og-lg border border-og-border bg-og-surface-1 p-5 shadow-og-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-og-surface-2 text-og-fg-muted">
            <LaptopIcon className="size-4" aria-hidden />
          </span>
          <h2 className="text-sm font-semibold text-og-fg">Connect a machine</h2>
        </div>
        <ConnectionStatusPill
          status={
            PHASE_TO_STATE[phase] === "online"
              ? "online"
              : PHASE_TO_STATE[phase] === "offline"
                ? "offline"
                : "reconnecting"
          }
          label={(<PhaseLabel phase={phase} />) as unknown as string}
          size="sm"
        />
      </div>

      {installCommand ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-og-fg-subtle">
            1 · Run on the machine
          </span>
          <div className="flex items-center justify-between gap-2 overflow-hidden rounded-og-md border border-og-border bg-og-bg px-2.5 py-1.5">
            <code className="flex min-w-0 items-center gap-2 overflow-x-auto font-og-mono text-[12px] text-og-fg">
              <TerminalIcon className="size-3.5 shrink-0 text-og-fg-subtle" aria-hidden />
              {installCommand}
            </code>
            <button
              type="button"
              data-copy-install
              onClick={onCopyInstall}
              title="Copy command"
              className="shrink-0 rounded-og-sm p-1.5 text-og-fg-subtle transition-colors hover:bg-og-surface-2 hover:text-og-fg"
            >
              <CopyIcon className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-og-fg-subtle">
          {installCommand ? "2 · Approve the machine" : "Approve the machine"}
        </span>
        <div className="flex items-center justify-between gap-3 rounded-og-md border border-og-border bg-og-bg px-3 py-2.5">
          {awaitingCode ? (
            <span data-user-code className="font-og-mono text-[13px] text-og-fg-subtle">
              Run the command above — your code appears here
            </span>
          ) : (
            <span
              data-user-code
              className="select-all font-og-mono text-2xl font-semibold tracking-[0.25em] text-og-fg"
            >
              {userCode}
            </span>
          )}
          <button
            type="button"
            data-copy-code
            onClick={onCopyCode}
            disabled={awaitingCode}
            title="Copy code"
            className="shrink-0 rounded-og-sm p-1.5 text-og-fg-subtle transition-colors hover:bg-og-surface-2 hover:text-og-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-og-fg-subtle"
          >
            <CopyIcon className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <a
        href={href}
        data-open-verification
        target="_blank"
        rel="noreferrer"
        onClick={onOpenVerification}
        className="inline-flex items-center justify-center gap-1.5 rounded-og-sm bg-og-accent px-3 py-2 text-sm font-medium text-og-accent-fg transition-colors hover:bg-og-accent-strong"
      >
        Open approval page
        <ExternalLinkIcon className="size-3.5" aria-hidden />
      </a>

      <p className="text-center text-[11px] text-og-fg-subtle">
        {awaitingCode ? (
          <>
            The one-liner prints a short code. Open{" "}
            <span className="font-og-mono text-og-fg-muted">{verificationUri}</span> and confirm the
            code shown there matches.
          </>
        ) : (
          <>
            Confirm code <span className="font-og-mono text-og-fg-muted">{userCode}</span> — the one
            printed by the one-liner — at{" "}
            <span className="font-og-mono text-og-fg-muted">{verificationUri}</span>.
            {typeof expiresInSeconds === "number" ? (
              <> Expires in {Math.max(0, Math.round(expiresInSeconds / 60))} min.</>
            ) : null}
          </>
        )}
      </p>
    </div>
  );
}
