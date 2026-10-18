import {
  macSystemNames,
  nextMissingPermission,
  thisComputerNeedsPermissions,
  thisComputerPermissionSteps,
  thisComputerReady,
  type ThisComputerPermissionId,
  type ThisComputerPlatform,
} from "@opengeni/sdk/this-computer";
import { CheckIcon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePortalTokenStyle } from "../../lib/use-portal-token-style";
import {
  ComputerIllustration,
  DoneIllustration,
  FolderPromptIllustration,
  SettingsRowIllustration,
} from "./illustrations";
import { useOpenGeniText } from "../../messages/runtime";
import { defaultThisComputerLabels, type ThisComputerLabels } from "./labels";
import type { UseThisComputerResult } from "./use-this-computer";

/** How long a just-allowed step shows its check before the next one. */
const ALLOWED_PAUSE_MS = 1_100;
/** How often the steps read the permissions while System Settings is open. */
const PERMISSION_POLL_MS = 1_000;
/** After macOS's folder questions, how long the new answer takes to show. */
const FOLDER_SETTLE_MS = 700;

type Phase = "intro" | "working" | "permissions" | "done";
/** Where the files step stands: not asked yet, macOS is asking, or asked. */
type FolderAsk = "idle" | "asking" | "asked";

export interface ThisComputerSetupProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** From `useThisComputer` for the open workspace. */
  computer: UseThisComputerResult;
  platform: ThisComputerPlatform;
  /** The app's name as System Settings lists it. */
  productName: string;
  /** The app's icon, pictured in the System Settings row. */
  appIcon?: string | null;
  /** The agent's mark, shown on the pictured computer (an avatar or logo). */
  agentMark?: ReactNode;
  labels?: ThisComputerLabels;
  /** Where the dialog portals to; defaults to `document.body`. */
  container?: HTMLElement | null;
  /** The person finished setting up (ready, permissions and all). */
  onReady?(): void;
}

/**
 * Whether `ThisComputerSetup` is open. It opens by itself once when the
 * person left setup unfinished, e.g. when macOS restarted the app for a
 * permission, so they land back on the step they were on.
 */
export function useThisComputerSetupOpen(
  computer: UseThisComputerResult,
): [open: boolean, setOpen: (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const reopened = useRef(false);
  const pending = computer.status?.setupPending === true;
  useEffect(() => {
    if (!pending || reopened.current) return;
    reopened.current = true;
    setOpen(true);
  }, [pending]);
  return [open, setOpen];
}

/**
 * Turning on "Use this computer", start to finish, in one dialog: what it
 * means, the one-time download, each macOS permission one at a time with a
 * picture of the switch to turn on, and "you're all set". Closing midway is
 * fine; the status pieces offer to finish later.
 */
export function ThisComputerSetup({
  open,
  onOpenChange,
  computer,
  platform,
  productName,
  appIcon,
  agentMark,
  labels: given,
  container,
  onReady,
}: ThisComputerSetupProps) {
  const catalogText = useOpenGeniText();
  const labels = given ?? defaultThisComputerLabels(catalogText);
  const { status } = computer;
  const [phase, setPhase] = useState<Phase>("intro");
  const [failure, setFailure] = useState<string | null>(null);
  const [requested, setRequested] = useState<ThisComputerPermissionId | null>(null);
  const [justAllowed, setJustAllowed] = useState<ThisComputerPermissionId | null>(null);
  const [folderAsk, setFolderAsk] = useState<FolderAsk>("idle");
  const anchor = useRef<HTMLSpanElement>(null);
  const portalStyle = usePortalTokenStyle(anchor.current);
  const wasOpen = useRef(false);

  // Each opening starts where the computer stands.
  useEffect(() => {
    if (open && !wasOpen.current) {
      setFailure(null);
      setRequested(null);
      setJustAllowed(null);
      setFolderAsk("idle");
      setPhase(
        thisComputerNeedsPermissions(status)
          ? "permissions"
          : thisComputerReady(status)
            ? "done"
            : status?.busy
              ? "working"
              : "intro",
      );
    }
    wasOpen.current = open;
  }, [open, status]);

  // A download started elsewhere (or before a relaunch) finishes here.
  useEffect(() => {
    if (!open || phase !== "working" || status?.busy) return;
    if (thisComputerNeedsPermissions(status)) setPhase("permissions");
    else if (thisComputerReady(status)) setPhase("done");
  }, [open, phase, status]);

  // Permissions are granted in System Settings, outside the app.
  const { refresh } = computer;
  useEffect(() => {
    if (!open || phase !== "permissions") return;
    const timer = window.setInterval(refresh, PERMISSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, phase, refresh]);

  const permissions = thisComputerPermissionSteps(status);
  const missing = nextMissingPermission(status);
  // The step shown: the one just allowed (for a moment), else the next missing.
  const current = justAllowed ?? missing;

  // When the step being shown is allowed, show its check, then move on.
  const shownRef = useRef<ThisComputerPermissionId | null>(null);
  useEffect(() => {
    if (phase !== "permissions") {
      shownRef.current = null;
      return;
    }
    const shown = shownRef.current;
    if (justAllowed === null && shown !== null && shown !== missing) {
      setJustAllowed(shown);
      setRequested(null);
      return;
    }
    if (justAllowed === null) shownRef.current = missing;
  }, [phase, missing, justAllowed]);
  useEffect(() => {
    if (justAllowed === null) return;
    const timer = window.setTimeout(() => {
      shownRef.current = missing;
      setJustAllowed(null);
      if (missing === null) setPhase("done");
    }, ALLOWED_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [justAllowed, missing]);
  // Everything was already allowed (e.g. granted before the steps showed).
  useEffect(() => {
    if (phase === "permissions" && missing === null && justAllowed === null && status) {
      if (status.state === "connected") setPhase("done");
    }
  }, [phase, missing, justAllowed, status]);

  const readyNotified = useRef(false);
  useEffect(() => {
    if (phase === "done" && open && !readyNotified.current) {
      readyNotified.current = true;
      onReady?.();
    }
    if (phase !== "done") readyNotified.current = false;
  }, [phase, open, onReady]);

  async function turnOn() {
    setFailure(null);
    setPhase("working");
    const next = await computer.connect({ screenControl: true });
    if (!next || next.state !== "connected") {
      setFailure(
        labels.error(next?.errorCode ?? null, next?.error ?? computer.actionError ?? null),
      );
      setPhase("intro");
      return;
    }
    setPhase(thisComputerNeedsPermissions(next) ? "permissions" : "done");
  }

  const machineName = status?.machineName ?? "";
  const close = () => onOpenChange(false);
  const busyConnecting = phase === "working";

  let lead: ReactNode = null;
  let body: ReactNode = null;
  let title: string;
  let description: string;
  let footer: ReactNode;

  if (phase === "done") {
    title = labels.doneTitle;
    description = labels.done(machineName, platform);
    lead = <DoneIllustration />;
    body = labels.tryThis ? <p className="og-tc-try">{labels.tryThis}</p> : null;
    footer = (
      <button type="button" className="og-tc-button og-tc-primary og-tc-wide" onClick={close}>
        {labels.close}
      </button>
    );
  } else if (phase === "permissions" && current) {
    const index = Math.max(
      0,
      permissions.findIndex((permission) => permission.id === current),
    );
    const step = labels.permission(current, productName);
    // What's on screen is in the system's language, which can differ from ours.
    const system =
      computer.status?.systemNames ??
      macSystemNames(typeof navigator === "undefined" ? [] : navigator.languages);
    const allowed = justAllowed === current;
    const waiting = requested === current && !allowed;
    const folders = current === "files";
    // Asked, and still not allowed: a folder was refused, so System Settings is the way.
    const refused = folders && folderAsk === "asked" && !allowed;
    title = step.title;
    description = step.why;
    lead = (
      <>
        <ol className="og-tc-steps" aria-label={labels.stepOf(index + 1, permissions.length)}>
          {permissions.map((permission, position) => (
            <li
              key={permission.id}
              data-state={
                permission.granted || permission.id === justAllowed
                  ? "done"
                  : position === index
                    ? "current"
                    : "todo"
              }
            />
          ))}
        </ol>
        <p className="og-tc-step-count">{labels.stepOf(index + 1, permissions.length)}</p>
      </>
    );
    body = (
      <>
        {folders && !refused ? (
          <FolderPromptIllustration
            message={system.folderQuestion.replace("{app}", productName)}
            allow={system.allow}
            dontAllow={system.dontAllow}
            appName={productName}
            appIcon={appIcon ?? null}
            allowed={allowed}
          />
        ) : (
          <SettingsRowIllustration
            key={current}
            listName={computer.status?.systemNames?.permissionList[current] ?? step.listName}
            appName={productName}
            appIcon={appIcon ?? null}
            allowed={allowed}
          />
        )}
        <div className="og-tc-step-state" role="status" aria-live="polite">
          {allowed ? (
            <span className="og-tc-allowed">
              <CheckIcon aria-hidden />
              {labels.allowed}
            </span>
          ) : refused ? (
            <span className="og-tc-hint">{labels.foldersRefused(productName)}</span>
          ) : folders ? (
            <span className={folderAsk === "asking" ? "og-tc-waiting" : "og-tc-hint"}>
              {folderAsk === "asking" ? <span className="og-tc-pulse" aria-hidden /> : null}
              {labels.waitingForFolders(system.allow)}
            </span>
          ) : waiting ? (
            <span className="og-tc-waiting">
              <span className="og-tc-pulse" aria-hidden />
              {labels.waitingForSwitch(productName, system.openSettings)}
            </span>
          ) : (
            <span className="og-tc-hint">{labels.passwordHint}</span>
          )}
        </div>
        {waiting && (current === "screenRecording" || current === "inputMonitoring") ? (
          <p className="og-tc-fine">{labels.quitHint(productName, system.later)}</p>
        ) : null}
      </>
    );
    const askFolders = async () => {
      setRequested("files");
      setFolderAsk("asking");
      await computer.requestPermission("files");
      window.setTimeout(() => setFolderAsk("asked"), FOLDER_SETTLE_MS);
    };
    footer = (
      <>
        <button type="button" className="og-tc-button og-tc-quiet" onClick={close}>
          {labels.later}
        </button>
        {folders && !refused ? (
          <button
            type="button"
            className="og-tc-button og-tc-primary"
            disabled={allowed || folderAsk !== "idle"}
            onClick={() => void askFolders()}
          >
            {labels.askFolders}
          </button>
        ) : (
          <button
            type="button"
            className={`og-tc-button ${waiting && !refused ? "og-tc-secondary" : "og-tc-primary"}`}
            disabled={allowed}
            onClick={() => {
              setRequested(current);
              void computer.requestPermission(current);
            }}
          >
            {waiting && !refused ? labels.openSettingsAgain : labels.openSettings}
          </button>
        )}
      </>
    );
  } else if (phase === "working") {
    const progress = status?.setupProgress;
    title = labels.settingUp(machineName);
    description = labels.settingUpDetail;
    lead = <ComputerIllustration mark={agentMark} />;
    body = (
      <>
        <div
          className="og-tc-progress"
          role="progressbar"
          aria-label={labels.settingUp(machineName)}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(progress === undefined ? {} : { "aria-valuenow": Math.round(progress * 100) })}
          data-indeterminate={progress === undefined ? "" : undefined}
        >
          <span
            style={
              progress === undefined ? undefined : { width: `${Math.max(4, progress * 100)}%` }
            }
          />
        </div>
      </>
    );
    footer = null;
  } else {
    title = labels.title;
    description = labels.intro(machineName);
    lead = <ComputerIllustration mark={agentMark} />;
    body = (
      <>
        <ul className="og-tc-abilities">
          {labels.abilities.map((ability) => (
            <li key={ability}>
              <CheckIcon aria-hidden />
              {ability}
            </li>
          ))}
        </ul>
        <p className="og-tc-safety">{labels.safety(platform)}</p>
        {failure ? (
          <p className="og-tc-error" role="alert">
            {failure}
          </p>
        ) : null}
      </>
    );
    footer = (
      <>
        <button type="button" className="og-tc-button og-tc-quiet" onClick={close}>
          {labels.notNow}
        </button>
        <button type="button" className="og-tc-button og-tc-primary" onClick={() => void turnOn()}>
          {failure ? labels.tryAgain : labels.turnOn}
        </button>
      </>
    );
  }

  return (
    <>
      <span ref={anchor} hidden />
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal container={container ?? undefined}>
          <Dialog.Overlay className="og-root og-tc-overlay" style={portalStyle} />
          <Dialog.Content
            className="og-root og-tc-dialog"
            style={portalStyle}
            data-phase={phase}
            onOpenAutoFocus={(event) => {
              // The dialog itself takes focus, so no button starts out ringed.
              event.preventDefault();
              (event.currentTarget as HTMLElement | null)?.focus();
            }}
            onInteractOutside={(event) => {
              // A stray click beside the dialog mustn't end setup midway.
              if (phase !== "intro" && phase !== "done") event.preventDefault();
            }}
          >
            {phase === "working" ? null : (
              <Dialog.Close className="og-tc-close" aria-label={labels.close}>
                <XIcon aria-hidden />
              </Dialog.Close>
            )}
            <div className="og-tc-body" aria-busy={busyConnecting || undefined}>
              <div className="og-tc-content" key={phase === "permissions" ? `p-${current}` : phase}>
                {lead}
                <Dialog.Title className="og-tc-title">{title}</Dialog.Title>
                <Dialog.Description className="og-tc-description">{description}</Dialog.Description>
                {body}
              </div>
            </div>
            {footer ? <div className="og-tc-footer">{footer}</div> : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
