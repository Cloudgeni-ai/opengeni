import { describe, expect, test } from "bun:test";
import { selectCodexCredentialForTurn } from "../src/activities/agent-turn";

// Multi-account P1 precedence: session pin > workspace active; both must be in the
// connected set (a disconnected id can never win); null when nothing is usable.
describe("selectCodexCredentialForTurn", () => {
  const connected = new Set(["a", "b", "c"]);

  test("a valid pin wins over the workspace active", () => {
    expect(
      selectCodexCredentialForTurn({
        sessionPinnedCredentialId: "b",
        activeCredentialId: "a",
        connectedIds: connected,
      }),
    ).toBe("b");
  });

  test("no pin → falls back to the workspace active", () => {
    expect(
      selectCodexCredentialForTurn({
        sessionPinnedCredentialId: null,
        activeCredentialId: "a",
        connectedIds: connected,
      }),
    ).toBe("a");
  });

  test("a pin that is no longer connected is ignored; active is used", () => {
    expect(
      selectCodexCredentialForTurn({
        sessionPinnedCredentialId: "gone",
        activeCredentialId: "c",
        connectedIds: connected,
      }),
    ).toBe("c");
  });

  test("a pin not connected AND active not connected → null", () => {
    expect(
      selectCodexCredentialForTurn({
        sessionPinnedCredentialId: "gone",
        activeCredentialId: "also-gone",
        connectedIds: connected,
      }),
    ).toBeNull();
  });

  test("no pin and no active → null (turn fails with the relogin path)", () => {
    expect(
      selectCodexCredentialForTurn({
        sessionPinnedCredentialId: null,
        activeCredentialId: null,
        connectedIds: connected,
      }),
    ).toBeNull();
  });

  test("empty connected set → null even with ids set", () => {
    expect(
      selectCodexCredentialForTurn({
        sessionPinnedCredentialId: "a",
        activeCredentialId: "b",
        connectedIds: new Set(),
      }),
    ).toBeNull();
  });
});
