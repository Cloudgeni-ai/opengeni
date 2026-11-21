import type { MachineView } from "@opengeni/sdk";
import { ArrowUpRightIcon, CheckIcon, LaptopIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useOpenGeniText } from "../../messages/runtime";
import { defaultThisComputerLabels, type ThisComputerLabels } from "./labels";
import {
  computerUseFix,
  computerUsePermissionText,
  computerUseProblemText,
  computerUseState,
} from "./computer-use";
import type { UseThisComputerResult } from "./use-this-computer";

/** A personal machine that can take work now. */
function machineReachable(machine: MachineView): boolean {
  return (
    machine.state === "online" ||
    machine.state === "consent_required" ||
    machine.state === "display_unavailable"
  );
}

type DesktopOs = "macos" | "windows" | "linux";

/**
 * The device this page runs on, as far as its browser says for sure: a phone
 * or tablet, a desktop system, or null when it can't tell. A connected
 * computer on another system is certainly not this device.
 */
export function browserDevice(
  userAgent: string | undefined,
  maxTouchPoints = 0,
): { kind: "handheld" } | { kind: "desktop"; os: DesktopOs } | null {
  if (!userAgent) return null;
  if (/iPhone|iPad|iPod|Android/u.test(userAgent)) return { kind: "handheld" };
  // iPadOS asks for desktop pages as a Mac; only its touch screen tells.
  if (/Macintosh/u.test(userAgent) && maxTouchPoints > 1) return { kind: "handheld" };
  if (/Windows/u.test(userAgent)) return { kind: "desktop", os: "windows" };
  if (/Macintosh|Mac OS X/u.test(userAgent)) return { kind: "desktop", os: "macos" };
  // A Chromebook can run Linux machines inside it, so it may be one.
  if (/CrOS/u.test(userAgent)) return null;
  if (/Linux|X11/u.test(userAgent)) return { kind: "desktop", os: "linux" };
  return null;
}

function machineOs(os: string): DesktopOs | null {
  if (os === "macos" || os === "darwin") return "macos";
  if (os === "windows" || os === "win32") return "windows";
  if (os === "linux") return "linux";
  return null;
}

function currentBrowserDevice(): ReturnType<typeof browserDevice> {
  if (typeof navigator === "undefined") return null;
  return browserDevice(navigator.userAgent, navigator.maxTouchPoints);
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
   * A ready one completes the card only when it may be this device, or when
   * this device can't be what the person means (a phone) or can be connected
   * from here (`onConnect`, `downloads`, `openAppUrl` or `downloadUrl`).
   * Otherwise the card names it and keeps this device's own text and links.
   */
  machines?: readonly MachineView[] | null;
  /** The app's name, e.g. for "Get … for desktop". */
  productName: string;
  labels?: ThisComputerLabels;
  /**
   * "Open System Settings" for a missing permission, e.g. to open
   * `ThisComputerSetup`. Without it, the card asks for the missing
   * permissions itself (`computer.allowPermissions`).
   */
  onSetup?(): void;
  /** Signs the person in again when computer use needs it; else that offers Try again. */
  onSignIn?: (() => void) | undefined;
  /** Where to get the desktop app, outside it. */
  downloadUrl?: string | null;
  /** Host-owned OS-appropriate app downloads. Never inferred from a capability event. */
  downloads?: readonly { label: string; url: string }[];
  /** Host-owned handoff preserving the signed-in account and current destination. */
  openAppUrl?: string | null;
  /** Optional product-owned flow, for apps not using the desktop kit. */
  onConnect?: (() => Promise<void>) | undefined;
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
  onSignIn,
  downloadUrl,
  downloads,
  openAppUrl,
  onConnect,
  onReady,
  icon,
}: ThisComputerCardProps) {
  const catalogText = useOpenGeniText();
  const labels = given ?? defaultThisComputerLabels(catalogText);
  const card = labels.card;
  // A ready computer may not be the one the person means: on the web, the
  // host's own connect path stays one click away after the card completes.
  const [connectingAnother, setConnectingAnother] = useState(false);
  const anotherStepsId = useId();
  const status = computer?.status ?? null;
  const use = computer ? computerUseState(computer) : ({ kind: "hidden" } as const);
  const own = (machines ?? []).filter(
    (machine) => machine.scope === "user" && machine.enrollmentId,
  );
  // Outside the desktop app, the browser can't say which computer it runs on,
  // only its system. A ready computer on another system isn't this one.
  const device = computer ? null : currentBrowserDevice();
  const reachableOwn = own.filter(machineReachable);
  const reachable =
    (device?.kind === "desktop"
      ? reachableOwn.find((machine) => machineOs(machine.os) === device.os)
      : undefined) ??
    reachableOwn[0] ??
    null;
  const reachableOs = reachable ? machineOs(reachable.os) : null;
  const elsewhere = device?.kind === "desktop" && reachableOs !== null && reachableOs !== device.os;
  const hostConnects = Boolean(onConnect || downloads?.length || openAppUrl || downloadUrl);

  const readyName =
    use.kind === "on"
      ? (status?.machineName ?? "")
      : use.kind === "hidden" && reachable
        ? reachable.name
        : null;
  // A ready computer that may not be the one the person means completes the
  // card only while this device's own connect path stays one click away. A
  // computer on another system, or a device the host can't connect, leaves
  // the request open: the card names the ready one and keeps this device's
  // own text and links.
  const readyElsewhere =
    !computer && readyName !== null && device?.kind !== "handheld" && (elsewhere || !hostConnects);
  const complete = readyName !== null && !readyElsewhere;
  const doneName = complete ? readyName : null;

  // Tell the consumer once when what the person started here finishes.
  const started = useRef(false);
  const wasReady = useRef(doneName !== null);
  useEffect(() => {
    if (doneName !== null && !wasReady.current && started.current) {
      started.current = false;
      onReady?.(doneName);
    }
    wasReady.current = doneName !== null;
  }, [doneName, onReady]);
  const setup = () => {
    started.current = true;
    if (onSetup) onSetup();
    else computer?.allowPermissions();
  };
  // Turning on asks for any missing permission itself.
  const turnOn = () => {
    if (!computer || computer.acting) return;
    started.current = true;
    void computer.turnOn().then((next) => {
      if (!next) started.current = false;
    });
  };

  let copy: string;
  // The ready computer, above this device's own text while the request is open.
  let readyLines: ReactNode = null;
  let action: ReactNode = null;
  // The agent's reason says what turning it on is for; in the plain offer it
  // replaces the generic offer line instead of repeating it.
  let reasonIsCopy = false;
  const machineName = status?.machineName ?? "";
  if (complete && readyName !== null) {
    copy = card.canUse(readyName);
  } else if (computer && use.kind !== "hidden") {
    switch (use.kind) {
      case "turning_on":
        copy =
          use.progress === null
            ? catalogText("thisComputer.computerUse.turningOn")
            : `${catalogText("thisComputer.computerUse.turningOn")} ${Math.round(use.progress * 100)}%`;
        action = <span className="og-tc-spinner" aria-hidden />;
        break;
      case "needs_permission":
        copy = computerUsePermissionText(use.appName ?? productName, catalogText);
        action = (
          <button type="button" onClick={setup}>
            {catalogText("thisComputer.computerUse.openSettings")}
          </button>
        );
        break;
      case "problem": {
        copy = computerUseProblemText(use, machineName, catalogText, labels);
        const fix = computerUseFix(use.problem);
        action =
          fix === "sign_in" && onSignIn ? (
            <button type="button" onClick={onSignIn}>
              {catalogText("thisComputer.computerUse.signIn")}
            </button>
          ) : (
            <button type="button" disabled={computer.acting} onClick={turnOn}>
              {labels.tryAgain}
            </button>
          );
        break;
      }
      default:
        reasonIsCopy = Boolean(rationale);
        copy = reasonIsCopy
          ? rationale!
          : catalogText("thisComputer.computerUse.off", { machineName });
        action = (
          <button type="button" disabled={computer.acting} onClick={turnOn}>
            {labels.turnOn}
          </button>
        );
    }
  } else if (own.length > 0 && !readyElsewhere) {
    const first = own[0]!;
    copy = card.offline(first.name, productName);
  } else {
    // Beside a ready computer elsewhere, the agent's reason stays on top and
    // saying it's another computer leads to connecting this one.
    const other =
      readyElsewhere && elsewhere && readyName !== null
        ? catalogText("thisComputer.card.otherComputer", { machineName: readyName })
        : null;
    if (readyElsewhere && readyName !== null) {
      readyLines = (
        <>
          <p className="og-tc-card-ready">{card.canUse(readyName)}</p>
          {other && !onConnect ? <p className="og-tc-card-ready">{other}</p> : null}
        </>
      );
    }
    reasonIsCopy = Boolean(onConnect && rationale && !readyElsewhere);
    copy = onConnect
      ? (other ?? (reasonIsCopy ? rationale! : card.subtitle))
      : downloads?.length || openAppUrl
        ? catalogText("thisComputer.card.installThenOpen")
        : card.getApp(productName);
    action =
      downloadUrl && !onConnect ? (
        <a href={downloadUrl} target="_blank" rel="noreferrer">
          {card.getAppAction(productName)}
          <ArrowUpRightIcon aria-hidden />
        </a>
      ) : null;
  }
  if (!computer && !complete && onConnect) {
    action = (
      <HostConnectAction
        onConnect={async () => {
          started.current = true;
          try {
            await onConnect();
          } catch (caught) {
            started.current = false;
            throw caught;
          }
        }}
        label={labels.offerAction}
      />
    );
  }

  const offerAnother = complete && !computer && hostConnects;
  const anotherLabel = catalogText("thisComputer.card.connectAnother");
  const hasDownloads = Boolean(downloads?.length || openAppUrl);
  // Install-and-open links for this device, for a first computer or (after a
  // lead line saying so) for another one when that one is this device.
  const downloadLinks = hasDownloads ? (
    <>
      {downloads?.map((download) => (
        <a key={download.url} href={download.url}>
          {download.label}
        </a>
      ))}
      {openAppUrl ? <a href={openAppUrl}>{catalogText("thisComputer.card.openApp")}</a> : null}
    </>
  ) : null;
  let another: ReactNode = null;
  if (offerAnother && onConnect) {
    another = (
      <div className="og-tc-card-foot og-tc-card-another">
        <HostConnectAction onConnect={onConnect} label={anotherLabel} secondary />
      </div>
    );
  } else if (offerAnother) {
    // A disclosure: the button stays put (and keeps focus) while the steps
    // open below it. The steps happen on the other computer; this device's
    // links only help when that computer is this one, and say so.
    another = (
      <>
        <div className="og-tc-card-foot og-tc-card-another">
          <button
            type="button"
            data-secondary=""
            aria-expanded={connectingAnother}
            aria-controls={anotherStepsId}
            onClick={() => setConnectingAnother((open) => !open)}
          >
            {anotherLabel}
          </button>
        </div>
        <div id={anotherStepsId} className="og-tc-card-another-steps" hidden={!connectingAnother}>
          <div className="og-tc-card-foot">
            <p>
              {hasDownloads
                ? catalogText("thisComputer.card.anotherSteps")
                : catalogText("thisComputer.card.anotherGetApp", { productName })}
            </p>
          </div>
          <div className="og-tc-card-foot og-tc-card-downloads">
            <p className="og-tc-card-here">{catalogText("thisComputer.card.anotherIsThisOne")}</p>
            {downloadLinks ??
              (downloadUrl ? (
                <a href={downloadUrl} target="_blank" rel="noreferrer">
                  {card.getAppAction(productName)}
                  <ArrowUpRightIcon aria-hidden />
                </a>
              ) : null)}
          </div>
        </div>
      </>
    );
  }
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
          {readyLines}
          <p data-complete={complete ? "" : undefined}>{copy}</p>
          {action}
        </div>
        {!computer && !complete && downloadLinks ? (
          <div className="og-tc-card-foot og-tc-card-downloads">{downloadLinks}</div>
        ) : null}
        {another}
        {!complete ? <p className="og-tc-card-note">{card.note}</p> : null}
      </div>
    </section>
  );
}

function HostConnectAction({
  onConnect,
  label,
  secondary = false,
}: {
  onConnect: () => Promise<void>;
  label: string;
  /** A quieter button, beside a computer that is already ready. */
  secondary?: boolean;
}) {
  const t = useOpenGeniText();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        data-secondary={secondary ? "" : undefined}
        onClick={() => {
          if (busyRef.current) return;
          busyRef.current = true;
          setBusy(true);
          setFailed(false);
          void Promise.resolve()
            .then(onConnect)
            .catch(() => setFailed(true))
            .finally(() => {
              busyRef.current = false;
              setBusy(false);
            });
        }}
      >
        {label}
      </button>
      {failed ? <p role="alert">{t("thisComputer.card.connectFailed")}</p> : null}
    </>
  );
}
