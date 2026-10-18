import type { MachineView } from "@opengeni/sdk";
import { ArrowUpRightIcon, CheckIcon, LaptopIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useOpenGeniText } from "../../messages/runtime";
import { defaultThisComputerLabels, type ThisComputerLabels } from "./labels";
import { thisComputerView } from "./this-computer-status";
import type { UseThisComputerResult } from "./use-this-computer";

/** A personal machine that can take work now. */
function machineReachable(machine: MachineView): boolean {
  return (
    machine.state === "online" ||
    machine.state === "consent_required" ||
    machine.state === "display_unavailable"
  );
}

export interface ThisComputerCardProps {
  /** Why the agent asks, from the request; shown under the title. */
  rationale?: string | null;
  /**
   * Inside a desktop app that can host the agent: this computer, from
   * `useThisComputer`. Outside one, leave it out.
   */
  computer?: UseThisComputerResult | null;
  /**
   * The person's own computers (scope `user`), e.g. from `useMachines`, so
   * the card can say one is ready or offline when this isn't the desktop app.
   */
  machines?: readonly MachineView[] | null;
  /** The app's name, e.g. for "Get … for desktop". */
  productName: string;
  labels?: ThisComputerLabels;
  /** Opens `ThisComputerSetup` (inside the desktop app). */
  onSetup?(): void;
  /** Where to get the desktop app, outside it. */
  downloadUrl?: string | null;
  /**
   * The person set it up or resumed it from this card and it became ready,
   * e.g. to tell the agent to go on. Not called for a computer that was
   * already ready, or that became ready without the person acting here.
   */
  onReady?(machineName: string): void;
  icon?: ReactNode;
}

/**
 * What the conversation shows when the agent asks to use the person's
 * computer. In the desktop app it turns this computer on right there; on the
 * web or a phone it says whether their computer is ready, or how to get the
 * desktop app. Nothing is asked per chat: once on, agents can use it in all
 * of the person's chats.
 */
export function ThisComputerCard({
  rationale,
  computer,
  machines,
  productName,
  labels: given,
  onSetup,
  downloadUrl,
  onReady,
  icon,
}: ThisComputerCardProps) {
  const catalogText = useOpenGeniText();
  const labels = given ?? defaultThisComputerLabels(catalogText);
  const card = labels.card;
  const status = computer?.status ?? null;
  const view = computer ? thisComputerView(status) : "hidden";
  const own = (machines ?? []).filter(
    (machine) => machine.scope === "user" && machine.enrollmentId,
  );
  const reachable = own.find(machineReachable) ?? null;

  const readyName =
    view === "ready"
      ? (status?.machineName ?? "")
      : view === "hidden" && reachable
        ? reachable.name
        : null;

  // Tell the consumer once when what the person started here finishes.
  const started = useRef(false);
  const wasReady = useRef(readyName !== null);
  useEffect(() => {
    if (readyName !== null && !wasReady.current && started.current) {
      started.current = false;
      onReady?.(readyName);
    }
    wasReady.current = readyName !== null;
  }, [readyName, onReady]);
  const setup = () => {
    started.current = true;
    onSetup?.();
  };

  let copy: string;
  let action: ReactNode = null;
  let error: string | null = null;
  // The agent's reason says what turning it on is for; in the plain offer it
  // replaces the generic offer line instead of repeating it.
  let reasonIsCopy = false;
  const machineName = status?.machineName ?? "";
  if (readyName !== null) {
    copy = card.canUse(readyName);
  } else if (computer && view !== "hidden") {
    error =
      computer.actionError !== null || status?.error
        ? labels.error(status?.errorCode ?? null, status?.error || computer.actionError || null)
        : null;
    switch (view) {
      case "paused":
        copy = labels.paused(machineName);
        action = (
          <button
            type="button"
            disabled={computer.acting}
            onClick={() => {
              started.current = true;
              void computer.resume();
            }}
          >
            {labels.resume}
          </button>
        );
        break;
      case "resuming":
        copy = labels.resuming;
        action = <span className="og-tc-spinner" aria-hidden />;
        break;
      case "reconnecting":
        copy = labels.reconnecting(machineName);
        action = <span className="og-tc-spinner" aria-hidden />;
        break;
      case "setting_up":
        // The setup steps carry on by themselves and come back when they need the person.
        copy =
          status?.setupProgress === undefined
            ? labels.settingUp(machineName)
            : `${labels.settingUp(machineName)} ${Math.round(status.setupProgress * 100)}%`;
        action = <span className="og-tc-spinner" aria-hidden />;
        break;
      case "finish_setup":
        copy = labels.finishSetupDetail;
        action = (
          <button type="button" onClick={setup}>
            {labels.finishSetup}
          </button>
        );
        break;
      default:
        reasonIsCopy = Boolean(rationale) && !error;
        copy = reasonIsCopy ? rationale! : labels.offer(machineName);
        action = (
          <button type="button" onClick={setup}>
            {error ? labels.tryAgain : labels.offerAction}
          </button>
        );
    }
  } else if (own.length > 0) {
    const first = own[0]!;
    copy = card.offline(first.name, productName);
  } else {
    copy = card.getApp(productName);
    action = downloadUrl ? (
      <a href={downloadUrl} target="_blank" rel="noreferrer">
        {card.getAppAction(productName)}
        <ArrowUpRightIcon aria-hidden />
      </a>
    ) : null;
  }

  const complete = readyName !== null;
  return (
    <section className="og-session-capability og-tc-card" aria-label={card.name}>
      <div className="og-session-capability-shell" data-state={complete ? "complete" : undefined}>
        <div className="og-session-capability-header">
          <span className="og-session-capability-logo og-tc-card-logo">
            {icon ?? <LaptopIcon aria-hidden />}
          </span>
          <div className="og-session-capability-identity">
            <h3>{card.name}</h3>
            <span>{card.subtitle}</span>
          </div>
          {complete ? <CheckIcon className="og-tc-card-check" aria-hidden /> : null}
        </div>
        {rationale && !complete && !reasonIsCopy ? (
          <p className="og-session-capability-copy">{rationale}</p>
        ) : null}
        <div className="og-tc-card-foot" role="status">
          <p data-complete={complete ? "" : undefined}>{copy}</p>
          {action}
        </div>
        {error ? (
          <p className="og-tc-error" role="alert">
            {error}
          </p>
        ) : null}
        {!complete ? <p className="og-tc-card-note">{card.note}</p> : null}
      </div>
    </section>
  );
}
