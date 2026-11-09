import { nestedPostgresMessage, nestedPostgresSqlState } from "./persistence-errors";

/**
 * The fixed reasons the database gives when a turn's approval for its owner's
 * personal Connected Machine is missing, used up, revoked or expired. Any
 * other refusal keeps its own classification. The pre-use check also raises
 * "no longer live" when the turn lost the machine some other way (another
 * person's turn, a superseded attempt, a chat that moved off the machine);
 * none of those is fixed by trying the same thing again.
 */
const MACHINE_ACCESS_REFUSALS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "42501",
    new Set([
      "personal machine authority is no longer live",
      "personal machine use requires explicit grant",
    ]),
  ],
  ["OG002", new Set(["matching personal-resource grant required"])],
]);

/**
 * The pre-use check after an agent moved its turn onto a personal machine
 * found no live approval for that turn. Thrown, not returned, so the move's
 * transaction rolls back and the chat stays where it was.
 */
export class PersonalMachineAuthorityNotLiveError extends Error {
  constructor() {
    super("personal Connected Machine authority was not live after attach");
    this.name = "PersonalMachineAuthorityNotLiveError";
  }
}

/** Whether `error` is the database refusing a personal machine for lack of approval. */
export function isPersonalMachineAccessRefusal(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current);) {
    if (current instanceof PersonalMachineAuthorityNotLiveError) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  const sqlState = nestedPostgresSqlState(error);
  const message = nestedPostgresMessage(error);
  if (!sqlState || !message) return false;
  return MACHINE_ACCESS_REFUSALS.get(sqlState)?.has(message) === true;
}
