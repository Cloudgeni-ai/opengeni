import { nestedPostgresMessage, nestedPostgresSqlState } from "@opengeni/db";

/** The failure code a turn ends with when its personal machine isn't allowed. */
export const MACHINE_ACCESS_REQUIRED_CODE = "machine_access_required";

/**
 * The fixed reasons the database gives when a turn's approval for its owner's
 * personal Connected Machine is missing, used up, revoked or expired. Any
 * other refusal keeps its own classification. The pre-turn check also raises
 * "no longer live" when the turn lost the machine some other way (another
 * person's turn, a superseded attempt, a chat that moved off the machine);
 * none of those is retryable either, and approving the chat's current machine
 * is the way forward there too.
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

/** Whether `error` is the database refusing a personal machine for lack of approval. */
export function isPersonalMachineAccessRefusal(error: unknown): boolean {
  const sqlState = nestedPostgresSqlState(error);
  const message = nestedPostgresMessage(error);
  if (!sqlState || !message) return false;
  return MACHINE_ACCESS_REFUSALS.get(sqlState)?.has(message) === true;
}

/**
 * The chat's personal machine isn't allowed for this turn: its approval is
 * missing or was used up, revoked or expired. The person who owns the machine
 * can allow it for the chat and continue. The driver error stays
 * attached as `cause` for diagnostics; the message never carries SQL.
 */
export class PersonalMachineAccessRequiredError extends Error {
  readonly code = MACHINE_ACCESS_REQUIRED_CODE;
  readonly machineName: string | null;

  constructor(machineName: string | null | undefined, options?: { cause?: unknown }) {
    const name = machineName?.trim() || null;
    super(
      name
        ? `Machine access needed: this chat isn’t allowed to use “${name}” right now.`
        : "Machine access needed: this chat isn’t allowed to use its machine right now.",
      options,
    );
    this.name = "PersonalMachineAccessRequiredError";
    this.machineName = name;
  }
}

/** The typed refusal anywhere in an error's cause chain, however startup wrapped it. */
export function findPersonalMachineAccessRequiredError(
  error: unknown,
): PersonalMachineAccessRequiredError | null {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current);) {
    if (current instanceof PersonalMachineAccessRequiredError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
