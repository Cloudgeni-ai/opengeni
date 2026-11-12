import { describe, expect, test } from "bun:test";

import {
  passkeyCeremonyDeadline,
  passkeyPromptUnavailable,
  passkeysNeedBrowser,
  withPasskeyDeadline,
} from "./passkeys";

const DESKTOP_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Opengeni/0.9.3 Chrome/146.0.0.0 Electron/44.10.1 Safari/537.36";
const DESKTOP_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Opengeni/0.9.3 Chrome/146.0.0.0 Electron/44.10.1 Safari/537.36";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

describe("passkeys in the desktop app", () => {
  test("the desktop app's windows use the browser for passkeys; a browser doesn't", () => {
    expect(passkeysNeedBrowser(DESKTOP_MAC)).toBe(true);
    expect(passkeysNeedBrowser(DESKTOP_LINUX)).toBe(true);
    expect(passkeysNeedBrowser(CHROME)).toBe(false);
  });
});

describe("passkey ceremonies never wait forever", () => {
  test("a prompt that never opens is cancelled and explained after the deadline", async () => {
    let cancelled = 0;
    const never = new Promise<never>(() => {});
    const outcome = await withPasskeyDeadline(
      () => never,
      20,
      () => {
        cancelled += 1;
      },
    ).catch((error: unknown) => error);
    expect(passkeyPromptUnavailable(outcome)).toBe(true);
    expect(cancelled).toBe(1);
  });

  test("a prompt the person answers in time is unaffected", async () => {
    let cancelled = 0;
    const answer = await withPasskeyDeadline(
      async () => "credential",
      1_000,
      () => {
        cancelled += 1;
      },
    );
    expect(answer).toBe("credential");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cancelled).toBe(0);
  });

  test("the deadline follows the ceremony's own timeout, bounded", () => {
    expect(passkeyCeremonyDeadline({ challengeId: "c", options: { timeout: 120_000 } })).toBe(
      135_000,
    );
    expect(passkeyCeremonyDeadline({ challengeId: "c", options: {} })).toBe(135_000);
    expect(passkeyCeremonyDeadline({ challengeId: "c", options: { timeout: 9e9 } })).toBe(315_000);
  });
});
