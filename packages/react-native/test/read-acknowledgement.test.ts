import { describe, expect, test } from "bun:test";
import { readAcknowledgementFrontier } from "../src/read-acknowledgement";

describe("readAcknowledgementFrontier", () => {
  test("an unread session is acknowledged through its last sequence", () => {
    expect(readAcknowledgementFrontier({ unread: true, lastSequence: 40 }, 0)).toEqual({
      readThrough: 40,
      unread: true,
    });
  });

  test("a read session needs nothing until a newer attention boundary arrives", () => {
    expect(readAcknowledgementFrontier({ unread: false, lastSequence: 40 }, 38).unread).toBe(false);
    expect(readAcknowledgementFrontier({ unread: false, lastSequence: 40 }, 52)).toEqual({
      readThrough: 52,
      unread: true,
    });
  });

  test("no session row means nothing to acknowledge yet", () => {
    expect(readAcknowledgementFrontier(null, 0)).toEqual({ readThrough: 0, unread: false });
  });
});
