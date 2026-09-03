import { describe, expect, test } from "bun:test";

import { createComposerFocusEvent } from "./create-composer-focus";

describe("create composer focus intent", () => {
  test("preserves repeated explicit Default launches separately from omitted Recents intent", () => {
    expect(createComposerFocusEvent().detail.channelId).toBeUndefined();
    expect(createComposerFocusEvent(null).detail.channelId).toBeNull();
    expect(createComposerFocusEvent(null).detail.channelId).toBeNull();
  });
});