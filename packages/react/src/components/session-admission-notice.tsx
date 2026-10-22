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
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = personalMachineCopy(t, access, { queued });
  const request = copy.ownerRequest;
  return (
    <>
      <p>{copy.explanation}</p>
      <p className="mt-1">{copy.next}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {action}
        {request && copy.copyRequest ? (
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
            {copyState === "copied" ? t("sessionAdmission.requestCopied") : copy.copyRequest}
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
  if (start.reason) {
    return (
      <SessionAdmissionNotice
        key={session.id}
        session={session}
        machineAccess={start.machineAccess}
        machineAction={picker}
        canControl={canControl}
        paused={session.effectiveControl.state === "paused"}
        busy={busy}
        onRecheck={start.recheck}
      />
    );
  }
  if (!showPreSendWarning || !start.warnBeforeSending) return null;
  return <SessionMachineAccessNotice access={start.machineAccess} action={picker} />;
}
