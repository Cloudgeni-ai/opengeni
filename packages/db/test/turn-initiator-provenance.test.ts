import { describe, expect, test } from "bun:test";
import { clipAgentProvenanceHops } from "../src/turn-initiator";

describe("bounded agent provenance", () => {
  test("retains the causal root and newest hops when the middle is truncated", () => {
    const hops = Array.from({ length: 40 }, (_, index) => ({
      kind: "agent",
      sessionId: `session-${index}`,
      turnId: `turn-${index}`,
    }));

    const clipped = clipAgentProvenanceHops(hops);

    expect(clipped).toHaveLength(32);
    expect(clipped[0]).toBe(hops[0]);
    expect(clipped[1]).toBe(hops[9]);
    expect(clipped.at(-1)).toBe(hops[39]);
  });

  test("returns an untruncated chain unchanged", () => {
    const hops = [{ kind: "agent", sessionId: "root", turnId: "turn-root" }];

    expect(clipAgentProvenanceHops(hops)).toBe(hops);
  });
});
