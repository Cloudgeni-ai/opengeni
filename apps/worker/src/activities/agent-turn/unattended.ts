import {
  sessionMetadataUnattended,
  type FirstPartyMcpToolName,
  type Session,
} from "@opengeni/contracts";

/**
 * First-party tools that pause the turn until a person acts. An unattended
 * session (no person answers until the task ends) is not given them, as it is
 * not given `request_human_input`: the turn would only wait forever.
 */
export const PERSON_WAITING_FIRST_PARTY_TOOLS: readonly FirstPartyMcpToolName[] = [
  "interaction_request_human",
];

/** True when the session was created unattended (frozen in its metadata). */
export function sessionIsUnattended(session: Pick<Session, "metadata">): boolean {
  return sessionMetadataUnattended(session.metadata);
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
