import { describe, expect, test } from "bun:test";

import { rigActorLabel } from "./rig-status";

const ADA = "user:4f0c2a9e-7b1d-4c3a-9e5f-2a6b8c1d0e3f";
const names = (subjectId: string) =>
  subjectId === ADA ? "Ada Lovelace" : subjectId === "user:me" ? "you" : null;

describe("rigActorLabel", () => {
  test("names the person for new and older attributions, never the raw id", () => {
    expect(rigActorLabel(ADA, names)).toBe("Ada Lovelace");
    // Versions written before the fix doubled the prefix.
    expect(rigActorLabel(`user:${ADA}`, names)).toBe("Ada Lovelace");
    expect(rigActorLabel("user:me", names)).toBe("You");
    expect(rigActorLabel("user:me", names, { inSentence: true })).toBe("you");
  });

  test("someone who isn't a member here is a teammate, not an id", () => {
    const unknown = "user:user:b06b9cee-1111-4111-8111-111111111111";
    expect(rigActorLabel(unknown, names)).toBe("A teammate");
    expect(rigActorLabel(unknown)).toBe("A teammate");
    expect(rigActorLabel(unknown, names, { inSentence: true })).toBe("a teammate");
    expect(rigActorLabel(unknown)).not.toContain("b06b9cee");
  });

  test("agents, the system and missing attributions keep their labels", () => {
    expect(rigActorLabel("session:12345678-aaaa", names)).toBe("Agent session 12345678");
    expect(rigActorLabel("system", names)).toBe("System");
    expect(rigActorLabel(null, names)).toBe("Unknown");
  });
});
