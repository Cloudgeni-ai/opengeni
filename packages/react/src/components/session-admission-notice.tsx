import type { MachineView, ChatSession as Session, SessionMachineAccess } from "@opengeni/sdk";
import { InfoIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useSessionStart, type UseSessionStartOptions } from "../hooks/use-session-start";
import { useOpenGeniText } from "../messages/runtime";
import { machineDisplayName } from "../sandbox-label-model";
import {
  personalMachineCopy,
  runSavedMessageOnMachine,
  savedMessageApprovedMachines,
  sessionAdmissionApprovedElsewhere,
  sessionAdmissionApprovedElsewhereCopy,
  sessionAdmissionCopy,
  sessionAdmissionMachineAccessCopy,
  sessionAdmissionMachineChangedCopy,
  sessionAdmissionNeedsDifferentMachine,
  sessionAdmissionNeedsMachineAccess,
  sessionAdmissionReason,
  sessionWaitingWorkExplainsBlock,
  waitingMessagesCopy,
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
 * Messages other people sent wait because this chat runs on somebody's
 * personal machine, where only its owner can start work. One calm notice for
 * all of them: whose messages wait, and what brings them to the agent. They
 * never block the chat, so it offers no action. Renders nothing when none wait.
 */
export function SessionWaitingMessagesNotice({ access }: { access: SessionMachineAccess }) {
  const t = useOpenGeniText();
  const copy = waitingMessagesCopy(t, access);
  if (!copy) return null;
  return (
    <Notice tone="waiting" title={copy.title}>
      <div role="status" aria-live="polite">
        <p>{copy.explanation}</p>
        <p className="mt-1">{copy.next}</p>
      </div>
    </Notice>
  );
}

/**
 * The personal machine a chat runs on, before sending. On somebody else's
 * machine a new message from this person could not start there, so it says
 * why and offers the ways forward. Its owner, in a chat shared with the
 * workspace, gets a one-line heads-up that people here see what the agent
 * does on it, with `action` as the way to move elsewhere. Renders nothing in
 * the owner's private chats or when the chat is not on a personal machine.
 */
export function SessionMachineAccessNotice({
  access,
  action,
  shared = false,
  className,
}: {
  access: SessionMachineAccess | null | undefined;
  action?: ReactNode | undefined;
  /** The chat is shared with the workspace rather than Only me. */
  shared?: boolean | undefined;
  /** Spacing for the owner's one-line heads-up where it sits. */
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  if (!access) return null;
  if (access.isOwner) {
    if (!shared) return null;
    return (
      <div
        data-testid="own-machine-shared-heads-up"
        className={`flex min-w-0 items-start gap-1.5 text-xs text-fg-muted ${className ?? ""}`}
      >
        <InfoIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0">
          {t("sessionAdmission.ownMachineSharedHeadsUp", { machine: access.machineName })}
          {action ? <> {action}</> : null}
        </span>
      </div>
    );
  }
  return (
    <Notice tone="waiting" title={t("sessionAdmission.preSendTitle")} live="polite">
      <PersonalMachineExplanation access={access} action={action} />
    </Notice>
  );
}

export type SessionAdmissionNoticeProps = {
  session: Session;
  /** The person may pause, resume and retry this session. */
  canControl: boolean;
  /** The session is paused; the saved message starts when it is resumed. */
  paused: boolean;
  /** Another control action is in flight. */
  busy: boolean;
  /** Control changed underneath the notice: re-read before trying again. */
  refreshRequired?: boolean | undefined;
  /**
   * "Try again" for a failure nothing else lifts: one fenced Resume followed
   * by a fresh read (see `recheckSessionAdmission`). Blocks the server lifts
   * by itself once access changes never call it.
   */
  onRecheck: () => Promise<void>;
  /**
   * As the machine's owner, allow the chat's machine for this chat (see
   * `allowMachineForChat`), then re-read. The server starts the saved message
   * by itself. Omit where the host can't, or the viewer isn't the owner.
   */
  onAllowMachine?: (() => Promise<void>) | undefined;
  /** The session's current personal-machine projection, when known. */
  machineAccess?: SessionMachineAccess | null | undefined;
  /** The machine picker offered when the saved message needs a different machine. */
  machineAction?: ReactNode | undefined;
  /**
   * The person's machines, to find the one a saved message was approved for
   * (`machineAccess.queuedTurnApprovedMachines`). Omit where they aren't read.
   */
  machines?: readonly MachineView[] | undefined;
  /**
   * Move the chat to a machine (by sandbox id) without sending anything.
   * Offered as "Run it on …" when the saved message was approved for that
   * machine; the server starts the message once the move is confirmed.
   */
  onMoveToMachine?: ((sandboxId: string) => Promise<boolean>) | undefined;
  /** Re-read the chat after a move. */
  onRefresh?: (() => Promise<void>) | undefined;
  /**
   * As the machine's owner, let the agent continue with other people's
   * waiting updates (`machineAccess.waitingWork`): continue, then resume a
   * blocked chat and refresh. Omit where the host cannot.
   */
  onContinueWaitingWork?: (() => Promise<void>) | undefined;
  /**
   * Other people in the workspace can see this chat (workspace visibility,
   * outside a Personal workspace). The owner then learns that allowing their
   * machine lets them see what the agent does on it. Defaults to false.
   */
  sharedChat?: boolean | undefined;
};

/**
 * The runtime refused to start the session's next message (an admission
 * block). Says what is blocking it in the person's language, keeps the saved
 * message, and offers the one action that fixes it where there is one. The
 * server starts the saved message by itself, once, as soon as the cause is
 * fixed (access allowed or restored, the chat moved), so there is nothing to
 * recheck. Renders nothing when the session is not blocked.
 */
export function SessionAdmissionNotice({
  session,
  canControl,
  paused,
  busy,
  refreshRequired = false,
  onRecheck,
  onAllowMachine,
  machineAccess,
  machineAction,
  machines,
  onMoveToMachine,
  onRefresh,
  onContinueWaitingWork,
  sharedChat = false,
}: SessionAdmissionNoticeProps) {
  const t = useOpenGeniText();
  const descriptionId = useId();
  const pending = useRef(false);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [blockedMachine, setBlockedMachine] = useState<{
    sandboxId: string;
    blockedAt: string | undefined;
  } | null>(null);
  const reason = sessionAdmissionReason(session);
  const machineBlocked = sessionAdmissionNeedsDifferentMachine(reason, machineAccess);
  const approvedElsewhere = sessionAdmissionApprovedElsewhere(reason, machineAccess);
  const needsMachineAccess = sessionAdmissionNeedsMachineAccess(reason, machineAccess);
  const blockedAt = session.admissionBlock?.blockedAt;
  const machineSandboxId = machineAccess?.sandboxId;
  // Remember the machine the message couldn't run on, so after the chat moves
  // the notice says it is starting on the new machine.
  const blockedHere = machineBlocked || approvedElsewhere || needsMachineAccess;
  const activeSandboxId = session.activeSandboxId;
  useEffect(() => {
    if (blockedHere && machineSandboxId && machineSandboxId === activeSandboxId) {
      // The same block keeps the machine it was refused on; a new block (the
      // claim ran again) records where it was refused this time.
      setBlockedMachine((previous) =>
        previous && previous.blockedAt === blockedAt
          ? previous
          : { sandboxId: machineSandboxId, blockedAt },
      );
    }
  }, [blockedHere, machineSandboxId, activeSandboxId, blockedAt]);
  // Other people's messages waiting for the machine's owner never block the
  // chat; they are explained beside whatever else the chat shows.
  const waitingMessages = machineAccess?.waitingMessages?.length ? (
    <SessionWaitingMessagesNotice access={machineAccess} />
  ) : null;
  // Other people's updates waiting on a personal machine: one calm notice
  // that says whose and why, instead of a generic permission failure.
  if (
    machineAccess?.waitingWork?.length &&
    !machineBlocked &&
    sessionWaitingWorkExplainsBlock(reason)
  ) {
    return (
      <>
        <SessionWaitingWorkNotice
          access={machineAccess}
          busy={busy || (paused && reason !== null)}
          onContinue={canControl ? onContinueWaitingWork : undefined}
        />
        {waitingMessages}
      </>
    );
  }
  if (!reason) return waitingMessages;
  const machineChanged =
    ((reason.reason === "database_claim_rejected" && reason.permissionDenied) ||
      reason.reason === "personal_resource_grant_required") &&
    blockedMachine !== null &&
    blockedMachine.blockedAt === blockedAt &&
    blockedMachine.sandboxId !== session.activeSandboxId;
  const copy = machineChanged
    ? sessionAdmissionMachineChangedCopy(t)
    : needsMachineAccess && machineAccess
      ? sessionAdmissionMachineAccessCopy(t, machineAccess, {
          canAllowHere: onAllowMachine !== undefined,
          paused,
          shared: sharedChat,
        })
      : sessionAdmissionCopy(t, reason);
  const allowing = !machineChanged && needsMachineAccess && machineAccess?.isOwner === true;
  // The one action: the owner allows the machine, or, for a failure nothing
  // else lifts, Try again. Everything else starts by itself once fixed.
  const action = machineChanged
    ? null
    : allowing
      ? onAllowMachine
        ? copy.action
        : null
      : copy.action !== null && canControl && (refreshRequired || !paused)
        ? refreshRequired
          ? t("sessionAdmission.refreshSessionStatus")
          : copy.action
        : null;

  // Allowing is the owner's own grant, not a session control: it needs no
  // control permission. Retrying and moving the chat do.
  async function run(work: () => Promise<void>, failed: string, needsControl = true) {
    if (pending.current || busy || (needsControl && !canControl)) return;
    pending.current = true;
    setChecking(true);
    setFailure(null);
    try {
      await work();
    } catch {
      setFailure(failed);
    } finally {
      pending.current = false;
      setChecking(false);
    }
  }

  function act() {
    if (allowing && onAllowMachine) {
      void run(onAllowMachine, t("sessionAdmission.allowFailed"), false);
    } else if (!paused || refreshRequired) {
      void run(
        onRecheck,
        refreshRequired ? t("sessionAdmission.refreshFailed") : t("sessionAdmission.retryFailed"),
      );
    }
  }

  // Move back to the machine the saved message was approved for. The server
  // starts it there by itself; this only re-reads after the move.
  async function runOnMachine(sandboxId: string) {
    if (!onMoveToMachine || paused) return;
    await run(async () => {
      const moveFailure = await runSavedMessageOnMachine({
        sandboxId,
        attach: onMoveToMachine,
        refresh: onRefresh,
        failedMove: t("sessionAdmission.machineChangeFailed"),
      });
      if (moveFailure) setFailure(moveFailure);
    }, t("sessionAdmission.machineChangeFailed"));
  }

  if (approvedElsewhere && machineAccess) {
    return (
      <>
        <ApprovedElsewhereNotice
          access={machineAccess}
          machines={machines ?? []}
          canControl={canControl}
          canMove={onMoveToMachine !== undefined}
          paused={paused}
          busy={busy}
          running={checking}
          failure={failure}
          machineAction={machineAction}
          onRun={(sandboxId) => void runOnMachine(sandboxId)}
        />
        {waitingMessages}
      </>
    );
  }

  return (
    <>
      <Notice
        tone={copy.action === null || allowing || machineChanged ? "waiting" : "failed"}
        title={machineBlocked ? t("sessionAdmission.needsDifferentMachineTitle") : copy.title}
      >
        <div id={descriptionId} role="status" aria-live="polite">
          {machineBlocked && machineAccess ? (
            <PersonalMachineExplanation access={machineAccess} queued action={machineAction} />
          ) : (
            <>
              <p>{copy.body}</p>
              {copy.next ? <p className="mt-1">{copy.next}</p> : null}
            </>
          )}
        </div>
        {/* The owner's own words already say it starts once resumed. */}
        {paused && !allowing ? <p className="mt-2">{t("sessionAdmission.pausedNote")}</p> : null}
        {action !== null && !machineBlocked ? (
          <Button
            type="button"
            className="mt-2 min-h-11"
            disabled={busy || checking}
            aria-busy={checking}
            aria-describedby={descriptionId}
            onClick={act}
          >
            {checking
              ? allowing
                ? t("sessionAdmission.allowing")
                : refreshRequired
                  ? t("sessionAdmission.refreshing")
                  : t("sessionAdmission.starting")
              : action}
          </Button>
        ) : copy.action !== null && !allowing && !machineChanged && !canControl && !paused ? (
          <p className="mt-2">{t("sessionAdmission.cantRetryNote")}</p>
        ) : null}
        {failure ? (
          <p role="alert" className="mt-2">
            {failure}
          </p>
        ) : null}
      </Notice>
      {waitingMessages}
    </>
  );
}

/**
 * The person's own saved message was approved for another of their machines,
 * so it can't start where the chat runs now and no recheck would help. Names
 * both machines and offers the one action that starts it: move the chat back
 * and recheck. Sending it again here goes through the queue, which already
 * offers removing it.
 */
function ApprovedElsewhereNotice({
  access,
  machines,
  canControl,
  canMove,
  paused,
  busy,
  running,
  failure,
  machineAction,
  onRun,
}: {
  access: SessionMachineAccess;
  machines: readonly MachineView[];
  canControl: boolean;
  canMove: boolean;
  paused: boolean;
  busy: boolean;
  running: boolean;
  failure: string | null;
  machineAction?: ReactNode | undefined;
  onRun: (sandboxId: string) => void;
}) {
  const t = useOpenGeniText();
  const descriptionId = useId();
  const target = savedMessageApprovedMachines(access, machines)[0] ?? null;
  const copy = sessionAdmissionApprovedElsewhereCopy(t, access, target);
  return (
    <Notice tone="waiting" title={copy.title}>
      <div id={descriptionId} role="status" aria-live="polite">
        <p>{copy.body}</p>
        <p className="mt-1">{copy.next}</p>
      </div>
      {paused ? (
        <p className="mt-2">{t("sessionAdmission.pausedNote")}</p>
      ) : copy.action !== null && target !== null && canMove && canControl ? (
        <Button
          type="button"
          className="mt-2 min-h-11 max-w-full whitespace-normal"
          disabled={busy || running}
          aria-busy={running}
          aria-describedby={descriptionId}
          onClick={() => onRun(target.sandboxId)}
        >
          {running ? t("sessionAdmission.moving") : copy.action}
        </Button>
      ) : access.isOwner && !target && machineAction ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">{machineAction}</div>
      ) : null}
      {failure ? (
        <p role="alert" className="mt-2">
          {failure}
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
 * move the chat to. Moving never resends anything: the server starts the saved
 * message by itself once the chat is on a machine it may use.
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
 * use, moves the chat, and lets the owner allow their machine; the server then
 * starts the saved message by itself, exactly once. Access control is the server's; this
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
  const waiting =
    (start.machineAccess?.waitingWork?.length ?? 0) > 0 ||
    (start.machineAccess?.waitingMessages?.length ?? 0) > 0;
  return (
    <>
      {start.reason || waiting ? (
        <SessionAdmissionNotice
          key={session.id}
          session={session}
          machineAccess={start.machineAccess}
          machineAction={picker}
          machines={start.machines}
          onMoveToMachine={start.moveToMachine}
          canControl={canControl}
          paused={session.effectiveControl.state === "paused"}
          busy={busy}
          onRecheck={start.recheck}
          onAllowMachine={start.allowMachine}
          onRefresh={start.refresh}
          onContinueWaitingWork={start.continueWaitingWork}
          sharedChat={start.sharedChat}
        />
      ) : null}
      {showPreSendWarning && start.warnBeforeSending ? (
        <SessionMachineAccessNotice access={start.machineAccess} action={picker} />
      ) : null}
    </>
  );
}
