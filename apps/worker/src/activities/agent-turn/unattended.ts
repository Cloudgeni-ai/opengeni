import type { FirstPartyMcpToolName, Session } from "@opengeni/contracts";

/**
 * First-party tools that pause the turn until a person acts. An unattended
 * session (no person answers until the task ends) is not given them, as it is
 * not given `request_human_input`: the turn would only wait forever.
 */
export const PERSON_WAITING_FIRST_PARTY_TOOLS: readonly FirstPartyMcpToolName[] = [
  "interaction_request_human",
];

/**
 * True when the session's turns run unattended: its own setting, the create
 * option or an automation default (resolved when the session is read).
 */
export function sessionIsUnattended(session: Pick<Session, "unattended">): boolean {
  return session.unattended === true;
}

/**
 * The session an attempt runs with. A person's answer resumes the turn that
 * waited for it with the tools it waited in, even if the chat was switched to
 * unattended meanwhile; the switch applies to the turns after it.
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
