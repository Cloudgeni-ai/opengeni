import type { MachineView } from "@opengeni/react/machines";
import { machineDisplayName } from "@opengeni/react/sandbox-label-model";
import type { SendMessageInput } from "@opengeni/sdk";

import type { ChatSendContext } from "@/components/capabilities/session-github-repositories";

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
  chat: ChatSendContext;
  canMessage: boolean;
  /** Where the chat runs now, to move back to if a personal machine's consent fails. */
  previousSandboxId?: string | null | undefined;
  attach: (sandboxId: string) => Promise<boolean>;
  sendMessage: (message: SendMessageInput) => Promise<{ payload?: unknown }>;
}): Promise<MoveChatToMachineResult> {
  const { machine, chat } = input;
  const name = machineDisplayName(machine);
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
        clientEventId: crypto.randomUUID(),
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
