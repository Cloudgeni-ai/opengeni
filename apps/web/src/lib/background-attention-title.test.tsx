import { afterEach, describe, expect, test } from "bun:test";
import type { SessionStatus } from "@opengeni/sdk";
import { actRun, registerDom, renderHook } from "../../../../packages/react/test/render-hook";
import {
  ATTENTION_TITLE_PREFIX,
  isAttentionTransition,
  useBackgroundAttentionTitle,
  withAttentionPrefix,
  withoutAttentionPrefix,
} from "./background-attention-title";

registerDom();

let hidden = false;
let focused = true;
function setPage(next: { hidden: boolean; focused: boolean }) {
  hidden = next.hidden;
  focused = next.focused;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.hasFocus = () => focused;
}

afterEach(() => {
  setPage({ hidden: false, focused: true });
  document.title = "OpenGeni";
});

describe("attention transitions", () => {
  test("only a working session that settles for the user counts", () => {
    for (const next of ["idle", "failed", "requires_action"] as const) {
      for (const previous of ["queued", "running", "recovering", "waiting_capacity"] as const) {
        expect(isAttentionTransition(previous, next)).toBe(true);
      }
    }
    expect(isAttentionTransition("running", "cancelled")).toBe(false);
    expect(isAttentionTransition("idle", "idle")).toBe(false);
    expect(isAttentionTransition("failed", "idle")).toBe(false);
    expect(isAttentionTransition(null, "failed")).toBe(false);
  });

  test("the prefix is idempotent and removable", () => {
    expect(withAttentionPrefix(withAttentionPrefix("OpenGeni"))).toBe(
      `${ATTENTION_TITLE_PREFIX}OpenGeni`,
    );
    expect(withoutAttentionPrefix(`${ATTENTION_TITLE_PREFIX}OpenGeni`)).toBe("OpenGeni");
    expect(withoutAttentionPrefix("OpenGeni")).toBe("OpenGeni");
  });
});

describe("useBackgroundAttentionTitle", () => {
  test("marks a background tab when the open session finishes and clears on focus", async () => {
    document.title = "OpenGeni";
    setPage({ hidden: false, focused: true });
    const hook = await renderHook(
      ({ status }: { status: SessionStatus | null }) =>
        useBackgroundAttentionTitle("session-1", status),
      { status: "running" },
    );
    setPage({ hidden: true, focused: false });
    await hook.rerender({ status: "idle" });
    expect(document.title).toBe(`${ATTENTION_TITLE_PREFIX}OpenGeni`);

    setPage({ hidden: false, focused: true });
    await actRun(() => window.dispatchEvent(new Event("focus")));
    expect(document.title).toBe("OpenGeni");
    await hook.unmount();
  });

  test("an unfocused window counts as background and visibility alone does not clear it", async () => {
    document.title = "OpenGeni";
    const hook = await renderHook(
      ({ status }: { status: SessionStatus | null }) =>
        useBackgroundAttentionTitle("session-1", status),
      { status: "running" },
    );
    setPage({ hidden: false, focused: false });
    await hook.rerender({ status: "requires_action" });
    expect(document.title).toBe(`${ATTENTION_TITLE_PREFIX}OpenGeni`);
    await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(document.title).toBe(`${ATTENTION_TITLE_PREFIX}OpenGeni`);
    setPage({ hidden: false, focused: true });
    await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(document.title).toBe("OpenGeni");
    await hook.unmount();
  });

  test("a foreground tab, a session switch, or an initial load never marks the title", async () => {
    document.title = "OpenGeni";
    const hook = await renderHook(
      ({ id, status }: { id: string; status: SessionStatus | null }) =>
        useBackgroundAttentionTitle(id, status),
      { id: "session-1", status: null as SessionStatus | null },
    );
    await hook.rerender({ id: "session-1", status: "failed" });
    await hook.rerender({ id: "session-1", status: "running" });
    await hook.rerender({ id: "session-1", status: "failed" });
    expect(document.title).toBe("OpenGeni");

    setPage({ hidden: true, focused: false });
    await hook.rerender({ id: "session-2", status: "idle" });
    expect(document.title).toBe("OpenGeni");

    await hook.rerender({ id: "session-2", status: "running" });
    await hook.rerender({ id: "session-2", status: "failed" });
    expect(document.title).toBe(`${ATTENTION_TITLE_PREFIX}OpenGeni`);
    await hook.unmount();
    expect(document.title).toBe("OpenGeni");
  });
});
