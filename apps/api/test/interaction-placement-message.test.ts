import { describe, expect, test } from "bun:test";
import { wrongInteractionPlacementMessage } from "../src/routes/interaction-placement-message";

describe("wrong interaction placement message", () => {
  test("names the swap tool, the exact target and the way back", () => {
    const message = wrongInteractionPlacementMessage("7f099792-650d-4356-96c5-e0df3aab4752");
    expect(message).toStartWith(
      "The requested Connected Machine is not this session's current placement.",
    );
    expect(message).toContain(
      'if sandbox_swap is available, call it with target "7f099792-650d-4356-96c5-e0df3aab4752"',
    );
    expect(message).toContain('swap back (target "session") when done');
  });
});
