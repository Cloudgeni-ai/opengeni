import type { ChatClient } from "@opengeni/sdk";
import type { MachineView, ChatSession as Session, SessionMachineAccess } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useOpenGeniText } from "../messages/runtime";
import {
  allowMachineForChat,
  currentSessionMachineAccess,
  type AllowMachineClient,
  recheckSessionAdmission,
  runSavedMessageOnMachine,
  savedMessageApprovedMachines,
  savedMessageMachineChoices,
  sessionAdmissionApprovedElsewhere,
  sessionAdmissionNeedsDifferentMachine,
  sessionAdmissionNeedsMachineAccess,
  sessionAdmissionReason,
  sessionWaitingWorkExplainsBlock,
  type ApprovedMachineChoice,
  type SessionAdmissionReason,
} from "../session-admission-model";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { useMachines, type MachinesClientLike } from "./use-machines";

/** How often a refused message re-reads its machines while it waits. */
const BLOCKED_MACHINE_POLL_MS = 15_000;

export type UseSessionStartOptions = EmbeddedSessionClientOverride<ChatClient> & {
  session: Session;
  /** Re-read the session (and its queue) after a machine change or a recheck. */
  onSessionChanged: () => Promise<void>;
  /**
   * Reads the session's machines and moves the chat (`listMachines`,
   * `swapActiveSandbox`). Defaults to the session client when it has them; a
   * host proxy without them still gets the explanation, without choices.
   */
  machinesClient?: MachinesClientLike | undefined;
  /**
   * Whether this viewer may read the workspace machines (`GET /machines`,
   * permission `enrollments:read`). Defaults to true. Pass false for a viewer
   * without it: nothing is requested and the notice offers no machine choice.
   */
  machinesEnabled?: boolean | undefined;
};

export type UseSessionStartResult = {
  /** The refused message's admission block, or null when nothing is blocked. */
  reason: SessionAdmissionReason | null;
  /** The session's personal-machine projection for its current machine. */
  machineAccess: SessionMachineAccess | null;
  /** The saved message was refused because only the machine's owner may start work there. */
  needsDifferentMachine: boolean;
  /**
   * The person's own saved message was approved for another machine, not the
   * one the chat runs on now; a recheck can't start it here.
   */
  approvedElsewhere: boolean;
  /** The machines it was approved for, the ones the chat can move to now first. */
  approvedMachines: ApprovedMachineChoice[];
  /**
   * Move the chat to a machine the saved message was approved for; the
   * server starts it there by itself. Resolves to an error to show, or null.
   * Absent when moving isn't possible here.
   */
  runOnApprovedMachine: ((sandboxId: string) => Promise<string | null>) | undefined;
  /** The person's machines, as last read. */
  machines: readonly MachineView[];
  /** Move the chat without sending anything. Absent when moving isn't possible here. */
  moveToMachine: ((sandboxId: string) => Promise<boolean>) | undefined;
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
  /**
   * "Try again" for a failure nothing else lifts: one fenced Resume, then
   * fresh reads. Throws when it could not be confirmed. Blocks the server
   * lifts by itself (access allowed or restored, the chat moved) never need it.
   */
  recheck: () => Promise<void>;
  /** Re-read the session and its machines. */
  refresh: () => Promise<void>;
  /** The saved message waits for approval to use the chat's personal machine. */
  needsMachineAccess: boolean;
  /**
   * As the machine's owner, allow it for this chat; the server then starts
   * the saved message by itself. Absent unless the viewer owns the machine
   * and the client can issue the approval. Throws when it could not be confirmed.
   */
  allowMachine: (() => Promise<void>) | undefined;
  /**
   * As the machine's owner, let the agent continue with other people's
   * waiting updates, then recheck a blocked chat (or just re-read). Absent
   * when the session client cannot. Throws when it could not be confirmed.
   */
  continueWaitingWork: (() => Promise<void>) | undefined;
  /**
   * While the machine's owner is asked to allow it: other people in the
   * workspace can see this chat (workspace visibility, outside a Personal
   * workspace). False otherwise, and while the workspace kind is unknown.
   */
  sharedChat: boolean;
};

/**
 * Renderer-neutral state for explaining why a message can't start and the
 * allowed ways forward. Reads machines only while the chat is on a machine,
 * polls only while a refused message waits. The server starts the saved
 * message by itself, exactly once, as soon as what blocked it is fixed; only
 * an unknown failure offers a Try again fenced on the session's control ETag.
 * Access control stays on the server.
 */
export function useSessionStart({
  session,
  onSessionChanged,
  machinesClient,
  machinesEnabled = true,
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
    enabled: machinesEnabled && machines !== undefined && session.activeSandboxId != null,
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
  const refresh = useCallback(async () => {
    await Promise.all([onSessionChanged(), refreshMachines()]);
  }, [onSessionChanged, refreshMachines]);
  const needsMachineAccess = sessionAdmissionNeedsMachineAccess(reason, machineAccess);
  // Whether allowing the owner's machine also shows the workspace what runs
  // on it: only a workspace-visible chat outside a Personal workspace. The
  // workspace kind is read only when the owner is asked to allow it.
  const visibleToWorkspace = session.tenancy?.visibility === "workspace";
  const askOwner = needsMachineAccess && machineAccess?.isOwner === true;
  const [workspaceKind, setWorkspaceKind] = useState<{ id: string; kind: string } | null>(null);
  const workspaceClient = client as Partial<{
    getWorkspace: (workspaceId: string) => Promise<{ kind?: string | null }>;
  }>;
  const canReadWorkspace = typeof workspaceClient.getWorkspace === "function";
  const knownKind = workspaceKind?.id === workspaceId ? workspaceKind.kind : null;
  useEffect(() => {
    if (!visibleToWorkspace || !askOwner || !canReadWorkspace || knownKind !== null) return;
    let cancelled = false;
    workspaceClient.getWorkspace!(workspaceId).then(
      (workspace) => {
        if (!cancelled && typeof workspace?.kind === "string")
          setWorkspaceKind({ id: workspaceId, kind: workspace.kind });
      },
      () => {
        // Unknown kind: say nothing about sharing rather than risk a wrong claim.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [askOwner, canReadWorkspace, knownKind, visibleToWorkspace, workspaceClient, workspaceId]);
  const sharedChat =
    askOwner && visibleToWorkspace && knownKind !== null && knownKind !== "personal";
  const allowClient = client as unknown as Partial<AllowMachineClient>;
  const ownMachine =
    needsMachineAccess && machineAccess?.isOwner
      ? fleet.machines.find((machine) => machine.sandboxId === machineAccess.sandboxId)
      : undefined;
  const enrollmentId = ownMachine?.enrollmentId ?? null;
  const canAllow =
    enrollmentId !== null &&
    typeof allowClient.listUserResourceAuthorities === "function" &&
    typeof allowClient.issueUserResourceGrant === "function";
  const allowMachine = useCallback(async () => {
    if (!enrollmentId) return;
    const allowed = await allowMachineForChat({
      client: allowClient as AllowMachineClient,
      workspaceId,
      session,
      enrollmentId,
    });
    await refresh();
    if (!allowed) throw new Error("This machine could not be allowed for this chat");
  }, [allowClient, enrollmentId, refresh, session, workspaceId]);
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
  const approvedMachines = useMemo(
    () => savedMessageApprovedMachines(machineAccess, fleet.machines),
    [machineAccess, fleet.machines],
  );
  const runOnApprovedMachine = useCallback(
    (sandboxId: string) =>
      runSavedMessageOnMachine({
        sandboxId,
        attach,
        refresh,
        failedMove: t("sessionAdmission.machineChangeFailed"),
      }),
    [attach, refresh, t],
  );
  return {
    reason,
    machineAccess,
    needsDifferentMachine: sessionAdmissionNeedsDifferentMachine(reason, machineAccess),
    approvedElsewhere: sessionAdmissionApprovedElsewhere(reason, machineAccess),
    approvedMachines,
    runOnApprovedMachine: fleet.canAttach ? runOnApprovedMachine : undefined,
    machines: fleet.machines,
    moveToMachine: fleet.canAttach ? attach : undefined,
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
    refresh,
    needsMachineAccess,
    allowMachine: canAllow ? allowMachine : undefined,
    continueWaitingWork: canContinue ? continueWaitingWork : undefined,
    sharedChat,
  };
}
