import { type ReactNode, useState } from "react";
import type { ResourceAuthorityScope } from "@opengeni/sdk";
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
import { useOpenGeniText } from "../messages/runtime";

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
  /** Whether this caller may share the machine with the whole workspace. */
  allowWorkspaceScope?: boolean | undefined;
  /** Whether this caller may publish the machine to the whole organization. */
  allowOrganizationScope?: boolean | undefined;
  /** Approve with the chosen screen-control consent and explicit access scope. */
  onApprove?: ((allowScreenControl: boolean, scope: ResourceAuthorityScope) => void) | undefined;
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
        <span className="block text-og-base font-medium text-og-fg">{title}</span>
        <span className="block text-og-sm text-og-fg-muted">{body}</span>
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
  allowWorkspaceScope = true,
  allowOrganizationScope = false,
  onApprove,
  onDeny,
  errorMessage,
  className,
}: EnrollmentConsentProps) {
  const t = useOpenGeniText();
  const [allowScreenControl, setAllowScreenControl] = useState(machine.requestsScreenControl);
  const [scope, setScope] = useState<ResourceAuthorityScope>("user");
  const busy = phase === "approving";
  const scopeCopy = {
    user: {
      label: t("enrollmentConsent.personal"),
      body: t("enrollmentConsent.onlyYouCanUseThis"),
    },
    workspace: {
      label: t("enrollmentConsent.workspace"),
      body: t("enrollmentConsent.everyoneWithAccessToThis"),
    },
    organization: {
      label: t("enrollmentConsent.organization"),
      body: t("enrollmentConsent.membersOfThisOrganizationCan"),
    },
  } satisfies Record<ResourceAuthorityScope, { label: string; body: string }>;

  if (phase === "approved") {
    return (
      <ConsentResult
        className={className}
        tone="ok"
        title={t("enrollmentConsent.machineConnected")}
        body={t("enrollmentConsent.machinenameIsNowConnectedWith", {
          machineName: machine.machineName,
          lowerCase: scopeCopy[scope].label.toLowerCase(),
        })}
      />
    );
  }
  if (phase === "denied") {
    return (
      <ConsentResult
        className={className}
        tone="muted"
        title={t("enrollmentConsent.enrollmentDenied")}
        body={t("enrollmentConsent.youDeclinedToConnectMachinename", {
          machineName: machine.machineName,
        })}
      />
    );
  }
  if (phase === "error") {
    return (
      <ConsentResult
        className={className}
        tone="danger"
        title={t("enrollmentConsent.couldNotCompleteEnrollment")}
        body={errorMessage ?? t("enrollmentConsent.theCodeMayHaveExpired")}
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
          <h1 className="text-og-md font-semibold text-og-fg">
            {t("enrollmentConsent.giveTheAgentYourWhole")}
          </h1>
          <p className="mt-1 text-og-base text-og-fg-muted">
            {t("enrollmentConsent.approvingLetsTheOpengeniAgent")}{" "}
            <span className="font-medium text-og-fg">{machine.machineName}</span>{" "}
            {t("enrollmentConsent.withFullAccessThisIs")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-og-md border border-og-border bg-og-surface-2 px-3 py-2 text-og-sm">
        <LaptopIcon className="size-4 text-og-fg-subtle" aria-hidden />
        <span className="font-medium text-og-fg">{machine.machineName}</span>
        <span className="font-og-mono text-og-fg-subtle">
          {machine.os}/{machine.arch}
        </span>
        <span aria-hidden className="text-og-fg-subtle">
          ·
        </span>
        <span className="text-og-fg-subtle">
          {t("enrollmentConsent.code")}{" "}
          <span className="font-og-mono font-medium text-og-fg">{userCode}</span>
        </span>
      </div>

      <ul className="flex flex-col gap-3">
        <Capability
          icon={<TerminalIcon className="size-4" aria-hidden />}
          title={t("enrollmentConsent.readWriteRunAnything")}
          body={t("enrollmentConsent.theAgentCanReadAnd")}
        />
        {machine.canOfferDisplay ? (
          <Capability
            icon={<MonitorIcon className="size-4" aria-hidden />}
            title={t("enrollmentConsent.seeYourScreen")}
            body={t("enrollmentConsent.theAgentCanCaptureThis")}
          />
        ) : null}
        <Capability
          icon={<UsersIcon className="size-4" aria-hidden />}
          title={t("enrollmentConsent.labelAccessWhileConnected", {
            label: scopeCopy[scope].label,
          })}
          body={t("enrollmentConsent.bodyDisconnectTheAgentTo", { body: scopeCopy[scope].body })}
        />
      </ul>

      <fieldset className="flex flex-col gap-2" disabled={busy}>
        <legend className="mb-1 text-og-sm font-medium text-og-fg">
          {t("enrollmentConsent.whoCanUseThisMachine")}
        </legend>
        {(["user", "workspace", "organization"] as const).map((candidate) => {
          const disabled =
            (candidate === "organization" && !allowOrganizationScope) ||
            (candidate === "workspace" && !allowWorkspaceScope);
          return (
            <label
              key={candidate}
              data-enrollment-scope={candidate}
              data-disabled={disabled ? "true" : "false"}
              className={cn(
                "flex items-start gap-2.5 rounded-og-md border border-og-border bg-og-bg px-3 py-2.5",
                disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              )}
            >
              <input
                type="radio"
                name="enrollment-scope"
                value={candidate}
                checked={scope === candidate}
                disabled={disabled || busy}
                onChange={() => setScope(candidate)}
                className="mt-0.5 size-4 accent-og-accent"
              />
              <span className="min-w-0">
                <span className="block text-og-base font-medium text-og-fg">
                  {scopeCopy[candidate].label}
                  {disabled
                    ? candidate === "organization"
                      ? " · organization admin required"
                      : " · workspace admin required"
                    : ""}
                </span>
                <span className="block text-og-sm text-og-fg-muted">
                  {scopeCopy[candidate].body}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

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
            className="mt-0.5 size-4 accent-og-accent"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-og-base font-medium text-og-fg">
              <ScreenShareIcon className="size-3.5 text-og-fg-muted" aria-hidden />
              {t("enrollmentConsent.alsoLetTheAgentControl")}
            </span>
            <span className="mt-0.5 block text-og-sm text-og-fg-muted">
              {t("enrollmentConsent.optionalEnablesComputerUseThe")}
            </span>
          </span>
        </label>
      ) : (
        <p className="flex items-start gap-2 rounded-og-md border border-og-border bg-og-bg px-3 py-2 text-og-sm text-og-fg-muted">
          <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-og-fg-subtle" aria-hidden />
          {t("enrollmentConsent.thisMachineHasNoDisplay")}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-deny
          disabled={busy}
          onClick={() => onDeny?.()}
          className="flex-1 rounded-og-sm border border-og-border px-3 py-2 text-og-sm font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg disabled:opacity-50 pointer-coarse:min-h-11"
        >
          {t("enrollmentConsent.cancel")}
        </button>
        <button
          type="button"
          data-approve
          disabled={busy}
          onClick={() => onApprove?.(allowScreenControl, scope)}
          className="flex-1 rounded-og-sm bg-og-status-failed px-3 py-2 text-og-sm font-semibold text-og-accent-fg transition-colors hover:opacity-90 disabled:opacity-50 pointer-coarse:min-h-11"
        >
          {busy ? t("enrollmentConsent.connecting") : t("enrollmentConsent.grantFullAccess")}
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
    tone === "ok"
      ? "text-og-status-running"
      : tone === "danger"
        ? "text-og-status-failed"
        : "text-og-fg-subtle";
  return (
    <div
      data-enrollment-result={tone}
      className={cn(
        "og-root mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-og-lg border bg-og-surface-1 p-6 text-center shadow-og-md",
        ring,
        className,
      )}
    >
      <span
        className={cn(
          "flex size-10 items-center justify-center rounded-full bg-og-surface-2",
          iconClass,
        )}
      >
        <LaptopIcon className="size-5" aria-hidden />
      </span>
      <h1 className="text-og-md font-semibold text-og-fg">{title}</h1>
      <p className="max-w-sm text-og-base text-og-fg-muted">{body}</p>
    </div>
  );
}
