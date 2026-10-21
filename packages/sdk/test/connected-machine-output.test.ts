import { expect, test } from "bun:test";
import { isConnectedMachineOutcomeUnknownOutput } from "../src/connected-machine-output";

const receipt = [
  "[connected machine] the machine link blipped",
  "What happened: the machine did not respond in time (control code ERROR_CODE_TIMEOUT).",
  "Which layer: the machine link (transport) — not your command",
  "What was preserved: unknown — the command may or may not have run (its reply was lost).",
  "What to try: inspect the command's effects before repeating it.",
].join("\n");

test("recognizes only the complete Connected Machine uncertainty receipt", () => {
  expect(isConnectedMachineOutcomeUnknownOutput(receipt)).toBe(true);
  for (const other of [
    undefined,
    { isError: true },
    "TIMEOUT: outcome unknown",
    receipt.replace("unknown — ", "nothing ran — "),
    receipt.replace("ERROR_CODE_TIMEOUT", "SOME_OTHER_ERROR"),
    receipt.split("\n").slice(0, 4).join("\n"),
    `Process exited with code 0\nOutput:\n${receipt}`,
  ]) {
    expect(isConnectedMachineOutcomeUnknownOutput(other)).toBe(false);
  }
});
