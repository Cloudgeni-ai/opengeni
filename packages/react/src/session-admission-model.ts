// Renderer-neutral model for "why didn't my message start?": an admission
// block on the session (the runtime refused to start the next queued turn) and
// the personal-machine explanation behind the most common one (a shared chat
// that runs on somebody else's personal machine). Web (`@opengeni/react/session-ui`)
// and React Native render the same words from the message catalog, so a host
// translates them once (`sessionAdmission.*`).
import type { MachineView, ChatSession as Session, SessionMachineAccess } from "@opengeni/sdk";
import type { OpenGeniText } from "./messages/runtime";

/** Whether a Connected Machine can take work right now. Offline, reconnecting
 *  and enrolling machines cannot; a machine without screen-control consent can
 *  still run compute. */
export function isMachineComputeSelectable(state: string): boolean {
  return state === "online" || state === "display_unavailable" || state === "consent_required";
}

/** A machine-list response is useful only while it names the session's current pointer. */
export function currentSessionMachineAccess(
  access: SessionMachineAccess | null | undefined,
  activeSandboxId: string | null | undefined,
): SessionMachineAccess | null {
  return access && access.sandboxId === activeSandboxId ? access : null;
}

export type SessionAdmissionReason = {
  /** The public reason; unknown future reasons arrive as their own string. */
  reason: string;
  /** The refusal was a permission check (SQLSTATE 42501). */
  permissionDenied: boolean;
};

/**
 * The admission block a person should see, or null. Older servers omit the
 * projection, and a stale block on a session that is no longer waiting is
 * ignored. Never exposes raw database diagnostics.
 */
export function sessionAdmissionReason(
  session: Pick<Session, "status"> & { admissionBlock?: unknown },
): SessionAdmissionReason | null {
  if (session.status !== "requires_action") return null;
  const block = session.admissionBlock;
  if (!block || typeof block !== "object") return null;
  return {
    reason: "reason" in block && typeof block.reason === "string" ? block.reason : "unknown",
    permissionDenied: "sqlState" in block && block.sqlState === "42501",
  };
}

/**
 * The block, if any, is the personal-machine refusal that waiting updates from
 * other people's work explain; another block keeps its own notice.
 */
export function sessionWaitingWorkExplainsBlock(reason: SessionAdmissionReason | null): boolean {
  return (
    reason === null || (reason.reason === "database_claim_rejected" && reason.permissionDenied)
  );
}

/** The saved message was refused because only the machine's owner may start work on it. */
export function sessionAdmissionNeedsDifferentMachine(
  reason: SessionAdmissionReason | null,
  access: SessionMachineAccess | null | undefined,
): boolean {
  return (
    reason?.reason === "database_claim_rejected" &&
    reason.permissionDenied &&
    access?.queuedTurnBlocked === true
  );
}

/**
 * Machines that can take the saved message. Accepted messages keep the
 * personal-resource permissions they were sent with, so a personal machine
 * chosen now could not run them: offer the session's own cloud machine and
 * workspace or organization machines that are reachable.
 */
export function savedMessageMachineChoices(machines: readonly MachineView[]): MachineView[] {
  return machines.filter(
    (machine) =>
      !machine.active &&
      (machine.isSessionGroup || machine.scope !== "user") &&
      isMachineComputeSelectable(machine.state),
  );
}

/**
 * The saved message is the machine owner's own and was approved for other
 * machines, not the one the chat runs on now (for example, the chat moved
 * after it was sent). No recheck can start it here: it runs once the chat is
 * back on a machine it was approved for, or after it is removed and sent again.
 */
export function sessionAdmissionApprovedElsewhere(
  reason: SessionAdmissionReason | null,
  access: SessionMachineAccess | null | undefined,
): boolean {
  return (
    reason?.reason === "personal_resource_grant_required" &&
    access?.queuedTurnNotApprovedHere === true
  );
}

export type ApprovedMachineChoice = {
  sandboxId: string;
  /** The machine's name as the server reported it for the saved message. */
  name: string;
  /** The same machine in the person's machine list, when it is there. */
  machine: MachineView | null;
  /** The chat can move there now. */
  available: boolean;
};

/**
 * The machines the saved message was approved for, matched to the person's
 * machine list, the ones the chat can move to now first. Only the message's
 * sender gets names from the server; everyone else gets an empty list.
 */
export function savedMessageApprovedMachines(
  access: SessionMachineAccess | null | undefined,
  machines: readonly MachineView[],
): ApprovedMachineChoice[] {
  const choices = (access?.queuedTurnApprovedMachines ?? [])
    .filter((approved) => approved.sandboxId !== access?.sandboxId)
    .map((approved) => {
      const machine = machines.find((candidate) => candidate.sandboxId === approved.sandboxId);
      return {
        sandboxId: approved.sandboxId,
        name: approved.machineName,
        machine: machine ?? null,
        available: machine !== undefined && isMachineComputeSelectable(machine.state),
      };
    });
  return [
    ...choices.filter((choice) => choice.available),
    ...choices.filter((choice) => !choice.available),
  ];
}

export type ApprovedElsewhereCopy = {
  title: string;
  body: string;
  /** What happens next; empty when the body already says it. */
  next: string;
  /** "Run it on …" for the machine the chat can move to now; null when there is none. */
  action: string | null;
};

/**
 * Words for a saved message that was approved for another machine. The
 * sender learns which machine and gets the one action that starts it there;
 * everyone else learns who can. Never offers a recheck: one can't pass here.
 */
export function sessionAdmissionApprovedElsewhereCopy(
  t: OpenGeniText,
  access: Pick<SessionMachineAccess, "machineName" | "ownerName" | "isOwner">,
  target: ApprovedMachineChoice | null,
): ApprovedElsewhereCopy {
  const machine = access.machineName;
  if (!access.isOwner) {
    const owner = access.ownerName?.trim() || t("sessionAdmission.theMachineOwner");
    return {
      title: t("sessionAdmission.othersApprovedElsewhereTitle"),
      body: t("sessionAdmission.othersApprovedElsewhereBody", { owner, machine }),
      next: t("sessionAdmission.othersApprovedElsewhereNext", { owner }),
      action: null,
    };
  }
  if (!target) {
    return {
      title: t("sessionAdmission.notApprovedHereTitle", { machine }),
      body: t("sessionAdmission.notApprovedHereBody", { machine }),
      next: t("sessionAdmission.notApprovedHereNext", { machine }),
      action: null,
    };
  }
  const approved = target.name;
  return {
    title: t("sessionAdmission.approvedElsewhereTitle", { approved }),
    body: t("sessionAdmission.approvedElsewhereBody", { approved, machine }),
    next: target.available
      ? t("sessionAdmission.approvedElsewhereNext", { approved, machine })
      : target.machine
        ? t("sessionAdmission.approvedElsewhereOfflineNext", { approved, machine })
        : t("sessionAdmission.approvedElsewhereUnavailableNext", { approved, machine }),
    action: target.available ? t("sessionAdmission.runOnApprovedMachine", { approved }) : null,
  };
}

/**
 * Start the saved message on a machine it was approved for: move the chat
 * there. The server starts the saved message by itself once the chat is on a
 * machine it may use, so nothing is resent here; `refresh` only re-reads.
 * Resolves to an error to show, or null once it moved.
 */
export async function runSavedMessageOnMachine({
  sandboxId,
  attach,
  refresh,
  recheck,
  failedMove,
}: {
  sandboxId: string;
  attach: (sandboxId: string) => Promise<boolean>;
  /** Re-read the chat after the move. */
  refresh?: (() => Promise<void>) | undefined;
  /** @deprecated The move starts the message by itself; pass `refresh`. */
  recheck?: (() => Promise<void>) | undefined;
  failedMove: string;
}): Promise<string | null> {
  if (!(await attach(sandboxId))) return failedMove;
  await (refresh ?? recheck)?.();
  return null;
}

export type SessionAdmissionCopy = {
  title: string;
  body: string;
  next: string;
  /**
   * The one action that fixes it here ("Try again", "Allow for this chat"),
   * or null when the message starts by itself once someone else fixes it.
   */
  action: string | null;
};

/**
 * Words for an admission block that is not (or not known to be) about a
 * personal machine. Every block the server can lift by itself (access granted
 * or restored, the chat moved) says so and offers no button; only an unknown
 * failure, which nothing signals, offers Try again.
 */
export function sessionAdmissionCopy(
  t: OpenGeniText,
  { reason, permissionDenied }: SessionAdmissionReason,
): SessionAdmissionCopy {
  switch (reason) {
    case "initiator_membership_required":
      return {
        title: t("sessionAdmission.membershipTitle"),
        body: t("sessionAdmission.membershipBody"),
        next: t("sessionAdmission.membershipNext"),
        action: null,
      };
    case "personal_resource_grant_required":
      return {
        title: t("sessionAdmission.grantTitle"),
        body: t("sessionAdmission.grantBody"),
        next: t("sessionAdmission.grantNext"),
        action: null,
      };
    case "database_claim_rejected":
      if (permissionDenied)
        return {
          title: t("sessionAdmission.permissionTitle"),
          body: t("sessionAdmission.permissionBody"),
          next: t("sessionAdmission.permissionNext"),
          action: null,
        };
      // Other database rejections do not establish a permission problem.
      break;
    default:
      break;
  }
  return {
    title: t("sessionAdmission.genericTitle"),
    body: t("sessionAdmission.genericBody"),
    next: t("sessionAdmission.genericNext"),
    action: t("sessionAdmission.tryAgain"),
  };
}

/**
 * The saved message is waiting for approval to use the personal machine the
 * chat runs on: its approval is missing, used up, revoked or expired. Older
 * servers report the same refusal as a bare permission check. Only the
 * machine's owner can allow it; messages from other people that can never
 * run there (`queuedTurnBlocked`) and ones approved for another machine keep
 * their own notices.
 */
export function sessionAdmissionNeedsMachineAccess(
  reason: SessionAdmissionReason | null,
  access: SessionMachineAccess | null | undefined,
): boolean {
  if (!reason || !access || access.queuedTurnBlocked || access.queuedTurnNotApprovedHere)
    return false;
  return (
    reason.reason === "personal_resource_grant_required" ||
    (reason.reason === "database_claim_rejected" && reason.permissionDenied)
  );
}

/**
 * Words for a saved message waiting for approval to use the chat's personal
 * machine. The owner gets "Allow for this chat", which starts it right away
 * (or when a paused chat is resumed); everyone else learns who can allow it
 * and that it then starts by itself.
 */
export function sessionAdmissionMachineAccessCopy(
  t: OpenGeniText,
  access: Pick<SessionMachineAccess, "machineName" | "ownerName" | "isOwner">,
  options: {
    canAllowHere?: boolean;
    /** Paused: allowing it starts nothing until the chat is resumed. */
    paused?: boolean;
    /**
     * Other people in the workspace can see the chat (workspace visibility,
     * outside a Personal workspace): allowing it shares what runs on the machine.
     */
    shared?: boolean;
  } = {},
): SessionAdmissionCopy {
  const machine = access.machineName;
  if (access.isOwner) {
    // Without the button here, the owner allows it from the machine's settings.
    const canAllowHere = options.canAllowHere ?? true;
    const next = canAllowHere
      ? options.paused
        ? t("sessionAdmission.machineAccessOwnerPausedNext")
        : t("sessionAdmission.machineAccessOwnerNext")
      : options.paused
        ? t("sessionAdmission.machineAccessOwnerSettingsPausedNext")
        : t("sessionAdmission.machineAccessOwnerSettingsNext");
    return {
      title: t("sessionAdmission.machineAccessTitle"),
      body: t("sessionAdmission.machineAccessBody", { machine }),
      next: options.shared
        ? `${next} ${t("sessionAdmission.machineAccessSharedNote", { machine })}`
        : next,
      action: canAllowHere ? t("sessionAdmission.allowForThisChat") : null,
    };
  }
  const owner = access.ownerName?.trim() || t("sessionAdmission.theMachineOwner");
  return {
    title: t("sessionAdmission.machineAccessTitle"),
    body: t("sessionAdmission.machineAccessOthersBody", { owner, machine }),
    next: t("sessionAdmission.machineAccessOthersNext", { owner }),
    action: null,
  };
}

/** After a refusal, the chat moved to another machine: the saved message starts there by itself. */
export function sessionAdmissionMachineChangedCopy(t: OpenGeniText): SessionAdmissionCopy {
  return {
    title: t("sessionAdmission.machineChangedTitle"),
    // One line: the message is already in the chat, so only where it starts.
    body: t("sessionAdmission.machineChangedNext"),
    next: "",
    action: null,
  };
}

/** The owner-only API calls "Allow for this chat" needs. */
export type AllowMachineClient = {
  listUserResourceAuthorities: (
    workspaceId: string,
    options: { resourceKind: "connected_machine"; cursor?: string; limit?: number },
  ) => Promise<{
    authorities: Array<{
      authorityId: string;
      resourceKind: string;
      resourceId: string;
      status: string;
    }>;
    nextCursor?: string | null | undefined;
  }>;
  issueUserResourceGrant: (
    workspaceId: string,
    authorityId: string,
    request: {
      scope: "user";
      resourceKind: "connected_machine";
      mode: "session";
      context: "user_private" | "workspace_shared";
      sessionId: string;
      expectedAuthorityEpoch: number;
      workspaceSharedAcknowledged: boolean;
    },
  ) => Promise<unknown>;
};

/**
 * As the machine's owner, allow it for this one chat. The server starts the
 * waiting message by itself once the approval is recorded, exactly once and
 * only while the chat is not paused, so nothing is resent here. Resolves to
 * false when the machine is not the caller's own (nothing was changed).
 */
export async function allowMachineForChat({
  client,
  workspaceId,
  session,
  enrollmentId,
}: {
  client: AllowMachineClient;
  workspaceId: string;
  session: Pick<Session, "id"> & {
    tenancy?: { visibility?: string; authorityEpoch: number } | null | undefined;
  };
  enrollmentId: string;
}): Promise<boolean> {
  const epoch = session.tenancy?.authorityEpoch;
  if (epoch === undefined) return false;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const listed = await client.listUserResourceAuthorities(workspaceId, {
      resourceKind: "connected_machine",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const authority = listed.authorities.find(
      (candidate) =>
        candidate.resourceKind === "connected_machine" &&
        candidate.resourceId === enrollmentId &&
        candidate.status === "active",
    );
    if (authority) {
      const shared = session.tenancy?.visibility === "workspace";
      await client.issueUserResourceGrant(workspaceId, authority.authorityId, {
        scope: "user",
        resourceKind: "connected_machine",
        mode: "session",
        context: shared ? "workspace_shared" : "user_private",
        sessionId: session.id,
        expectedAuthorityEpoch: epoch,
        workspaceSharedAcknowledged: shared,
      });
      return true;
    }
    if (!listed.nextCursor) return false;
    cursor = listed.nextCursor;
  }
  return false;
}

export type PersonalMachineCopy = {
  /** Whose machine this chat runs on, and who may start work there. */
  explanation: string;
  /** What happens to the person's words, and the ways forward. */
  next: string;
  /** A message the person can send the owner themselves; null for the owner. */
  ownerRequest: string | null;
  /** "Copy request to …" button label; null for the owner. */
  copyRequest: string | null;
  /** Before sending, for others: their agents' updates wait here too. */
  workNote: string | null;
};

/**
 * Explain a chat that runs on a personal machine. `queued` is a saved message
 * the runtime refused; otherwise it is a draft the person has not sent yet.
 */
export function personalMachineCopy(
  t: OpenGeniText,
  access: Pick<SessionMachineAccess, "machineName" | "ownerName" | "isOwner">,
  { queued }: { queued: boolean },
): PersonalMachineCopy {
  const machine = access.machineName;
  if (access.isOwner) {
    return {
      explanation: t("sessionAdmission.ownMachineExplanation", { machine }),
      next: queued
        ? t("sessionAdmission.ownMachineQueuedNext")
        : t("sessionAdmission.ownMachineDraftNext"),
      ownerRequest: null,
      copyRequest: null,
      workNote: null,
    };
  }
  const owner = access.ownerName?.trim() || t("sessionAdmission.theMachineOwner");
  return {
    explanation: t("sessionAdmission.otherMachineExplanation", { owner, machine }),
    next: queued
      ? t("sessionAdmission.otherMachineQueuedNext", { owner })
      : t("sessionAdmission.otherMachineDraftNext", { owner }),
    ownerRequest: t("sessionAdmission.ownerRequest", { machine }),
    copyRequest: t("sessionAdmission.copyRequestTo", { owner }),
    workNote: queued ? null : t("sessionAdmission.otherMachineWorkNote", { owner }),
  };
}

export type WaitingWorkCopy = {
  title: string;
  /** Whose machine this is, and why the updates wait. */
  explanation: string;
  /** Who can do what about it. */
  next: string;
  /** The owner's "continue" button label; null for everyone else. */
  continueAction: string | null;
};

/** "Sam", "Sam and Kim", "Sam, Kim and Ana" in the host's language. */
function peopleList(t: OpenGeniText, names: readonly (string | null)[]): string {
  const unique = [...new Set(names.map((name) => name?.trim() || t("sessionAdmission.aMember")))];
  try {
    return new Intl.ListFormat(t.locale, { type: "conjunction" }).format(unique);
  } catch {
    return unique.join(", ");
  }
}

/**
 * Explain updates from other people's work (their agents' messages and their
 * workers' results) that wait because the chat runs on somebody's personal
 * machine, or null when nothing waits. The owner gets the way to continue;
 * everyone else learns who can and why.
 */
export function waitingWorkCopy(
  t: OpenGeniText,
  access: Pick<SessionMachineAccess, "machineName" | "ownerName" | "isOwner" | "waitingWork">,
): WaitingWorkCopy | null {
  const waiting = access.waitingWork ?? [];
  if (waiting.length === 0) return null;
  const machine = access.machineName;
  const total = waiting.reduce((sum, entry) => sum + entry.results, 0);
  if (access.isOwner) {
    const people = peopleList(
      t,
      waiting.map((entry) => entry.name),
    );
    return {
      title: t("sessionAdmission.waitingForYouTitle", { count: total, people }),
      explanation: t("sessionAdmission.waitingForYouExplanation", { machine }),
      next: t("sessionAdmission.waitingForYouNext"),
      continueAction: t("sessionAdmission.continueWaitingWork", { count: total }),
    };
  }
  const owner = access.ownerName?.trim() || t("sessionAdmission.theMachineOwner");
  const yours = waiting.find((entry) => entry.isYou);
  const others = waiting.filter((entry) => !entry.isYou);
  const title = yours
    ? t("sessionAdmission.yourUpdatesWaitingTitle", { count: yours.results, owner })
    : t("sessionAdmission.othersUpdatesWaitingTitle", {
        count: total,
        owner,
        people: peopleList(
          t,
          others.map((entry) => entry.name),
        ),
      });
  return {
    title,
    explanation: t("sessionAdmission.updatesWaitingExplanation", { owner, machine }),
    next: yours
      ? t("sessionAdmission.yourUpdatesWaitingNext", { owner })
      : t("sessionAdmission.othersUpdatesWaitingNext", { owner }),
    // Others act from the composer's notice: choose a machine, or ask the owner.
    continueAction: null,
  };
}

export type WaitingMessagesCopy = {
  title: string;
  /** Whose machine this is, and why the messages wait. */
  explanation: string;
  /** What happens to them, and who can do what. */
  next: string;
};

/**
 * Explain messages other people sent that wait because the chat runs on
 * somebody's personal machine, or null when none wait. They never run there
 * on their own: the owner's next message brings them to the agent, and moving
 * the chat to a machine the sender may use runs them.
 */
export function waitingMessagesCopy(
  t: OpenGeniText,
  access: Pick<SessionMachineAccess, "machineName" | "ownerName" | "isOwner" | "waitingMessages">,
): WaitingMessagesCopy | null {
  const waiting = access.waitingMessages ?? [];
  if (waiting.length === 0) return null;
  const machine = access.machineName;
  const total = waiting.reduce((sum, entry) => sum + entry.messages, 0);
  if (access.isOwner) {
    return {
      title: t("sessionAdmission.messagesWaitingForYouTitle", {
        count: total,
        people: peopleList(
          t,
          waiting.map((entry) => entry.name),
        ),
      }),
      explanation: t("sessionAdmission.messagesWaitingForYouExplanation", { machine }),
      next: t("sessionAdmission.messagesWaitingForYouNext", { count: total }),
    };
  }
  const owner = access.ownerName?.trim() || t("sessionAdmission.theMachineOwner");
  const yours = waiting.find((entry) => entry.isYou);
  const others = waiting.filter((entry) => !entry.isYou);
  return {
    title: yours
      ? t("sessionAdmission.yourMessagesWaitingTitle", { count: yours.messages, owner })
      : t("sessionAdmission.othersMessagesWaitingTitle", {
          count: total,
          owner,
          people: peopleList(
            t,
            others.map((entry) => entry.name),
          ),
        }),
    explanation: t("sessionAdmission.messagesWaitingExplanation", { owner, machine }),
    next: yours
      ? t("sessionAdmission.yourMessagesWaitingNext", { count: yours.messages, owner })
      : t("sessionAdmission.othersMessagesWaitingNext", { count: total, owner }),
  };
}

/** Stream, detail, and mutation receipts can arrive in different orders. */
export function admissionRecheckControl(
  sessionControl: Session["effectiveControl"],
  ...observed: (Session["effectiveControl"] | null | undefined)[]
): Session["effectiveControl"] {
  return observed.reduce<Session["effectiveControl"]>((latest, candidate) => {
    if (!candidate) return latest;
    if (candidate.controlVersion > latest.controlVersion) return candidate;
    // A tie must not turn a known pause into an actionable recheck.
    if (candidate.controlVersion === latest.controlVersion && candidate.state === "paused") {
      return candidate;
    }
    return latest;
  }, sessionControl);
}

export function admissionControlNeedsRefresh(
  control: Session["effectiveControl"],
  ...observed: (Session["effectiveControl"] | null | undefined)[]
): boolean {
  return observed.some(
    (candidate) =>
      candidate?.controlVersion === control.controlVersion &&
      (candidate.state !== control.state || candidate.controlEtag !== control.controlEtag),
  );
}

/**
 * "Try again" for a block nothing else will lift (an unknown failure): one
 * fenced Resume (the server refuses it if the session's control changed since
 * `control` was read), then every read. A rejected Resume refreshes the reads
 * and is never replayed, so the saved message cannot be sent twice. Blocks the
 * server lifts by itself once access changes never need this.
 */
export async function recheckSessionAdmission({
  control,
  refreshOnly,
  resume,
  refresh,
}: {
  control: Session["effectiveControl"];
  refreshOnly: boolean;
  resume: (control: Session["effectiveControl"]) => Promise<unknown>;
  refresh: (() => Promise<void>)[];
}): Promise<void> {
  let rejected = false;
  let failure: unknown;
  if (!refreshOnly && control.state !== "paused") {
    try {
      await resume(control);
    } catch (error) {
      rejected = true;
      failure = error;
    }
  }
  // Wait for every read even when one rejects, so the pending state covers
  // the complete reconciliation. Preserve the original mutation failure.
  const reads = await Promise.allSettled(refresh.map((read) => read()));
  if (rejected) throw failure;
  if (reads.some((read) => read.status === "rejected")) {
    throw new Error("Session status could not be refreshed");
  }
}
