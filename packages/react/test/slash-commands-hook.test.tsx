import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { defaultCommands } from "../src/commands/registry";
import type { Notice, SlashCommand } from "../src/commands/types";
import type { KeyboardEvent } from "react";
import { useSlashCommands, type SlashCommandContext, type SlashCommandHandlers } from "../src/hooks/use-slash-commands";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom();

type KeyInit = { key: string; shiftKey?: boolean; isComposing?: boolean };

/** A minimal KeyboardEvent stub matching what the hook reads. */
function keyEvent(init: KeyInit): KeyboardEvent<HTMLTextAreaElement> {
  return {
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    nativeEvent: { isComposing: init.isComposing ?? false },
    preventDefault: () => {},
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

type Harness = {
  value: string;
  setValue: (v: string) => void;
  notices: Notice[];
  helpOpened: number;
  viewCleared: number;
  confirmAnswer: boolean;
  command: ReturnType<typeof useSlashCommands>;
};

function setup(options: {
  initialValue?: string;
  context?: SlashCommandContext | undefined;
  commands?: readonly SlashCommand[];
  confirmAnswer?: boolean;
}) {
  return renderHook<Harness, void>(() => {
    const [value, setValue] = useState(options.initialValue ?? "");
    const [notices, setNotices] = useState<Notice[]>([]);
    const [helpOpened, setHelpOpened] = useState(0);
    const [viewCleared, setViewCleared] = useState(0);
    const handlers: SlashCommandHandlers = {
      notice: (n) => setNotices((cur) => [...cur, n]),
      openHelp: () => setHelpOpened((n) => n + 1),
      clearView: () => { setViewCleared((n) => n + 1); return true; },
      confirm: async () => options.confirmAnswer ?? true,
    };
    const command = useSlashCommands({
      commands: options.commands ?? defaultCommands,
      context: options.context,
      handlers,
      value,
      setValue,
    });
    return { value, setValue, notices, helpOpened, viewCleared, confirmAnswer: options.confirmAnswer ?? true, command };
  }, undefined);
}

const sessionCtx: SlashCommandContext = {
  client: fakeClient({
    updateGoal: async () => ({}) as never,
    clearSessionContext: async () => {},
    compactSessionContext: async () => ({ status: "queued", message: "Compaction will run before the next turn." }),
  }),
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  status: null,
  permissions: ["sessions:control"] as never,
};

describe("useSlashCommands", () => {
  test("opens and filters as a slash token is typed", async () => {
    const h = await setup({ initialValue: "/cl", context: sessionCtx });
    expect(h.result.current.command.open).toBe(true);
    expect(h.result.current.command.items.map((c) => c.name)).toEqual(expect.arrayContaining(["clear", "clear-view"]));
    await h.unmount();
  });

  test("stays closed for plain chat", async () => {
    const h = await setup({ initialValue: "hello", context: sessionCtx });
    expect(h.result.current.command.open).toBe(false);
    await h.unmount();
  });

  test("ArrowDown/ArrowUp move the highlight with wrap", async () => {
    const h = await setup({ initialValue: "/", context: sessionCtx });
    const count = h.result.current.command.items.length;
    expect(count).toBeGreaterThan(1);
    expect(h.result.current.command.highlight).toBe(0);
    h.result.current.command.onKeyDown(keyEvent({ key: "ArrowDown" }));
    await h.rerender();
    expect(h.result.current.command.highlight).toBe(1);
    // Wrap back to top from the last item.
    for (let i = 1; i < count; i += 1) {
      h.result.current.command.onKeyDown(keyEvent({ key: "ArrowDown" }));
      await h.rerender();
    }
    expect(h.result.current.command.highlight).toBe(0);
    h.result.current.command.onKeyDown(keyEvent({ key: "ArrowUp" }));
    await h.rerender();
    expect(h.result.current.command.highlight).toBe(count - 1);
    await h.unmount();
  });

  test("Tab autocompletes the highlighted command name + trailing space", async () => {
    const h = await setup({ initialValue: "/comp", context: sessionCtx });
    h.result.current.command.onKeyDown(keyEvent({ key: "Tab" }));
    await h.rerender();
    expect(h.result.current.value).toBe("/compact ");
    await h.unmount();
  });

  test("Escape closes the palette but keeps the draft", async () => {
    const h = await setup({ initialValue: "/clear", context: sessionCtx });
    expect(h.result.current.command.open).toBe(true);
    h.result.current.command.onKeyDown(keyEvent({ key: "Escape" }));
    await h.rerender();
    expect(h.result.current.command.open).toBe(false);
    expect(h.result.current.value).toBe("/clear");
    // Editing re-opens.
    h.result.current.setValue("/clear-");
    await h.rerender();
    expect(h.result.current.command.open).toBe(true);
    await h.unmount();
  });

  test("Enter runs a client command and clears the draft", async () => {
    const h = await setup({ initialValue: "/help", context: sessionCtx });
    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    await flush();
    await h.rerender();
    expect(h.result.current.helpOpened).toBe(1);
    expect(h.result.current.value).toBe("");
    await h.unmount();
  });

  test("Enter on a required-arg command without the arg does not run (waits at the hint)", async () => {
    const h = await setup({ initialValue: "/goal ", context: sessionCtx });
    expect(h.result.current.command.activeCommand?.name).toBe("goal");
    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    await h.rerender();
    // Still /goal with no notice — nothing fired.
    expect(h.result.current.value).toBe("/goal ");
    expect(h.result.current.notices).toHaveLength(0);
    await h.unmount();
  });

  test("Enter on /goal pause runs and surfaces an ok notice", async () => {
    const h = await setup({ initialValue: "/goal pause", context: sessionCtx });
    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    await flush();
    await h.rerender();
    expect(h.result.current.notices.at(-1)).toEqual({ tone: "ok", message: "Goal paused." });
    expect(h.result.current.value).toBe("");
    await h.unmount();
  });

  test("danger command runs only after confirm resolves true", async () => {
    let cleared = false;
    const ctx: SlashCommandContext = { ...sessionCtx, client: fakeClient({ clearSessionContext: async () => { cleared = true; } }) };
    const h = await setup({ initialValue: "/clear", context: ctx, confirmAnswer: true });
    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    await h.rerender();
    expect(cleared).toBe(true);
    expect(h.result.current.notices.at(-1)).toEqual({ tone: "ok", message: "Context cleared." });
    await h.unmount();
  });

  test("runAt runs the explicitly chosen row, bypassing the exact-match override", async () => {
    // Draft "/clear": items[0] is the harmless clear-view, and the destructive
    // clear exact-matches the token. runHighlighted would resolve to clear;
    // runAt(0) must run clear-view instead (the explicitly clicked row).
    let cleared = false;
    let viewClears = 0;
    const ctx: SlashCommandContext = {
      ...sessionCtx,
      client: fakeClient({ clearSessionContext: async () => { cleared = true; } }),
    };
    const h = await renderHook<Harness, void>(() => {
      const [value, setValue] = useState("/clear");
      const [notices, setNotices] = useState<Notice[]>([]);
      const handlers: SlashCommandHandlers = {
        notice: (n) => setNotices((cur) => [...cur, n]),
        openHelp: () => {},
        clearView: () => { viewClears += 1; return true; },
        confirm: async () => true,
      };
      const command = useSlashCommands({ commands: defaultCommands, context: ctx, handlers, value, setValue });
      return { value, setValue, notices, helpOpened: 0, viewCleared: 0, confirmAnswer: true, command };
    }, undefined);

    const items = h.result.current.command.items;
    const clearViewIndex = items.findIndex((c) => c.name === "clear-view");
    expect(clearViewIndex).toBeGreaterThanOrEqual(0);
    // The destructive clear is present too (the exact-match the override would pick).
    expect(items.some((c) => c.name === "clear")).toBe(true);

    await h.result.current.command.runAt(clearViewIndex);
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    await h.rerender();

    // clear-view ran; the destructive clear did NOT touch the server.
    expect(viewClears).toBe(1);
    expect(cleared).toBe(false);
    expect(h.result.current.notices.at(-1)).toEqual({ tone: "ok", message: "Local view cleared." });
    await h.unmount();
  });

  test("ArrowDown to /clear-view + Enter runs clear-view, not the exact-match /clear", async () => {
    // Draft "/clear": items[0] is clear-view, and clear exact-matches the token.
    // Without navigation Enter resolves to the destructive clear (exact match).
    // After ArrowDown lands the highlight on clear-view, Enter must run THAT row.
    let cleared = false;
    let viewClears = 0;
    const ctx: SlashCommandContext = {
      ...sessionCtx,
      client: fakeClient({ clearSessionContext: async () => { cleared = true; } }),
    };
    const h = await renderHook<Harness, void>(() => {
      const [value, setValue] = useState("/clear");
      const [notices, setNotices] = useState<Notice[]>([]);
      const handlers: SlashCommandHandlers = {
        notice: (n) => setNotices((cur) => [...cur, n]),
        openHelp: () => {},
        clearView: () => { viewClears += 1; return true; },
        confirm: async () => true,
      };
      const command = useSlashCommands({ commands: defaultCommands, context: ctx, handlers, value, setValue });
      return { value, setValue, notices, helpOpened: 0, viewCleared: 0, confirmAnswer: true, command };
    }, undefined);

    // clear-view sorts first, so highlight 0 is already clear-view; arrow-navigate
    // explicitly (down then up returns to 0) to mark the selection as deliberate.
    expect(h.result.current.command.items[0]?.name).toBe("clear-view");
    h.result.current.command.onKeyDown(keyEvent({ key: "ArrowDown" }));
    await h.rerender();
    h.result.current.command.onKeyDown(keyEvent({ key: "ArrowUp" }));
    await h.rerender();
    expect(h.result.current.command.highlight).toBe(0);

    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    await h.rerender();

    expect(viewClears).toBe(1);
    expect(cleared).toBe(false);
    expect(h.result.current.notices.at(-1)).toEqual({ tone: "ok", message: "Local view cleared." });
    await h.unmount();
  });

  test("without navigation, Enter on a fully-typed /clear still resolves to the exact /clear", async () => {
    // The exact-match override is preserved for the no-navigation case: typing
    // the full "/clear" and pressing Enter (no arrows) runs the destructive
    // clear, not the highlighted clear-view.
    let cleared = false;
    const ctx: SlashCommandContext = {
      ...sessionCtx,
      client: fakeClient({ clearSessionContext: async () => { cleared = true; } }),
    };
    const h = await setup({ initialValue: "/clear", context: ctx, confirmAnswer: true });
    // No arrow keys — straight Enter.
    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    await h.rerender();
    expect(cleared).toBe(true);
    expect(h.result.current.notices.at(-1)).toEqual({ tone: "ok", message: "Context cleared." });
    await h.unmount();
  });

  test("a fully-typed /Clear (mixed case) Enter resolves to the exact destructive clear", async () => {
    // The exact-match override lowercases the token (like matchCommand), so the
    // canonical destructive command wins over the highlighted prefix near-match
    // even when the operator typed it with different casing.
    let cleared = false;
    const ctx: SlashCommandContext = {
      ...sessionCtx,
      client: fakeClient({ clearSessionContext: async () => { cleared = true; } }),
    };
    const h = await setup({ initialValue: "/Clear", context: ctx, confirmAnswer: true });
    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    await h.rerender();
    expect(cleared).toBe(true);
    await h.unmount();
  });

  test("canceling the /clear confirm keeps the draft (does not wipe '/clear')", async () => {
    let cleared = false;
    const ctx: SlashCommandContext = {
      ...sessionCtx,
      client: fakeClient({ clearSessionContext: async () => { cleared = true; } }),
    };
    const h = await setup({ initialValue: "/clear", context: ctx, confirmAnswer: false });
    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    await h.rerender();
    expect(cleared).toBe(false);
    // The draft survives the cancel — the operator didn't lose what they typed.
    expect(h.result.current.value).toBe("/clear");
    await h.unmount();
  });

  test("isCommandDraft stays true after Escape dismisses the palette", async () => {
    const h = await setup({ initialValue: "/clear", context: sessionCtx });
    expect(h.result.current.command.isCommandDraft).toBe(true);
    expect(h.result.current.command.open).toBe(true);
    h.result.current.command.onKeyDown(keyEvent({ key: "Escape" }));
    await h.rerender();
    // Popover closed, but the draft is still a command — the composer uses this
    // to keep "/clear" from being sent to the agent as chat.
    expect(h.result.current.command.open).toBe(false);
    expect(h.result.current.command.isCommandDraft).toBe(true);
    await h.unmount();
  });

  test("isCommandDraft is false for plain chat and for an unrecognized slash token", async () => {
    const chat = await setup({ initialValue: "hello", context: sessionCtx });
    expect(chat.result.current.command.isCommandDraft).toBe(false);
    await chat.unmount();
    const unknown = await setup({ initialValue: "/zzzznotacommand", context: sessionCtx });
    expect(unknown.result.current.command.isCommandDraft).toBe(false);
    await unknown.unmount();
  });

  test("runAt out of range is a no-op", async () => {
    const h = await setup({ initialValue: "/clear", context: sessionCtx });
    await h.result.current.command.runAt(999);
    await h.rerender();
    expect(h.result.current.notices).toHaveLength(0);
    await h.unmount();
  });

  test("the palette is inert without a command context", async () => {
    const h = await setup({ initialValue: "/clear", context: undefined });
    // open still derives from value (commands have no perm gate for help), but
    // running does nothing without a context.
    h.result.current.command.onKeyDown(keyEvent({ key: "Enter" }));
    await h.rerender();
    expect(h.result.current.notices).toHaveLength(0);
    await h.unmount();
  });
});
