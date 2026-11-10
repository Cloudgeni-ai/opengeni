import { describe, expect, test } from "bun:test";
import { withoutInternalIds } from "../src/timeline/internal-ids";
import {
  automationRunLine,
  cleanMachineInputSummary,
} from "../src/components/machine-input-display";
import { createOpenGeniText } from "../src/messages/runtime";

const englishText = createOpenGeniText();

const ID = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("withoutInternalIds", () => {
  test.each([
    // The reported case: the label went with nothing after it.
    [`Setup finished. Organisation: ${ID}.`, "Setup finished."],
    [`Organisation: ${ID}`, ""],
    [`Organisation: ${ID}.`, ""],
    [`Worker session id: ${ID}. It finished.`, "It finished."],
    [
      `Connected GitHub for Organisation: ${ID}, then synced.`,
      "Connected GitHub for, then synced.",
    ],
    [
      `Created the board, Organisation: ${ID}, and invited the team.`,
      "Created the board, and invited the team.",
    ],
    [`Organisation: ${ID}, workspace: ${OTHER}`, ""],
    [`Organisation: ${ID} · Workspace: ${OTHER} · Ready`, "Ready"],
    [`Deploy finished (run ${ID}).`, "Deploy finished."],
    [`Deploy finished (${ID}) on time`, "Deploy finished on time"],
    [`Deploy finished [id: ${ID}]`, "Deploy finished"],
    [`Ticket ${ID} was closed`, "Ticket was closed"],
    [`Closed ticket "${ID}".`, "Closed ticket."],
    [`id=${ID}`, ""],
    [`Deploy finished - ${ID}`, "Deploy finished"],
    [`Done.\nSession: ${ID}\nNext: review the notes.`, "Done.\nNext: review the notes."],
    [`- Ticket ${ID} closed\n- Ticket T-12 opened`, "- Ticket closed\n- Ticket T-12 opened"],
  ])("%j reads %j", (input, expected) => {
    const output = withoutInternalIds(input);
    expect(output).toBe(expected);
    // Never a label or separator left dangling.
    expect(output).not.toMatch(/[:=,;·|]\s*[.)\]]|[:=]$|\(\s*\)|\[\s*\]/u);
  });

  test("text without an ID is unchanged, character for character", () => {
    for (const text of [
      "Wait... what?",
      "Steps:\n\n1. Build\n2. Ship ,",
      "  Indented: yes  ",
      "Version 1.2.3 (beta)",
      "Issue T-4907: Refund request",
    ]) {
      expect(withoutInternalIds(text)).toBe(text);
    }
  });
});

describe("displayed system text", () => {
  test("a setup summary hides the organisation ID without a dangling label", () => {
    expect(cleanMachineInputSummary(`[SETUP] GitHub is connected. Organisation: ${ID}.`)).toBe(
      "GitHub is connected.",
    );
  });

  test("an automation run line drops an ID with its label", () => {
    const automation = (eventSummaries: string[]) => ({
      automation: { name: "Ticket assigned", eventSummaries, eventCount: eventSummaries.length },
    });
    expect(
      automationRunLine(englishText, [automation([`Refund request (ticket ${ID}) from Contoso`])]),
    ).toBe("Ticket assigned: Refund request from Contoso");
    // An event that said nothing but an ID leaves the name alone.
    expect(automationRunLine(englishText, [automation([`Ticket: ${ID}`])])).toBe("Ticket assigned");
  });
});
