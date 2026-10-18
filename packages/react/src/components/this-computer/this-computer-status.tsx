import {
  thisComputerReady,
  type ThisComputerPlatform,
  type ThisComputerStatus,
} from "@opengeni/sdk/this-computer";
import { LaptopIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useOpenGeniText } from "../../messages/runtime";
import { defaultThisComputerLabels, type ThisComputerLabels } from "./labels";
import type { UseThisComputerResult } from "./use-this-computer";

/** What the status pieces show for a computer, in order of what matters. */
export type ThisComputerView =
  | "hidden"
  | "off"
  | "setting_up"
  | "finish_setup"
  | "ready"
  | "reconnecting"
  | "paused"
  | "resuming";

export function thisComputerView(status: ThisComputerStatus | null): ThisComputerView {
  if (!status || status.state === "unavailable") return "hidden";
  if (status.state === "paused") return status.busy ? "resuming" : "paused";
  if (status.state === "connected") {
    if (!thisComputerReady(status)) return "finish_setup";
    return status.reconnecting ? "reconnecting" : "ready";
  }
  return status.busy ? "setting_up" : "off";
}

function percent(status: ThisComputerStatus | null): string {
  return status?.setupProgress === undefined ? "" : ` ${Math.round(status.setupProgress * 100)}%`;
}

function storageKey(workspaceId: string) {
  return `opengeni.desktop.thisComputer.dismissed.${workspaceId}`;
}

/** "Not now" on the offer, remembered per workspace on this device. */
export function useThisComputerOfferDismissed(workspaceId: string): [boolean, () => void] {
  const read = useCallback(() => {
    try {
      return window.localStorage.getItem(storageKey(workspaceId)) === "1";
    } catch {
      return false;
    }
  }, [workspaceId]);
  const [dismissed, setDismissed] = useState(read);
  useEffect(() => setDismissed(read()), [read]);
  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(storageKey(workspaceId), "1");
    } catch {
      // Hidden for this page only.
    }
    setDismissed(true);
  }, [workspaceId]);
  return [dismissed, dismiss];
}

export interface ThisComputerOfferProps {
  computer: UseThisComputerResult;
  labels?: ThisComputerLabels;
  /** Opens `ThisComputerSetup`. */
  onSetup(): void;
  /** The person chose "Not now" earlier; the offer stays away until set up. */
  dismissed?: boolean;
  onDismiss?(): void;
  /** The mark beside the title; a laptop by default. */
  icon?: ReactNode;
  className?: string;
}

/**
 * A small card for a sidebar or panel, only while there's something to do:
 * the offer to set up, setup in progress, finishing the permissions, or
 * resuming a paused computer. Shows nothing once it's ready.
 */
export function ThisComputerOffer({
  computer,
  labels: given,
  onSetup,
  dismissed = false,
  onDismiss,
  icon,
  className,
}: ThisComputerOfferProps) {
  const catalogText = useOpenGeniText();
  const labels = given ?? defaultThisComputerLabels(catalogText);
  const { status } = computer;
  const view = thisComputerView(status);
  const machineName = status?.machineName ?? "";
  const mark = icon ?? <LaptopIcon aria-hidden />;
  const classes = ["og-tc-offer", className].filter(Boolean).join(" ");

  if (view === "setting_up" || view === "resuming" || view === "reconnecting") {
    return (
      <div className={classes} data-view={view} role="status">
        <span className="og-tc-spinner" aria-hidden />
        <span className="og-tc-offer-line">
          {view === "resuming"
            ? labels.resuming
            : view === "reconnecting"
              ? labels.reconnecting(machineName)
              : `${labels.settingUp(machineName)}${percent(status)}`}
        </span>
      </div>
    );
  }
  if (view === "paused") {
    return (
      <div className={classes} data-view={view}>
        <span className="og-tc-offer-mark">{mark}</span>
        <span className="og-tc-offer-line">{labels.paused(machineName)}</span>
        <button
          type="button"
          className="og-tc-button og-tc-secondary og-tc-small"
          disabled={computer.acting}
          onClick={() => void computer.resume()}
        >
          {labels.resume}
        </button>
      </div>
    );
  }
  if (view === "finish_setup") {
    return (
      <div className={classes} data-view={view} data-card="">
        <div className="og-tc-offer-head">
          <span className="og-tc-offer-mark">{mark}</span>
          <div>
            <p className="og-tc-offer-title">{labels.finishSetup}</p>
            <p className="og-tc-offer-text">{labels.finishSetupDetail}</p>
          </div>
        </div>
        <div className="og-tc-offer-actions">
          <button
            type="button"
            className="og-tc-button og-tc-primary og-tc-small"
            onClick={onSetup}
          >
            {labels.finishSetup}
          </button>
        </div>
      </div>
    );
  }
  if (view !== "off" || dismissed) return null;
  return (
    <div className={classes} data-view={view} data-card="">
      <div className="og-tc-offer-head">
        <span className="og-tc-offer-mark">{mark}</span>
        <div>
          <p className="og-tc-offer-title">{labels.title}</p>
          <p className="og-tc-offer-text">{labels.offer(machineName)}</p>
        </div>
        {onDismiss ? (
          <button
            type="button"
            className="og-tc-offer-dismiss"
            aria-label={labels.notNow}
            onClick={onDismiss}
          >
            <XIcon aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="og-tc-offer-actions">
        <button type="button" className="og-tc-button og-tc-primary og-tc-small" onClick={onSetup}>
          {labels.offerAction}
        </button>
      </div>
    </div>
  );
}

export interface ThisComputerPanelProps {
  computer: UseThisComputerResult;
  platform: ThisComputerPlatform;
  labels?: ThisComputerLabels;
  /** Opens `ThisComputerSetup`. */
  onSetup(): void;
  icon?: ReactNode;
  className?: string;
}

/**
 * The full control for a settings page: whether agents can use this
 * computer, and turning it on, finishing setup, pausing, resuming and
 * turning it off (after a confirmation).
 */
export function ThisComputerPanel({
  computer,
  platform,
  labels: given,
  onSetup,
  icon,
  className,
}: ThisComputerPanelProps) {
  const catalogText = useOpenGeniText();
  const labels = given ?? defaultThisComputerLabels(catalogText);
  const { status } = computer;
  const view = thisComputerView(status);
  const [confirmingOff, setConfirmingOff] = useState(false);
  useEffect(() => {
    if (view !== "ready" && view !== "reconnecting" && view !== "paused" && view !== "finish_setup")
      setConfirmingOff(false);
  }, [view]);
  if (view === "hidden") return null;
  const machineName = status?.machineName ?? "";
  const error =
    computer.actionError !== null || status?.error
      ? labels.error(status?.errorCode ?? null, status?.error || computer.actionError || null)
      : null;

  let line: string;
  let actions: ReactNode;
  switch (view) {
    case "ready":
    case "reconnecting":
      line = view === "ready" ? labels.ready(machineName) : labels.reconnecting(machineName);
      actions = (
        <button
          type="button"
          className="og-tc-button og-tc-secondary og-tc-small"
          disabled={computer.acting}
          onClick={() => void computer.pause()}
        >
          {labels.pause}
        </button>
      );
      break;
    case "paused":
      line = labels.paused(machineName);
      actions = (
        <button
          type="button"
          className="og-tc-button og-tc-primary og-tc-small"
          disabled={computer.acting}
          onClick={() => void computer.resume()}
        >
          {labels.resume}
        </button>
      );
      break;
    case "resuming":
      line = labels.resuming;
      actions = <span className="og-tc-spinner" aria-hidden />;
      break;
    case "finish_setup":
      line = labels.finishSetupDetail;
      actions = (
        <button type="button" className="og-tc-button og-tc-primary og-tc-small" onClick={onSetup}>
          {labels.finishSetup}
        </button>
      );
      break;
    case "setting_up":
      line = `${labels.settingUp(machineName)}${percent(status)}`;
      actions = <span className="og-tc-spinner" aria-hidden />;
      break;
    default:
      line = labels.offer(machineName);
      actions = (
        <button type="button" className="og-tc-button og-tc-primary og-tc-small" onClick={onSetup}>
          {labels.turnOn}
        </button>
      );
  }
  const connected =
    view === "ready" || view === "reconnecting" || view === "paused" || view === "finish_setup";
  return (
    <section className={["og-tc-panel", className].filter(Boolean).join(" ")} data-view={view}>
      <div className="og-tc-panel-row">
        <span className="og-tc-offer-mark">{icon ?? <LaptopIcon aria-hidden />}</span>
        <div className="og-tc-panel-text">
          <p className="og-tc-offer-title">
            {labels.title}
            <span className="og-tc-dot" data-view={view} aria-hidden />
          </p>
          <p className="og-tc-offer-text" role="status">
            {line}
          </p>
        </div>
        <div className="og-tc-panel-actions">{actions}</div>
      </div>
      {error ? (
        <p className="og-tc-error" role="alert">
          {error}
        </p>
      ) : null}
      {connected && computer.canDisconnect ? (
        confirmingOff ? (
          <div className="og-tc-confirm" role="group" aria-label={labels.turnOff}>
            <p>{labels.turnOffConfirm(machineName)}</p>
            <div>
              <button
                type="button"
                className="og-tc-button og-tc-quiet og-tc-small"
                onClick={() => setConfirmingOff(false)}
              >
                {labels.cancel}
              </button>
              <button
                type="button"
                className="og-tc-button og-tc-danger og-tc-small"
                disabled={computer.acting}
                onClick={() => void computer.disconnect().then(() => setConfirmingOff(false))}
              >
                {computer.acting ? labels.turningOff : labels.turnOff}
              </button>
            </div>
          </div>
        ) : (
          <p className="og-tc-panel-foot">
            <span>
              {view === "paused" ? labels.resumeHint(platform) : labels.pauseHint(platform)}
            </span>
            <button type="button" className="og-tc-link" onClick={() => setConfirmingOff(true)}>
              {labels.turnOff}
            </button>
          </p>
        )
      ) : null}
    </section>
  );
}
