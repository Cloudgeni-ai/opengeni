import {
  MACHINE_ACCESS_REQUIRED_CODE,
  machineAccessNeededMessage,
} from "@opengeni/contracts/machine-access";

// The database's refusal reasons live with the database. A turn that hits one
// before it starts is not retryable, and approving the chat's current machine
// is the way forward.
export { isPersonalMachineAccessRefusal } from "@opengeni/db";
export { MACHINE_ACCESS_REQUIRED_CODE };

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
    super(machineAccessNeededMessage(name), options);
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
