import { beforeEach, expect, test } from "bun:test";

import { registerDom } from "./render-hook";

registerDom();

const { forgetSignedOutBrowserData } = await import("../src/sign-out-browser-data");

// CASA 6.6.1: signing out leaves nothing of the person's in this tab's
// session storage, except entries that hold nobody's content.

beforeEach(() => {
  window.sessionStorage.clear();
});

function keys(): string[] {
  const found: string[] = [];
  for (let index = 0; index < window.sessionStorage.length; index += 1)
    found.push(window.sessionStorage.key(index)!);
  return found.sort();
}

test("sign-out forgets unsent messages, drafts and other per-person entries", () => {
  const personal = [
    "opengeni.pending-composer.v1:workspace%00session",
    "opengeni.optimistic-sends.v1:workspace%00session",
    "opengeni.human-input-draft.v1:workspace:session:request",
    "opengeni.human-input-draft-owner.v1",
    "opengeni.analyticsLoginAttempt",
    "opengeni.onboardingUseCase.v1",
    "opengeni.claude-signin:workspace:w1",
    "opengeni:github-personal-choose-repos:w1",
    "opengeni:site-opened:s1",
  ];
  const kept = [
    "opengeni.reloadForApiContract:7",
    "opengeni.reloadForRevision:abc",
    "opengeni.desktop.webSessionRestoredAt",
    "opengeni:vite-preload-recovery-build",
    "opengeni:sign-in-change-feedback",
    "opengeni:organization-invitation-continuation:v1",
    // Not Opengeni's: an embedding host's own entry.
    "host.cart",
  ];
  for (const key of [...personal, ...kept]) window.sessionStorage.setItem(key, "value");

  forgetSignedOutBrowserData();

  expect(keys()).toEqual([...kept].sort());
});

test("a missing or blocked store is not an error", () => {
  expect(() => forgetSignedOutBrowserData(null)).not.toThrow();
  const blocked = {
    get length(): number {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  expect(() => forgetSignedOutBrowserData(blocked)).not.toThrow();
});
