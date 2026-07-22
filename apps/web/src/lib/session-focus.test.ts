import { describe, expect, test } from "bun:test";

import { shouldRestoreSessionFocus } from "./session-focus";

const SESSION_ID = "session-26";

function fakeElement(
  attributes: Record<string, string | null> = {},
  options: { connected?: boolean; closestSessionMenu?: string | null } = {},
): HTMLElement {
  const connected = options.connected ?? true;
  const menu =
    options.closestSessionMenu === undefined
      ? null
      : fakeElement({ "data-session-menu": options.closestSessionMenu });
  return {
    isConnected: connected,
    getAttribute: (name: string) => attributes[name] ?? null,
    closest: () => menu,
  } as unknown as HTMLElement;
}

describe("session pin focus restoration", () => {
  test("recognizes focus lost to body, a disconnected node, or the same row's other target", () => {
    const destination = fakeElement({ "data-session-row": SESSION_ID });
    const body = fakeElement();

    expect(shouldRestoreSessionFocus(null, destination, SESSION_ID, body)).toBe(true);
    expect(
      shouldRestoreSessionFocus(
        fakeElement({}, { connected: false }),
        destination,
        SESSION_ID,
        body,
      ),
    ).toBe(true);
    expect(
      shouldRestoreSessionFocus(
        fakeElement({ "data-session-actions": SESSION_ID }),
        destination,
        SESSION_ID,
        body,
      ),
    ).toBe(true);
  });

  test("recognizes the operation's Radix menu and focus guard", () => {
    const destination = fakeElement({ "data-session-actions": SESSION_ID });
    const body = fakeElement();
    expect(
      shouldRestoreSessionFocus(
        fakeElement({}, { closestSessionMenu: SESSION_ID }),
        destination,
        SESSION_ID,
        body,
      ),
    ).toBe(true);
    expect(
      shouldRestoreSessionFocus(
        fakeElement({ "data-radix-focus-guard": "" }),
        destination,
        SESSION_ID,
        body,
      ),
    ).toBe(true);
  });

  test("does not steal unrelated focus and does not refocus the existing destination", () => {
    const destination = fakeElement({ "data-session-actions": SESSION_ID });
    const body = fakeElement();
    expect(
      shouldRestoreSessionFocus(
        fakeElement({ "data-session-row": "other-session" }),
        destination,
        SESSION_ID,
        body,
      ),
    ).toBe(false);
    expect(shouldRestoreSessionFocus(destination, destination, SESSION_ID, body)).toBe(false);
    expect(
      shouldRestoreSessionFocus(
        fakeElement({}, { closestSessionMenu: "other-session" }),
        destination,
        SESSION_ID,
        body,
      ),
    ).toBe(false);
  });

  test("rejects a destination that was removed during rollback", () => {
    expect(
      shouldRestoreSessionFocus(
        null,
        fakeElement({ "data-session-row": SESSION_ID }, { connected: false }),
        SESSION_ID,
        null,
      ),
    ).toBe(false);
  });
});
