import type { MachineView, Session, SessionMachineAccess } from "@opengeni/sdk";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useSessionStart, type UseSessionStartOptions } from "../hooks/use-session-start";
import { useOpenGeniText } from "../messages/runtime";
import { machineDisplayName } from "../sandbox-label-model";
import {
  personalMachineCopy,
  sessionAdmissionCopy,
  sessionAdmissionMachineChangedCopy,
  sessionAdmissionNeedsDifferentMachine,
  sessionAdmissionReason,
  sessionWaitingWorkExplainsBlock,
  waitingWorkCopy,
} from "../session-admission-model";
import { Button } from "../ui/button";
import { Notice } from "../ui/notice";

/**
 * Why a chat that runs on a personal machine can't take somebody's message,
 * with the ways forward. `queued` explains a saved message the runtime
 * refused; otherwise it warns about a draft before it is sent.
 */
export function PersonalMachineExplanation({
  access,
  queued = false,
  action,
}: {
  access: SessionMachineAccess;
  queued?: boolean | undefined;
  /** A machine picker or other way forward, shown before the copy-request button. */
  action?: ReactNode | undefined;
}) {
  const t = useOpenGeniText();
  const copy = personalMachineCopy(t, access, { queued });
  return (
    <>
      <p>{copy.explanation}</p>
      <p className="mt-1">{copy.next}</p>
      {copy.workNote ? <p className="mt-1">{copy.workNote}</p> : null}
      <OwnerRequestActions request={copy.ownerRequest} label={copy.copyRequest} action={action} />
    </>
  );
}

/** A way forward plus "Copy request to …": a message the person sends the owner themselves. */
function OwnerRequestActions({
  request,
  label,
  action,
}: {
  request: string | null;
  label: string | null;
  action?: ReactNode | undefined;
}) {
  const t = useOpenGeniText();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  if (!action && !(request && label)) return null;
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {action}
        {request && label ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 max-w-full whitespace-normal"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(request);
                setCopyState("copied");
              } catch {
                setCopyState("failed");
              }
            }}
          >
            {copyState === "copied" ? t("sessionAdmission.requestCopied") : label}
          </Button>
        ) : null}
      </div>
      {request && copyState !== "idle" ? (
        <p role="status" className="mt-1">
          {copyState === "copied" ? t("sessionAdmission.requestCopiedNote") : request}
        </p>
      ) : null}
    </>
  );
}

/**
 * Updates from other people's work (their agents' messages and workers'
 * results) wait because this chat runs on somebody's personal machine. One
 * notice for all of them, updated in place: it says whose updates wait and
 * why, and gives the machine's owner the way to let the agent continue with
 * them under the owner's own access. Everyone else acts from the composer's
 * notice (choose a machine, or ask the owner). Renders nothing when nothing waits.
 */
export function SessionWaitingWorkNotice({
  access,
  busy = false,
  onContinue,
}: {
  access: SessionMachineAccess;
  /** Another control action is in flight. */
  busy?: boolean | undefined;
  /** The owner lets the agent continue with them; omitted where the host can't. */
  onContinue?: (() => Promise<void>) | undefined;
}) {
  const t = useOpenGeniText();
  const descriptionId = useId();
  const pending = useRef(false);
  const [continuing, setContinuing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const copy = waitingWorkCopy(t, access);
  if (!copy) return null;
  const canContinue = copy.continueAction !== null && onContinue !== undefined;

  async function continueWork() {
    if (pending.current || busy || !onContinue) return;
    pending.current = true;
    setContinuing(true);
    setFailure(null);
    try {
      await onContinue();
    } catch (error) {
      // 409: the chat is not running the owner's own work yet (for example,
      // someone else sent the last message before it moved to this machine).
      setFailure(
        (error as { status?: unknown } | null)?.status === 409
          ? t("sessionAdmission.continueWaitingWorkNeedsYourTurn")
          : t("sessionAdmission.continueWaitingWorkFailed"),
      );
    } finally {
      pending.current = false;
      setContinuing(false);
    }
  }

  return (
    <Notice tone="waiting" title={copy.title}>
      <div id={descriptionId} role="status" aria-live="polite">
        <p>{copy.explanation}</p>
        {copy.continueAction === null || canContinue ? <p className="mt-1">{copy.next}</p> : null}
      </div>
      {canContinue ? (
        <Button
          type="button"
          className="mt-2 min-h-11"
          disabled={busy || continuing}
          aria-busy={continuing}
          aria-describedby={descriptionId}
          onClick={() => void continueWork()}
        >
          {continuing ? t("sessionAdmission.continuingWaitingWork") : copy.continueAction}
        </Button>
      ) : null}
      {failure ? (
        <p role="alert" className="mt-2">
          {failure}
        </p>
      ) : null}
    </Notice>
  );
}

/**
 * Before sending: the chat runs on somebody else's personal machine, so a new
 * message from this person could not start there. Renders nothing for the
 * machine's owner or when the chat is not on a personal machine.
 */
export function SessionMachineAccessNotice({
  access,
  action,
}: {
  access: SessionMachineAccess | null | undefined;
  action?: ReactNode | undefined;
}) {
  const t = useOpenGeniText();
  if (!access || access.isOwner) return null;
  return (
    <Notice tone="waiting" title={t("sessionAdmission.preSendTitle")} live="polite">
      <PersonalMachineExplanation access={access} action={action} />
    </Notice>
  );
}

export type SessionAdmissionNoticeProps = {
  session: Session;
  /** The person may pause, resume and recheck this session. */
  canControl: boolean;
  /** The session is paused; rechecking would not clear that. */
  paused: boolean;
  /** Another control action is in flight. */
  busy: boolean;
  /** Control changed underneath the notice: re-read before any recheck. */
  refreshRequired?: boolean | undefined;
  /** One fenced Resume followed by a fresh read (see `recheckSessionAdmission`). */
  onRecheck: () => Promise<void>;
  /** The session's current personal-machine projection, when known. */
  machineAccess?: SessionMachineAccess | null | undefined;
  /** The machine picker offered when the saved message needs a different machine. */
  machineAction?: ReactNode | undefined;
  /**
   * As the machine's owner, let the agent continue with other people's
   * waiting updates (`machineAccess.waitingWork`): continue, then recheck a
   * blocked chat and refresh. Omit where the host cannot.
   */
  onContinueWaitingWork?: (() => Promise<void>) | undefined;
};

/**
 * The runtime refused to start the session's next message (an admission
 * block). Says why in the person's language, keeps the saved message, and
 * offers the one safe way forward: choose a machine they can use, or recheck
 * after access changes. Renders nothing when the session is not blocked.
 */
export function SessionAdmissionNotice({
  session,
  canControl,
  paused,
  busy,
  refreshRequired = false,
  onRecheck,
  machineAccess,
  machineAction,
  onContinueWaitingWork,
}: SessionAdmissionNoticeProps) {
  const t = useOpenGeniText();
  const descriptionId = useId();
  const pending = useRef(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [blockedMachine, setBlockedMachine] = useState<{
    sandboxId: string;
    blockedAt: string | undefined;
  } | null>(null);
  const reason = sessionAdmissionReason(session);
  const machineBlocked = sessionAdmissionNeedsDifferentMachine(reason, machineAccess);
  const blockedAt = session.admissionBlock?.blockedAt;
  const machineSandboxId = machineAccess?.sandboxId;
  useEffect(() => {
    if (machineBlocked && machineSandboxId) {
      setBlockedMachine((previous) =>
        previous?.sandboxId === machineSandboxId && previous.blockedAt === blockedAt
          ? previous
          : { sandboxId: machineSandboxId, blockedAt },
      );
    }
  }, [machineBlocked, machineSandboxId, blockedAt]);
  // Other people's updates waiting on a personal machine: one calm notice
  // that says whose and why, instead of a generic permission failure.
  if (
    machineAccess?.waitingWork?.length &&
    !machineBlocked &&
    sessionWaitingWorkExplainsBlock(reason)
  ) {
    return (
      <SessionWaitingWorkNotice
        access={machineAccess}
        busy={busy || (paused && reason !== null)}
        onContinue={canControl ? onContinueWaitingWork : undefined}
      />
    );
  }
  if (!reason) return null;
  const machineChanged =
    reason.reason === "database_claim_rejected" &&
    reason.permissionDenied &&
    !machineBlocked &&
    blockedMachine !== null &&
    blockedMachine.blockedAt === blockedAt &&
    blockedMachine.sandboxId !== session.activeSandboxId;
  const copy = machineChanged
    ? sessionAdmissionMachineChangedCopy(t)
    : sessionAdmissionCopy(t, reason);

  async function recheck() {
    if (pending.current || busy || ((paused || machineBlocked) && !refreshRequired) || !canControl)
      return;
    pending.current = true;
    setChecking(true);
    setFailed(false);
    try {
      await onRecheck();
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setChecking(false);
    }
  }

  return (
    <Notice
      tone={machineChanged ? "waiting" : "failed"}
      title={machineBlocked ? t("sessionAdmission.needsDifferentMachineTitle") : copy.title}
    >
      <div id={descriptionId} role="status" aria-live="polite">
        {machineBlocked && machineAccess ? (
          <PersonalMachineExplanation access={machineAccess} queued action={machineAction} />
        ) : (
          <>
            <p>{copy.body}</p>
            <p className="mt-1">{copy.next}</p>
          </>
        )}
      </div>
      {refreshRequired ? <p className="mt-2">{t("sessionAdmission.refreshRequiredNote")}</p> : null}
      {paused && !refreshRequired ? (
        <p className="mt-2">{t("sessionAdmission.pausedNote")}</p>
      ) : canControl ? (
        <Button
          type="button"
          className="mt-2 min-h-11"
          disabled={busy || checking || (machineBlocked && !refreshRequired)}
          aria-busy={checking}
          aria-describedby={descriptionId}
          onClick={() => void recheck()}
        >
          {checking
            ? refreshRequired
              ? t("sessionAdmission.refreshing")
              : t("sessionAdmission.rechecking")
            : refreshRequired
              ? t("sessionAdmission.refreshSessionStatus")
              : copy.action}
        </Button>
      ) : (
        <p className="mt-2">{t("sessionAdmission.cantRecheckNote")}</p>
      )}
      {failed ? (
        <p role="alert" className="mt-2">
          {refreshRequired
            ? t("sessionAdmission.refreshFailed")
            : t("sessionAdmission.recheckFailed")}
        </p>
      ) : null}
    </Notice>
  );
}

export type SessionMachineChoicesProps = {
  /** Machines the saved message can move to; see `savedMessageMachineChoices`. */
  machines: readonly MachineView[];
  /** Move the chat; resolve to an error to show, or null once it moved. */
  onChoose: (machine: MachineView) => Promise<string | null>;
  disabled?: boolean | undefined;
  /** A more specific reason for the last failed move (for example, the machine went offline). */
  failureDetail?: string | null | undefined;
};

/**
 * A compact "Choose machine" disclosure listing the machines the person may
 * move the chat to. Moving never resends anything: the saved message runs only
 * after an explicit recheck.
 */
export function SessionMachineChoices({
  machines,
  onChoose,
  disabled,
  failureDetail,
}: SessionMachineChoicesProps) {
  const t = useOpenGeniText();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    // `contents`: the toggle sits in its parent's action row (beside "Copy
    // request"); the open list wraps onto its own full-width line below it.
    <div className="contents">
      <Button
        type="button"
        className="min-h-11"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {t("sessionAdmission.chooseMachine")}
      </Button>
      {open ? (
        <div id={listId} className="order-last flex basis-full flex-col gap-1">
          {machines.length === 0 ? (
            <p>{t("sessionAdmission.noMachineChoices")}</p>
          ) : (
            <ul
              aria-label={t("sessionAdmission.chooseAMachineForThisChat")}
              className="flex flex-col gap-1"
            >
              {machines.map((machine) => (
                <li key={machine.sandboxId}>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full max-w-full justify-start whitespace-normal text-left"
                    disabled={disabled || moving !== null}
                    aria-busy={moving === machine.sandboxId}
                    onClick={async () => {
                      setMoving(machine.sandboxId);
                      setError(null);
                      try {
                        const failure = await onChoose(machine);
                        if (failure) setError(failure);
                        else setOpen(false);
                      } catch {
                        setError(t("sessionAdmission.machineChangeFailed"));
                      } finally {
                        setMoving(null);
                      }
                    }}
                  >
                    {moving === machine.sandboxId
                      ? t("sessionAdmission.moving")
                      : machineDisplayName(t, machine)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs">{t("sessionAdmission.savedMessageMachineNote")}</p>
          {error ? (
            <p role="alert" className="text-status-failed">
              {failureDetail || error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type SessionStartNoticeProps = UseSessionStartOptions & {
  /** The person may control this session. The server enforces it either way. */
  canControl?: boolean | undefined;
  /** Another control action (send, pause, resume) is in flight. */
  busy?: boolean | undefined;
  /** Warn before sending when the chat runs on somebody else's personal machine. */
  showPreSendWarning?: boolean | undefined;
};

/**
 * Everything a chat embedding needs to explain why a message can't start:
 * the admission block for a saved message the runtime refused and, before
 * sending, the personal-machine warning. Offers the machines the person may
 * use, moves the chat, and rechecks with one fenced Resume, so the saved
 * message is kept and never sent twice. Access control is the server's; this
 * only explains it and offers the allowed ways forward. Every word comes from
 * the message catalog (`sessionAdmission.*`).
 */
export function SessionStartNotice({
  canControl = true,
  busy = false,
  showPreSendWarning = true,
  ...options
}: SessionStartNoticeProps) {
  const start = useSessionStart(options);
  const { session } = options;
  const picker = start.canChooseMachine ? (
    <SessionMachineChoices
      machines={start.machineChoices}
      onChoose={start.chooseMachine}
      disabled={busy || !canControl}
      failureDetail={start.machineChoiceError}
    />
  ) : undefined;
  const waiting = (start.machineAccess?.waitingWork?.length ?? 0) > 0;
  return (
    <>
      {start.reason || waiting ? (
        <SessionAdmissionNotice
          key={session.id}
          session={session}
          machineAccess={start.machineAccess}
          machineAction={picker}
          canControl={canControl}
          paused={session.effectiveControl.state === "paused"}
          busy={busy}
          onRecheck={start.recheck}
          onContinueWaitingWork={start.continueWaitingWork}
        />
      ) : null}
      {showPreSendWarning && start.warnBeforeSending ? (
        <SessionMachineAccessNotice access={start.machineAccess} action={picker} />
      ) : null}
    </>
  );
}
