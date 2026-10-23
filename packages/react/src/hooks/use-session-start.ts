import type { MachineView, Session, SessionMachineAccess } from "@opengeni/sdk";
import { useCallback, useMemo } from "react";
import { useOpenGeniText } from "../messages/runtime";
import {
  currentSessionMachineAccess,
  recheckSessionAdmission,
  savedMessageMachineChoices,
  sessionAdmissionNeedsDifferentMachine,
  sessionAdmissionReason,
  sessionWaitingWorkExplainsBlock,
  type SessionAdmissionReason,
} from "../session-admission-model";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { useMachines, type MachinesClientLike } from "./use-machines";

/** How often a refused message re-reads its machines while it waits. */
const BLOCKED_MACHINE_POLL_MS = 15_000;

export type UseSessionStartOptions = EmbeddedSessionClientOverride & {
  session: Session;
  /** Re-read the session (and its queue) after a machine change or a recheck. */
  onSessionChanged: () => Promise<void>;
  /**
   * Reads the session's machines and moves the chat (`listMachines`,
   * `swapActiveSandbox`). Defaults to the session client when it has them; a
   * host proxy without them still gets the explanation, without choices.
   */
  machinesClient?: MachinesClientLike | undefined;
};

export type UseSessionStartResult = {
  /** The refused message's admission block, or null when nothing is blocked. */
  reason: SessionAdmissionReason | null;
  /** The session's personal-machine projection for its current machine. */
  machineAccess: SessionMachineAccess | null;
  /** The saved message was refused because only the machine's owner may start work there. */
  needsDifferentMachine: boolean;
  /** The chat runs on somebody else's personal machine, so a new message could not start. */
  warnBeforeSending: boolean;
  /** Machines the person may move the chat to (never another personal machine). */
  machineChoices: MachineView[];
  /** Moving is possible from this client. */
  canChooseMachine: boolean;
  /** Move the chat. Resolves to an error to show, or null once it moved. Never resends. */
  chooseMachine: (machine: MachineView) => Promise<string | null>;
  /** A specific reason for the last refused move (for example, the machine went offline). */
  machineChoiceError: string | null;
  /** One fenced Resume, then fresh reads. Throws when it could not be confirmed. */
  recheck: () => Promise<void>;
  /**
   * As the machine's owner, let the agent continue with other people's
   * waiting updates, then recheck a blocked chat (or just re-read). Absent
   * when the session client cannot. Throws when it could not be confirmed.
   */
  continueWaitingWork: (() => Promise<void>) | undefined;
};

/**
 * Renderer-neutral state for explaining why a message can't start and the
 * allowed ways forward. Reads machines only while the chat is on a machine,
 * polls only while a refused message waits, and rechecks with one Resume
 * fenced on the session's control ETag, so the saved message is never sent
 * twice. Access control stays on the server.
 */
export function useSessionStart({
  session,
  onSessionChanged,
  machinesClient,
  ...override
}: UseSessionStartOptions): UseSessionStartResult {
  const t = useOpenGeniText();
  const { client, workspaceId } = useEmbeddedSession(override);
  const reason = sessionAdmissionReason(session);
  const machines =
    machinesClient ??
    (typeof (client as Partial<MachinesClientLike>).listMachines === "function"
      ? (client as unknown as MachinesClientLike)
      : undefined);
  const fleet = useMachines({
    client: client as never,
    workspaceId,
    ...(machines ? { machinesClient: machines } : {}),
    sessionId: session.id,
    enabled: machines !== undefined && session.activeSandboxId != null,
    pollIntervalMs: reason ? BLOCKED_MACHINE_POLL_MS : undefined,
  });
  const machineAccess = currentSessionMachineAccess(
    fleet.sessionMachineAccess,
    session.activeSandboxId,
  );
  const attach = fleet.attach;
  const refreshMachines = fleet.refresh;
  const chooseMachine = useCallback(
    async (machine: MachineView): Promise<string | null> => {
      if (!(await attach(machine.sandboxId))) return t("sessionAdmission.machineChangeFailed");
      await onSessionChanged();
      return null;
    },
    [attach, onSessionChanged, t],
  );
  const control = session.effectiveControl;
  const sessionId = session.id;
  const recheck = useCallback(
    () =>
      recheckSessionAdmission({
        control,
        refreshOnly: false,
        resume: (fence) =>
          client.resumeSession(workspaceId, sessionId, {
            clientEventId: globalThis.crypto.randomUUID(),
            expectedControlEtag: fence.controlEtag,
          }),
        refresh: [onSessionChanged, refreshMachines],
      }),
    [client, control, onSessionChanged, refreshMachines, sessionId, workspaceId],
  );
  const continueClient = client as Partial<{
    continueSessionWaitingWork: (workspaceId: string, sessionId: string) => Promise<unknown>;
  }>;
  const canContinue = typeof continueClient.continueSessionWaitingWork === "function";
  const blocked = reason !== null;
  const continueWaitingWork = useCallback(async () => {
    await continueClient.continueSessionWaitingWork!(workspaceId, sessionId);
    // Session first, then machines: the notice clears once nothing waits, and
    // a still-blocked session read in between would flash the refusal.
    if (blocked && control.state !== "paused")
      await recheckSessionAdmission({
        control,
        refreshOnly: false,
        resume: (fence) =>
          client.resumeSession(workspaceId, sessionId, {
            clientEventId: globalThis.crypto.randomUUID(),
            expectedControlEtag: fence.controlEtag,
          }),
        refresh: [onSessionChanged],
      });
    else await onSessionChanged();
    await refreshMachines();
  }, [
    blocked,
    client,
    continueClient,
    control,
    onSessionChanged,
    refreshMachines,
    sessionId,
    workspaceId,
  ]);
  const machineChoices = useMemo(
    () => savedMessageMachineChoices(fleet.machines),
    [fleet.machines],
  );
  return {
    reason,
    machineAccess,
    needsDifferentMachine: sessionAdmissionNeedsDifferentMachine(reason, machineAccess),
    // Others' waiting updates keep the composer's machine notice beside them:
    // it is where they choose a machine or ask the owner.
    warnBeforeSending:
      machineAccess !== null &&
      !machineAccess.isOwner &&
      (reason === null ||
        ((machineAccess.waitingWork?.length ?? 0) > 0 &&
          !sessionAdmissionNeedsDifferentMachine(reason, machineAccess) &&
          sessionWaitingWorkExplainsBlock(reason))),
    machineChoices,
    canChooseMachine: fleet.canAttach,
    chooseMachine,
    machineChoiceError: fleet.mutationError?.message ?? null,
    recheck,
    continueWaitingWork: canContinue ? continueWaitingWork : undefined,
  };
}
