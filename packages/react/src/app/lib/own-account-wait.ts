import type {
  ChatSession as Session,
  ModelAccountChoiceOption,
  SessionEvent,
  SessionModelAccountChoiceResponse,
} from "@opengeni/sdk";

import { codexWaitIsUsageLimit } from "./codex-model-switch";

/**
 * Whether this chat's active turn waits for Codex usage although the viewer's
 * own account could serve them: the turn was started by someone else, such as
 * a service (meeting notes), and a person's own subscription serves only the
 * turns they send themselves (subscription design D-53, SUB-ELIG-05). The
 * viewer's own message takes over the wait and runs on their account.
 *
 * True only on positive evidence in the loaded events: the active turn's
 * newest capacity wait is a usage wait, and its `turn.queued` initiator is not
 * the viewer. A turn paused while it waited is still that turn (the chat
 * shows idle), and a plain Send would queue behind it.
 */
export function waitingTurnStartedWithoutViewer(
  session: Pick<Session, "status" | "activeTurnId">,
  events: readonly SessionEvent[],
  input: { viewerSubjectId: string | null | undefined; paused: boolean },
): boolean {
  const turnId = session.activeTurnId;
  if (!turnId || !input.viewerSubjectId) return false;
  if (session.status !== "waiting_capacity" && !(session.status === "idle" && input.paused))
    return false;
  let wait: SessionEvent | null = null;
  let queued: SessionEvent | null = null;
  for (const event of events) {
    if (event.type === "codex.capacity.waiting" || event.type === "turn.capacity_waiting") {
      if (!wait || event.sequence > wait.sequence) wait = event;
    } else if (event.type === "turn.queued" && queuedTurnId(event) === turnId) {
      queued = event;
    }
  }
  if (!wait || wait.turnId !== turnId || !codexWaitIsUsageLimit(events) || !queued) return false;
  const initiator = payloadRecord(queued).initiator;
  if (!initiator || typeof initiator !== "object") return false;
  const { kind, subjectId } = initiator as {
    kind?: unknown;
    subjectId?: unknown;
  };
  if (kind === "service") return true;
  return kind === "subject" && typeof subjectId === "string" && subjectId !== input.viewerSubjectId;
}

/**
 * The viewer's own active account of `provider` that may serve `model` and
 * is not known to be out of usage at `now`. Null when they have none.
 */
export function ownAccountWithRoom(
  choice: SessionModelAccountChoiceResponse | null,
  input: { provider: string; model: string; now?: Date },
): ModelAccountChoiceOption | null {
  if (!choice) return null;
  const now = (input.now ?? new Date()).getTime();
  const bare = input.model.includes("/") ? input.model.slice(input.model.indexOf("/") + 1) : null;
  const future = (at: string | null | undefined) => typeof at === "string" && Date.parse(at) > now;
  return (
    choice.accounts.find(
      (account) =>
        account.provider === input.provider &&
        account.personal &&
        account.choosable &&
        account.status === "active" &&
        (account.allowedModelIds === null ||
          account.allowedModelIds.includes(input.model) ||
          (bare !== null && account.allowedModelIds.includes(bare))) &&
        !future(account.usage?.exhaustedUntil) &&
        !(account.usage?.windows ?? []).some(
          (window) => window.status === "exhausted" && future(window.resetsAt),
        ),
    ) ?? null
  );
}

function queuedTurnId(event: SessionEvent): string | null {
  const id = payloadRecord(event).turnId;
  return typeof id === "string" ? id : (event.turnId ?? null);
}

function payloadRecord(event: SessionEvent): Record<string, unknown> {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  return payload && typeof payload === "object" ? payload : {};
}
