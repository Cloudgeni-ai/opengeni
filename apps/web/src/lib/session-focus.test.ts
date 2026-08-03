import { describe, expect, test } from "bun:test";

import {
  cancelSessionRowRevealIntent,
  consumeSessionRowRevealIntent,
  shouldMoveSessionRowFocus,
  shouldRecordSessionRowFocusIntent,
  shouldRestoreSessionFocus,
} from "./session-focus";

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
  test("consumes one explicit row reveal without turning repeated data churn into scrolling", () => {
    let scrollCalls = 0;
    const rows = Array.from({ length: 3_800 }, (_, index) => ({
      dataset: { sessionRow: `session-${index}` },
      scrollIntoView: () => {
        scrollCalls += 1;
      },
    })) as unknown as HTMLElement[];
    const root = {
      querySelectorAll: () => rows,
    } as unknown as HTMLElement;
    const intent = { current: "session-2_400" };

    // A target that is not mounted remains pending without moving the rail.
    expect(consumeSessionRowRevealIntent(root, intent)).toBeNull();
    expect(scrollCalls).toBe(0);

    intent.current = "session-2400";
    expect(consumeSessionRowRevealIntent(root, intent)).toBe(rows[2400]!);
    expect(intent.current).toBeNull();
    expect(scrollCalls).toBe(1);

    // Polls, title/status churn, pin reconciliation, and page merges may all
    // rerun the effect; no new explicit intent means the offset stays owned by
    // the reader.
    for (let update = 0; update < 1_000; update += 1) {
      expect(consumeSessionRowRevealIntent(root, intent)).toBeNull();
    }
    expect(scrollCalls).toBe(1);
  });

  test("lets manual scrolling cancel a reveal before its row mounts", () => {
    let scrollCalls = 0;
    const root = {
      querySelectorAll: () => [
        {
          dataset: { sessionRow: "session-late" },
          scrollIntoView: () => {
            scrollCalls += 1;
          },
        },
      ],
    } as unknown as HTMLElement;
    const intent = { current: "session-late" as string | null };

    cancelSessionRowRevealIntent(intent);
    expect(consumeSessionRowRevealIntent(root, intent)).toBeNull();
    expect(scrollCalls).toBe(0);
  });

  test("does not retain intent for boundary navigation that is already current", () => {
    expect(shouldRecordSessionRowFocusIntent(0, 0)).toBe(false);
    expect(shouldRecordSessionRowFocusIntent(2, 2)).toBe(false);
    expect(shouldRecordSessionRowFocusIntent(1, 0)).toBe(true);
    expect(shouldRecordSessionRowFocusIntent(null, 0)).toBe(false);
  });

  test("does not turn a pin remount reorder into a roving row-focus request", () => {
    // The actions trigger is restored by the pin operation after its row
    // remount. The subsequent focus-index effect has no keyboard intent and
    // must leave that restored destination alone.
    expect(shouldMoveSessionRowFocus(null, SESSION_ID)).toBe(false);
    expect(shouldMoveSessionRowFocus(SESSION_ID, SESSION_ID)).toBe(true);
    expect(shouldMoveSessionRowFocus(SESSION_ID, "other-session")).toBe(false);
  });

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
