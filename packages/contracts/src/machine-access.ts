/**
 * The code for a refusal because this chat isn't allowed to use a person's own
 * (Only me) Connected Machine right now: its approval is missing, or was used
 * up, revoked or expired. A turn fails with it, and an agent's move onto such a
 * machine is refused with it.
 */
export const MACHINE_ACCESS_REQUIRED_CODE = "machine_access_required";

/**
 * The sentence every surface shows for {@link MACHINE_ACCESS_REQUIRED_CODE}:
 * the failed-chat banner, the turn's recorded failure and an agent's refused
 * machine move. It names the machine when known.
 */
export function machineAccessNeededMessage(machineName?: string | null): string {
  const name = machineName?.trim();
  return name
    ? `Machine access needed: this chat isn’t allowed to use “${name}” right now.`
    : "Machine access needed: this chat isn’t allowed to use its machine right now.";
}
