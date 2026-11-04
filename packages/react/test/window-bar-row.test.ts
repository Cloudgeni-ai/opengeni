import { expect, test } from "bun:test";
import { chatHeaderInWindowBar } from "../src/app/lib/window-bar-row";

const chat = "/workspaces/w1/sessions/s1";

test("a chat's header is the window bar's row only on a chat in the docked macOS app", () => {
  const on = { platform: "macos", mobile: false, session: true, pathname: chat };
  expect(chatHeaderInWindowBar(on)).toBe(true);
  // The web app and the other desktop platforms keep the header in the panel.
  for (const platform of [null, undefined, "windows", "linux"]) {
    expect(chatHeaderInWindowBar({ ...on, platform })).toBe(false);
  }
  // So do the mobile layout, a chat page without its session yet, and pages
  // without a chat header (Settings, Meetings, Sites, new session).
  expect(chatHeaderInWindowBar({ ...on, mobile: true })).toBe(false);
  expect(chatHeaderInWindowBar({ ...on, session: false })).toBe(false);
  for (const pathname of [
    "/workspaces/w1/settings",
    "/workspaces/w1/meetings",
    "/workspaces/w1/sites/s1",
    "/workspaces/w1/sessions",
    "/workspaces/w1",
  ]) {
    expect(chatHeaderInWindowBar({ ...on, pathname })).toBe(false);
  }
});
