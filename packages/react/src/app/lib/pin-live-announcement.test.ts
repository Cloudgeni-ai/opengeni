import { describe, expect, test } from "bun:test";

import { pinLiveAnnouncement } from "./pin-live-announcement";

describe("pinLiveAnnouncement", () => {
  test("makes identical consecutive pin results distinct live-region mutations", () => {
    const first = pinLiveAnnouncement("Session was not pinned.", 1);
    const second = pinLiveAnnouncement("Session was not pinned.", 2);

    expect(first).toBe("Session was not pinned.\u200B");
    expect(second).toBe("Session was not pinned.\u200C");
    expect(first).not.toBe(second);
  });
});
