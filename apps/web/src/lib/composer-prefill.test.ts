import { describe, expect, test } from "bun:test";

import {
  hasComposerPrefill,
  queueComposerPrefill,
  queueComposerSend,
  takeComposerPrefill,
  takeComposerSend,
} from "./composer-prefill";

describe("composer prefill", () => {
  test("is taken once, and only by its own workspace", () => {
    queueComposerPrefill("ws-1", "Research a decision");
    expect(takeComposerPrefill("ws-2")).toBeNull();
    expect(hasComposerPrefill("ws-1")).toBe(true);
    expect(takeComposerPrefill("ws-1")).toBe("Research a decision");
    expect(takeComposerPrefill("ws-1")).toBeNull();
  });

  test("a send is taken once, and only by its own workspace", () => {
    queueComposerSend("ws-1");
    expect(takeComposerSend("ws-2")).toBe(false);
    expect(takeComposerSend("ws-1")).toBe(true);
    expect(takeComposerSend("ws-1")).toBe(false);
  });
});
