import {
  sessionMetadataUnattended,
  type FirstPartyMcpToolName,
  type Session,
} from "@opengeni/contracts";
import { UNATTENDED_SESSION_GUIDANCE } from "@opengeni/runtime";

/**
 * First-party tools that pause the turn until a person acts. An unattended
 * session (no person answers until the task ends) is not given them, as it is
 * not given `request_human_input`: the turn would only wait forever.
 */
export const PERSON_WAITING_FIRST_PARTY_TOOLS: readonly FirstPartyMcpToolName[] = [
  "interaction_request_human",
];

/**
 * True when the session started unattended: the create option or an
 * automation default, frozen in its metadata when it was created (a fork reads
 * as attended). What the model is told and which tools it has follow only
 * this, so the instructions and tool list a chat started with never change
 * under its earlier requests.
 */
export function sessionStartedUnattended(session: Pick<Session, "metadata">): boolean {
  return sessionMetadataUnattended(session.metadata);
}

/**
 * True when no person answers during this attempt: the chat's current
 * setting, which the "Work without me" switch or a person's message can
 * change. Only call-time behaviour follows it (approvals and questions are
 * refused with a tool result instead of waiting); the prompt and tools do not.
 */
export function sessionUnattendedNow(session: Pick<Session, "unattended">): boolean {
  return session.unattended === true;
}

/**
 * Said to the model with a turn whose attendance differs from how the chat
 * started: the "Work without me" switch was turned on in a chat that started
 * attended, or a chat that started unattended now has a person (the switch
 * turned off, or someone wrote in an automation's chat). The system prompt
 * and tools keep following how the chat started, so earlier requests stay
 * byte-identical; this turn-scoped note carries the change instead. A chat
 * whose setting matches how it started gets none.
 */
export const ATTENDED_AGAIN_NOTE =
  "A person is now present in this chat and will see and can answer questions, so the unattended-session guidance no longer applies. Follow the ordinary guidance on when to ask, asking in your reply.";

export function attendanceChangeNote(
  session: Pick<Session, "metadata" | "unattended">,
): string | undefined {
  const started = sessionStartedUnattended(session);
  const now = sessionUnattendedNow(session);
  if (started === now) return undefined;
  return ["[Opengeni attendance]", now ? UNATTENDED_SESSION_GUIDANCE : ATTENDED_AGAIN_NOTE].join(
    "\n",
  );
}

/**
 * The session an attempt runs with. A person's answer resumes the turn that
 * waited for it as attended, even if the chat was switched to unattended
 * meanwhile, since that person is evidently there; the switch applies to the
 * turns after it.
 */
export function sessionForAttempt<T extends Pick<Session, "unattended">>(
  session: T,
  resumesPersonAnswer: boolean,
): T {
  return session.unattended === true && resumesPersonAnswer
    ? { ...session, unattended: false }
    : session;
}

/** The selection unchanged for an attended session; without person-waiting tools otherwise. */
export function firstPartyToolsForAttendance(
  tools: FirstPartyMcpToolName[],
  unattended: boolean,
): FirstPartyMcpToolName[] {
  return unattended
    ? tools.filter((tool) => !PERSON_WAITING_FIRST_PARTY_TOOLS.includes(tool))
    : tools;
}
