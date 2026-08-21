import { describe, expect, test } from "bun:test";

import { UpdateSessionAttentionRequest } from "../src/index";

describe("session attention request", () => {
  test("accepts an exact read-through event frontier", () => {
    expect(
      UpdateSessionAttentionRequest.parse({
        unread: false,
        acknowledgedThroughSequence: 42,
      }),
    ).toEqual({ unread: false, acknowledgedThroughSequence: 42 });
  });

  test("keeps read-through frontiers bounded to read acknowledgements", () => {
    for (const request of [
      { acknowledgedThroughSequence: 42 },
      { unread: true, acknowledgedThroughSequence: 42 },
      { unread: false, acknowledgedThroughSequence: -1 },
      { unread: false, acknowledgedThroughSequence: 1.5 },
    ]) {
      expect(UpdateSessionAttentionRequest.safeParse(request).success).toBe(false);
    }
  });

  test("preserves ordinary unread and actively-working mutations", () => {
    expect(UpdateSessionAttentionRequest.safeParse({ unread: true }).success).toBe(true);
    expect(UpdateSessionAttentionRequest.safeParse({ activelyWorking: true }).success).toBe(true);
  });
});
