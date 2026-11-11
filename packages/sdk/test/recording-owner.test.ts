import { describe, expect, test } from "bun:test";

import { ownerNameField } from "../src/recording-owner";

const microphone = { source: "microphone" as const };
const computer = { source: "system" as const };

describe("ownerNameField", () => {
  test("names the owner only when the microphone is theirs, beside computer or tab audio", () => {
    expect(ownerNameField("  Ola Nordmann ", [microphone, computer])).toEqual({
      ownerName: "Ola Nordmann",
    });
    expect(ownerNameField("Ola Nordmann", [microphone])).toEqual({});
    expect(ownerNameField("Ola Nordmann", [computer])).toEqual({});
    expect(ownerNameField("   ", [microphone, computer])).toEqual({});
    expect(ownerNameField(null, [microphone, computer])).toEqual({});
  });

  test("a long name is cut to what the server takes, never inside a character", () => {
    const name = `${"a".repeat(199)}😀b`;
    const field = ownerNameField(name, [microphone, computer]);
    expect(field.ownerName).toBe("a".repeat(199));
    expect(ownerNameField("ø".repeat(250), [microphone, computer]).ownerName).toHaveLength(200);
  });
});
