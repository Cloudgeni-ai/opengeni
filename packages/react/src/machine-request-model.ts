// An agent's request to use a Connected Machine, and the person's answer to
// it: which machine was asked for, whether it can be allowed here, and moving
// the chat onto it with the owner's consent. The web card and the React
// Native card both use it, so both make the same choices. No DOM, styles or
// assets.
import {
  PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION,
  type ChatSession,
  type MachineView,
  type PersonalResourceAttachmentIntent,
  type SendMessageInput,
  type SwapActiveSandboxResponse,
} from "@opengeni/sdk";
import { machineAccessNeededMessage } from "@opengeni/contracts/machine-access";
import type { OpenGeniText } from "./messages/runtime";
import { machineDisplayName } from "./sandbox-label-model";
import { isMachineComputeSelectable } from "./session-admission-model";
import type { AuthNeededItem } from "./timeline/types";

export { isMachineComputeSelectable };

/**
 * What an ordinary composer Send would carry right now, read at click time,
 * so moving the chat follows the composer's own Send rules.
 */
export type MachineMoveChat = {
  /** Why the chat cannot take a Send now, in words; null when it can. */
  blocked: string | null;
  /** The chat waits on a human answer; a Send replaces that request. */
  awaitingHuman: boolean;
  /**
   * The owner's consent to use their own Connected Machine in this chat, sent
   * with the message that moves the chat onto it. Undefined when the chat's
   * authority is unknown.
   */
  personalMachineIntent?: PersonalResourceAttachmentIntent | undefined;
  extras: Partial<
    Pick<
      SendMessageInput,
      | "model"
      | "reasoningEffort"
      | "latencyMode"
      | "controlEtag"
      | "connectionAccounts"
      | "personalResourceAttachment"
    >
  >;
};

/** Longest machine name repeated in the person's message. */
const MESSAGE_NAME_LIMIT = 60;

/**
 * What the person's message says when they move the chat onto a machine. The
 * name comes from whoever enrolled the machine, so it is quoted, kept to one
 * line and shortened: it names a machine and can never read as an instruction.
 */
export function machineUseMessage(name: string): string {
  const line = name
    .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
    .replaceAll("“", "")
    .replaceAll("”", "")
    .trim();
  const short =
    line.length > MESSAGE_NAME_LIMIT ? `${line.slice(0, MESSAGE_NAME_LIMIT - 1)}…` : line;
  return `Use the machine “${short || "unnamed"}” for this chat.`;
}

/** A machine that only its owner can use; using it in a chat needs their consent. */
export function isPersonalMachine(machine: Pick<MachineView, "scope" | "isSessionGroup">): boolean {
  return machine.scope === "user" && !machine.isSessionGroup;
}

export function buildPersonalResourceAttachmentIntent(input: {
  mode: PersonalResourceAttachmentIntent["mode"] | null;
  visibility: "private" | "workspace";
  acknowledged: boolean;
  expectedAuthorityEpoch?: number | undefined;
  resourceCount: number;
}): PersonalResourceAttachmentIntent | undefined {
  if (
    input.resourceCount === 0 ||
    input.mode === null ||
    (input.visibility === "workspace" && !input.acknowledged)
  ) {
    return undefined;
  }
  return {
    mode: input.mode,
    ...(input.expectedAuthorityEpoch !== undefined
      ? { expectedAuthorityEpoch: input.expectedAuthorityEpoch }
      : {}),
    workspaceSharedAcknowledged: input.visibility === "workspace" && input.acknowledged,
    sharedOutputWarningVersion: PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION,
  };
}

/**
 * The owner's consent for their own Connected Machine in this chat. Moving the
 * chat onto the machine is that consent, so the message that tells the agent
 * where it runs carries it. It names no resource: the server derives the
 * machine from the chat's active pointer and checks the owner and the chat's
 * authority epoch. Without it a chat moved mid-session has no grant for the
 * machine, and every turn after the move is refused at admission.
 *
 * `always` is for an explicit move: the person choosing their own machine for
 * a chat turns it on for their own work in this workspace, so their other
 * chats here don't ask again. Ordinary sends only renew it for this chat.
 */
export function personalMachineUseIntent(
  tenancy:
    | Pick<NonNullable<ChatSession["tenancy"]>, "visibility" | "authorityEpoch">
    | null
    | undefined,
  mode: "session" | "always" = "session",
): PersonalResourceAttachmentIntent | undefined {
  if (!tenancy) return undefined;
  return buildPersonalResourceAttachmentIntent({
    mode,
    visibility: tenancy.visibility === "workspace" ? "workspace" : "private",
    acknowledged: true,
    expectedAuthorityEpoch: tenancy.authorityEpoch,
    resourceCount: 1,
  });
}

export type MoveChatToMachineResult =
  | { moved: false; reason: string | null }
  | { moved: true; text: string };

/**
 * Move a chat onto a machine the way a person asks for it: repoint the chat,
 * then tell the agent where it now runs. For the person's own machine that
 * message also carries their consent to use it in this chat. Only the owner can
 * move a chat onto a personal machine, so choosing it is the approval; without
 * it the chat would point at the machine while every turn is refused.
 *
 * A personal machine is therefore never left attached without that consent: a
 * chat that can't carry it right now (waiting on an answer, no permission to
 * send, unknown authority) is not moved, and a consent message that fails moves
 * the chat back to where it was.
 */
export async function moveChatToMachine(input: {
  machine: MachineView;
  /** The machine's name as the person sees it. */
  name: string;
  chat: MachineMoveChat;
  canMessage: boolean;
  /** Where the chat runs now, to move back to if a personal machine's consent fails. */
  previousSandboxId?: string | null | undefined;
  attach: (sandboxId: string) => Promise<boolean>;
  sendMessage: (message: SendMessageInput) => Promise<{ payload?: unknown }>;
}): Promise<MoveChatToMachineResult> {
  const { machine, chat, name } = input;
  // Like a composer Send: a chat that can't take input isn't moved either.
  if (chat.blocked) return { moved: false, reason: chat.blocked };
  const personal = isPersonalMachine(machine);
  const consent = personal ? chat.personalMachineIntent : undefined;
  if (personal) {
    if (chat.awaitingHuman) {
      return {
        moved: false,
        reason: `Answer the question above first, then move this chat to ${name}.`,
      };
    }
    if (!input.canMessage || !consent) {
      return { moved: false, reason: `This chat can't be approved for ${name} right now.` };
    }
  }
  if (!(await input.attach(machine.sandboxId))) return { moved: false, reason: null };
  // Tell the agent where it now runs. A chat waiting on a question keeps
  // that question; the person's answer continues it on the new machine.
  let told = false;
  let routing: unknown = null;
  if (input.canMessage && !chat.awaitingHuman) {
    try {
      const accepted = await input.sendMessage({
        text: machineUseMessage(name),
        ...chat.extras,
        ...(consent ? { personalResourceAttachment: consent } : {}),
        clientEventId: globalThis.crypto.randomUUID(),
      });
      routing = (accepted.payload as { routing?: unknown } | null)?.routing ?? null;
      told = true;
    } catch {
      told = false;
    }
  }
  if (personal && !told) {
    // Without the consent every turn on the machine is refused; don't leave
    // the chat there.
    const previous = input.previousSandboxId;
    const restored =
      previous && previous !== machine.sandboxId
        ? await input.attach(previous).catch(() => false)
        : false;
    return {
      moved: false,
      reason: restored
        ? `Couldn't approve ${name} for this chat, so it stayed where it was. Try again.`
        : `Couldn't approve ${name} for this chat. Try again, or move it back.`,
    };
  }
  const text = chat.awaitingHuman
    ? `This chat now runs on ${name}. Answer the question above to continue.`
    : !told
      ? `This chat now runs on ${name}. Send a message to continue.`
      : routing === "queued_for_execution"
        ? `This chat now runs on ${name}. The agent continues there after its current step.`
        : `This chat now runs on ${name}.`;
  return { moved: true, text };
}

/** A machine's reachability in a few words ("Online", "Offline"). */
export function machineStateLabel(t: OpenGeniText, state: MachineView["state"]): string {
  switch (state) {
    case "online":
    case "consent_required":
      return t("machineRequest.state.online");
    case "display_unavailable":
      return t("machineRequest.state.onlineNoDisplay");
    case "reconnecting":
      return t("machineRequest.state.reconnecting");
    case "enrolling":
      return t("machineRequest.state.connecting");
    default:
      return t("machineRequest.state.offline");
  }
}

export type MachineRequestState = {
  /** The person's connected machines (no session boxes, enrolled only). */
  machines: MachineView[];
  /** The machine this chat runs on now, if it is one of them. */
  active: MachineView | null;
  /** Machines the chat could move onto now. */
  reachable: MachineView[];
  /** The machine the agent asked for, when it is listed. */
  requested: MachineView | null;
  /** The agent asked for a machine the chat doesn't run on yet. */
  asking: boolean;
  /** The requested machine, when the person can allow it right here. */
  allowHere: MachineView | null;
  /** The chat already runs on the machine it needs. */
  complete: boolean;
};

/**
 * Read an agent's machine request against the person's machines. Running on
 * some other machine doesn't answer a request for this one: it stays open
 * until the chat is on the machine asked for.
 */
export function machineRequestState(input: {
  item: Pick<AuthNeededItem, "requestedSandboxId">;
  machines: readonly MachineView[];
  canAttach: boolean;
}): MachineRequestState {
  const machines = input.machines.filter(
    (machine) => !machine.isSessionGroup && machine.enrollmentId,
  );
  const active = machines.find((machine) => machine.active) ?? null;
  const reachable = machines.filter((machine) => isMachineComputeSelectable(machine.state));
  const requested =
    (input.item.requestedSandboxId
      ? machines.find((machine) => machine.sandboxId === input.item.requestedSandboxId)
      : undefined) ?? null;
  const asking = requested !== null && !requested.active;
  const allowHere =
    asking && input.canAttach && isMachineComputeSelectable(requested.state) ? requested : null;
  return {
    machines,
    active,
    reachable,
    requested,
    asking,
    allowHere,
    complete: !asking && active !== null,
  };
}

/** The name a machine goes by in the card and the message that moves the chat. */
export function machineRequestName(
  t: OpenGeniText,
  machine: Pick<MachineView, "isSessionGroup" | "kind" | "name">,
): string {
  return machineDisplayName(t, machine);
}

/**
 * Plain copy for a refused move, chosen by its typed code. The server's
 * `reason` is written for the agent and for logs, so it is never shown here.
 */
export function swapFailureMessage(t: OpenGeniText, result: SwapActiveSandboxResponse): string {
  switch (result.code) {
    case "recovery_in_progress":
      return t("hooks.useMachines.itsComputerIsStillStarting");
    case "recovery_degraded":
      return t("hooks.useMachines.itsComputerIsntWorking");
    case "recovery_unrecoverable":
      return t("hooks.useMachines.itsComputerCouldntBeRestored");
    case "offline_enrollment":
      return t("hooks.useMachines.thatMachineIsOffline");
    case "stale_pointer":
      return t("hooks.useMachines.thatMachineIsNoLonger");
    case "unsupported_backend_context":
    case "transient_establishment":
      return t("hooks.useMachines.thatMachineCouldntBeReached");
    case "concurrent_swap":
      return t("hooks.useMachines.itWasMovedSomewhere");
    case "personal_machine_permission_required":
      return t("hooks.useMachines.theMachineSOwnerHas");
    case "personal_machine_not_permitted":
      return t("hooks.useMachines.onlyTheMachineSOwner");
    // Trying again won't help while the chat isn't allowed to use the machine.
    case "machine_access_required":
      return machineAccessNeededMessage();
    // Neither is fixed by trying again: say what to do instead.
    case "workspace_root_unavailable":
      return t("hooks.useMachines.thatMachineHasntReported");
    case "invalid_working_directory":
      return t("hooks.useMachines.thisChatSWorkingFolder");
    default:
      return t("hooks.useMachines.tryAgain");
  }
}
