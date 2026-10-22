/** Presentation-only recognition of the runtime's four-field uncertainty receipt.
 * Never use displayed tool output to decide whether an operation may be retried.
 * Ordinary command stdout has an exec banner and must not be classified by a
 * loose match for words such as "timeout" or "unknown".
 */
export function isConnectedMachineOutcomeUnknownOutput(output: unknown): output is string {
  if (typeof output !== "string" || !output.startsWith("[connected machine] ")) return false;
  const lines = output.split("\n");
  return (
    lines.length === 5 &&
    lines[1]!.startsWith("What happened: ") &&
    /\(control code ERROR_CODE_[A-Z_]+\)\.$/u.test(lines[1]!) &&
    lines[2]!.startsWith("Which layer: ") &&
    lines[3]!.startsWith("What was preserved: unknown — ") &&
    lines[4]!.startsWith("What to try: ")
  );
}
