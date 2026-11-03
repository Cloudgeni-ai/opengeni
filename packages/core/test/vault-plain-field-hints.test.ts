// The save-time nudge for plain fields (docs/secrets.md, Field kinds): a
// secret-looking value in a field nobody chose a kind for becomes concealed;
// a chosen text kind is kept with a note. Never refuses. Values are fake.
import { describe, expect, test } from "bun:test";
import type { SecretSaveFieldNote } from "@opengeni/contracts";
import { plainFieldKind } from "../src/domain/vaults/plain-field-hints";

const TOKEN = `ghp_${"Ab1Cd2Ef3".repeat(4)}`;

describe("plainFieldKind", () => {
  test("a default text field with a token becomes concealed and says so", () => {
    const notes: SecretSaveFieldNote[] = [];
    expect(
      plainFieldKind({ name: "account", value: TOKEN, kind: "text", chosen: false }, notes),
    ).toBe("concealed");
    expect(notes).toEqual([
      expect.objectContaining({ field: "account", kind: "concealed", reason: "format" }),
    ]);
    expect(JSON.stringify(notes)).not.toContain(TOKEN);
  });

  test("a chosen text kind is kept with a note", () => {
    const notes: SecretSaveFieldNote[] = [];
    expect(plainFieldKind({ name: "note", value: TOKEN, kind: "text", chosen: true }, notes)).toBe(
      "text",
    );
    expect(notes).toEqual([expect.objectContaining({ field: "note", kind: "text" })]);
  });

  test("ordinary text and other kinds pass through without notes", () => {
    const notes: SecretSaveFieldNote[] = [];
    expect(
      plainFieldKind({ name: "username", value: "deploy-bot", kind: "text", chosen: false }, notes),
    ).toBe("text");
    expect(
      plainFieldKind({ name: "password", value: TOKEN, kind: "concealed", chosen: true }, notes),
    ).toBe("concealed");
    expect(notes).toEqual([]);
  });

  test("a save that reports no notes keeps its kind", () => {
    expect(
      plainFieldKind({ name: "account", value: TOKEN, kind: "text", chosen: false }, undefined),
    ).toBe("text");
  });
});
