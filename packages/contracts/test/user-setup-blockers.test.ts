import { describe, expect, test } from "bun:test";
import {
  OPENGENI_BROWSER_EXTENSION_URL,
  USER_SETUP_BLOCKERS,
  userSetupBlocker,
  userSetupCardShownMessage,
  userSetupCardUnpostedMessage,
  userSetupUnavailableMessage,
} from "../src/index";

describe("refusals the person can fix", () => {
  test("classify by refusal code, and nothing else", () => {
    expect(userSetupBlocker("attached_browser_unavailable")).toMatchObject({
      capabilityId: "api:connected-machine",
      purpose: "chrome",
    });
    expect(userSetupBlocker("personal_machine_permission_required")).toMatchObject({
      capabilityId: "api:connected-machine",
    });
    for (const code of [
      "personal_machine_not_permitted",
      "offline_enrollment",
      "",
      null,
      undefined,
    ])
      expect(userSetupBlocker(code)).toBeNull();
    expect(new Set(USER_SETUP_BLOCKERS.map((blocker) => blocker.code)).size).toBe(
      USER_SETUP_BLOCKERS.length,
    );
  });

  test("once the card is posted, the agent points to it and does not repeat or retry", () => {
    const chrome = userSetupBlocker("attached_browser_unavailable")!;
    const withLink = userSetupCardShownMessage(chrome, "https://app.example.test/c");
    expect(withLink).toStartWith(chrome.problem);
    expect(withLink).toContain("now posted in this chat");
    expect(withLink).toContain(
      "do not describe its buttons or steps, and do not post another card",
    );
    expect(withLink).toContain("give them this link to it: https://app.example.test/c");
    expect(withLink).toContain("Do not wait for it and do not retry");
    expect(withLink).not.toContain(OPENGENI_BROWSER_EXTENSION_URL);
    expect(userSetupCardShownMessage(chrome)).toContain("tell them to open this chat in Opengeni");
  });

  test("without a card, the agent offers the fix itself in the same reply", () => {
    const chrome = userSetupBlocker("attached_browser_unavailable")!;
    const text = userSetupCardUnpostedMessage(chrome);
    expect(text).toContain("Offer the fix in this reply");
    expect(text).toContain("capability_authorization_request (capabilityId api:connected-machine)");
    expect(text).toContain(OPENGENI_BROWSER_EXTENSION_URL);
    expect(text).toContain("Do not only report that it is unavailable");
  });

  test("when the deployment can't offer the fix, the agent says so and posts no card", () => {
    const chrome = userSetupBlocker("attached_browser_unavailable")!;
    const text = userSetupUnavailableMessage(chrome);
    expect(text).toStartWith(chrome.problem);
    expect(text).toContain("can't fix it here");
    expect(text).toContain("do not post a setup card");
    expect(text).not.toContain("capability_authorization_request");
  });
});
