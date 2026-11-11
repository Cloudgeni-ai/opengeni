import { afterEach, describe, expect, test } from "bun:test";

import { browserName, webFeedbackContext } from "../src/app/lib/feedback-capture";
import {
  clearRecentErrors,
  recentErrors,
  recordErrorToasts,
  recordRecentError,
} from "../src/app/lib/recent-errors";
import { feedbackSubmission } from "../src/session-feedback-model";

afterEach(clearRecentErrors);

describe("feedback report context", () => {
  test("names the browser from its user agent", () => {
    expect(
      browserName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 141");
    expect(
      browserName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toBe("Edge 141");
    expect(
      browserName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
      ),
    ).toBe("Safari 26");
    expect(
      browserName("Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0"),
    ).toBe("Firefox 145");
    expect(browserName("curl/8")).toBeUndefined();
  });

  test("says it came from web, with the server version and recent errors", () => {
    recordRecentError({ title: "Couldn't save", message: "The server is unavailable." });
    const context = webFeedbackContext({ serverVersion: "1.2.3", deploymentRevision: "abc" });
    expect(context.source).toBe("web");
    expect(context.trigger).toBe("menu");
    expect(context.appVersion).toBe("1.2.3");
    expect(context.buildNumber).toBe("abc");
    expect(context.recentErrors).toEqual([
      expect.objectContaining({ title: "Couldn't save", message: "The server is unavailable." }),
    ]);
  });

  test("keeps the last ten errors", () => {
    for (let index = 0; index < 12; index += 1) recordRecentError({ message: `error ${index}` });
    const kept = recentErrors();
    expect(kept).toHaveLength(10);
    expect(kept[0]?.message).toBe("error 2");
    expect(kept[9]?.message).toBe("error 11");
  });

  test("remembers error toasts and still shows them", () => {
    const shown: unknown[] = [];
    const toast = {
      error: (title: string, data?: { description?: string }) => shown.push([title, data]),
    };
    recordErrorToasts(toast);
    recordErrorToasts(toast);
    toast.error("Couldn't send", { description: "Try again." });
    expect(shown).toHaveLength(1);
    expect(recentErrors()).toEqual([
      expect.objectContaining({ title: "Couldn't send", message: "Try again." }),
    ]);
  });
});

describe("feedback submission", () => {
  const shot = { contentType: "image/jpeg" as const, base64: "AAAA" };

  test("a retry with the same screenshots keeps its key", () => {
    const first = feedbackSubmission({ comment: "hi", screenshots: [shot] }, null, () => "k1");
    expect(
      feedbackSubmission({ comment: "hi", screenshots: [{ ...shot }] }, first, () => "k2"),
    ).toBe(first);
  });

  test("other screenshots make a new submission", () => {
    const first = feedbackSubmission({ comment: "hi", screenshots: [shot] }, null, () => "k1");
    expect(feedbackSubmission({ comment: "hi" }, first, () => "k2").idempotencyKey).toBe("k2");
  });
});
