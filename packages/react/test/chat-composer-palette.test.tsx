import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "../src/components/chat-composer";
import type { ComposerState } from "../src/hooks/use-composer";
import type { SlashCommandContext } from "../src/hooks/use-slash-commands";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { registerDom } from "./render-hook";

registerDom();

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await act(async () => {
      current.root.unmount();
    });
    current.container.remove();
  }
});

/** A controlled fake composer whose value is driven by React state in the test tree. */
function makeComposer(
  value: string,
  setValue: (v: string) => void,
  overrides: Partial<ComposerState> = {},
): ComposerState {
  return {
    value,
    setValue,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: value.trim().length > 0,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
    ...overrides,
  };
}

const ctx: SlashCommandContext = {
  client: fakeClient({
    updateGoal: async () => ({}) as never,
    clearSessionContext: async () => {},
    compactSessionContext: async () => ({ status: "completed", message: "compacted" }),
  }),
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  status: null,
  permissions: ["sessions:control"] as never,
};

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = { root, container };
  return container;
}

describe("ChatComposer slash palette", () => {
  test("opens the palette listbox when the value starts with '/'", async () => {
    let value = "/";
    const container = await mount(
      <ChatComposer
        composer={makeComposer(value, (v) => {
          value = v;
        })}
        commandContext={ctx}
      />,
    );
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(1);
    // The native multiline textbox advertises list autocomplete and the
    // currently active suggestion while the palette is open.
    const textarea = container.querySelector("textarea")!;
    expect(textarea.getAttribute("role")).toBeNull();
    expect(textarea.getAttribute("aria-autocomplete")).toBe("list");
    expect(textarea.getAttribute("aria-controls")).toBeTruthy();
    expect(textarea.getAttribute("aria-activedescendant")).toBeTruthy();
  });

  test("keeps valid native textbox semantics before the palette opens", async () => {
    const container = await mount(
      <ChatComposer composer={makeComposer("", () => {})} commandContext={ctx} />,
    );
    const textarea = container.querySelector("textarea")!;
    expect(textarea.getAttribute("role")).toBeNull();
    expect(textarea.getAttribute("aria-autocomplete")).toBe("list");
    expect(textarea.getAttribute("aria-controls")).toBeNull();
    expect(textarea.getAttribute("aria-activedescendant")).toBeNull();
  });

  test("renders gated commands only with the permission; hides them otherwise", async () => {
    const withPerm = await mount(
      <ChatComposer composer={makeComposer("/", () => {})} commandContext={ctx} />,
    );
    const labels = [...withPerm.querySelectorAll('[role="option"]')].map(
      (el) => el.textContent ?? "",
    );
    expect(labels.join(" ")).toContain("/clear");
    expect(labels.join(" ")).toContain("/compact");
    if (mounted) {
      const c = mounted;
      mounted = null;
      await act(async () => c.root.unmount());
      c.container.remove();
    }

    const noPerm = await mount(
      <ChatComposer
        composer={makeComposer("/", () => {})}
        commandContext={{ ...ctx, permissions: [] as never }}
      />,
    );
    const noPermLabels = [...noPerm.querySelectorAll('[role="option"]')]
      .map((el) => el.textContent ?? "")
      .join(" ");
    expect(noPermLabels).toContain("/help");
    expect(noPermLabels).not.toContain("/clear ");
    expect(noPermLabels).not.toContain("/compact");
  });

  test("the palette is inert (not rendered) without a commandContext", async () => {
    const container = await mount(<ChatComposer composer={makeComposer("/clear", () => {})} />);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  test("a danger command marks itself in the palette row", async () => {
    const container = await mount(
      <ChatComposer composer={makeComposer("/clear", () => {})} commandContext={ctx} />,
    );
    const text = container.textContent ?? "";
    expect(text.toLowerCase()).toContain("danger");
  });

  // Regression (adversarial review): the composer's internal clearView closure
  // must report whether a view-reset was actually wired, so /clear-view can't
  // claim a false success. With no onClearView prop the textbox renders but
  // running the command must NOT surface "Local view cleared." — and with one
  // wired it both invokes it and surfaces the ok notice. Driven through the
  // real component (textarea Enter) so the chat-composer wiring itself is under
  // test, not just the registry handler.
  function ClearViewHarness(props: { onClearView?: () => void }) {
    const [value, setValue] = useState("/clear-view");
    return (
      <ChatComposer
        composer={makeComposer(value, setValue)}
        commandContext={ctx}
        {...(props.onClearView ? { onClearView: props.onClearView } : {})}
      />
    );
  }

  async function pressEnterOnTextarea(container: HTMLElement) {
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      // happy-dom dispatches the native keydown through React's event system on
      // the focused element; the composer's onKeyDown drives the palette run.
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      // Let the async run() + notice state update settle.
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  test("/clear-view surfaces an honest error (not a false success) when onClearView is absent", async () => {
    const container = await mount(<ClearViewHarness />);
    await pressEnterOnTextarea(container);
    expect(container.textContent ?? "").not.toMatch(/local view cleared/i);
    expect(container.textContent ?? "").toMatch(/can't be cleared/i);
  });

  test("/clear-view invokes onClearView and reports success when it is wired", async () => {
    let cleared = 0;
    const container = await mount(
      <ClearViewHarness
        onClearView={() => {
          cleared += 1;
        }}
      />,
    );
    await pressEnterOnTextarea(container);
    expect(cleared).toBe(1);
    expect(container.textContent ?? "").toMatch(/local view cleared/i);
  });

  // Regression (adversarial review): typing the canonical `/clear` (no trailing
  // space) + Enter resolves to the DESTRUCTIVE server-side `clear` command
  // (runHighlighted prefers the exact name match over the highlighted near-
  // match). The confirm bar previously re-derived its command from
  // palette.items[palette.highlight], which is `clear-view` (it prefix-matches
  // "clear" and sorts first) — so it reassured the operator "this device only;
  // no server change" right before wiping the server context. The bar must name
  // the command actually about to run.
  function ClearConfirmHarness() {
    const [value, setValue] = useState("/clear");
    return <ChatComposer composer={makeComposer(value, setValue)} commandContext={ctx} />;
  }

  test("/clear + Enter shows a confirm bar for the destructive /clear, not /clear-view", async () => {
    const container = await mount(<ClearConfirmHarness />);
    // Sanity: before Enter the palette lists clear-view FIRST (the near-match
    // that used to leak into the confirm bar) — clear-view prefix-matches
    // "clear" and is declared earlier than the destructive clear.
    const optionText = [...container.querySelectorAll('[role="option"]')].map(
      (el) => el.textContent ?? "",
    );
    expect(optionText[0]).toContain("/clear-view");
    expect(optionText.some((t) => t.includes("/clear") && t.toLowerCase().includes("danger"))).toBe(
      true,
    );

    await pressEnterOnTextarea(container);

    // runHighlighted resolves the typed "/clear" to the DESTRUCTIVE clear (exact
    // name match beats the highlighted clear-view), so the danger confirm bar
    // must render from THAT command. Scope assertions to the confirm bar itself
    // (the palette listbox may still be animating out and would otherwise leak
    // its clear-view copy into a whole-container textContent check).
    const confirmBar = container.querySelector('[data-testid="danger-confirm"]');
    expect(confirmBar).not.toBeNull();
    const barText = confirmBar?.textContent ?? "";
    // Names the destructive command and its real (destructive) description...
    expect(barText).toContain("/clear?");
    expect(barText.toLowerCase()).toContain("destructive");
    // ...and never the harmless clear-view copy that mislabeled it.
    expect(barText).not.toContain("/clear-view");
    expect(barText.toLowerCase()).not.toContain("this device only");
    expect(barText.toLowerCase()).not.toContain("no server change");
    expect(confirmBar?.getAttribute("aria-label")).toBe("Confirm /clear");

    // Cancel to settle the pending confirm() promise (clear.run awaits it), so
    // unmount in afterEach is clean and no run is left dangling.
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    );
    await act(async () => {
      cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  // Regression (adversarial review): clicking a palette row is an EXPLICIT
  // selection and must run THAT row — not whatever the exact-match token
  // heuristic resolves to. With the draft "/clear", the palette lists the
  // harmless `/clear-view` (index 0) and the destructive `/clear`. The click
  // path used to route through runHighlighted, whose exact-name match for
  // "/clear" hijacked the click and popped the DESTRUCTIVE confirm bar even
  // though the operator clicked the SAFE row. Clicking /clear-view must invoke
  // clearView (here: its honest no-op error, since onClearView is unwired) and
  // must NEVER raise the /clear confirm bar.
  test("clicking the /clear-view row while the draft is /clear runs clear-view, never /clear", async () => {
    let cleared = 0;
    const ClearViewClickHarness = () => {
      const [value, setValue] = useState("/clear");
      return (
        <ChatComposer
          composer={makeComposer(value, setValue)}
          commandContext={ctx}
          onClearView={() => {
            cleared += 1;
          }}
        />
      );
    };
    const container = await mount(<ClearViewClickHarness />);

    // Find the /clear-view row (the harmless one the operator points at).
    const options = [...container.querySelectorAll('[role="option"]')];
    const clearViewRow = options.find((el) => (el.textContent ?? "").includes("/clear-view"));
    expect(clearViewRow).toBeTruthy();
    // Sanity: the destructive /clear is also present (the pair this guards).
    expect(
      options.some((el) => {
        const t = el.textContent ?? "";
        return (
          t.includes("/clear") && !t.includes("/clear-view") && t.toLowerCase().includes("danger")
        );
      }),
    ).toBe(true);

    await act(async () => {
      // The palette runs on mousedown (keeps textarea focus); this is the click.
      clearViewRow!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // clear-view actually ran: onClearView was invoked, success notice shown.
    expect(cleared).toBe(1);
    expect(container.textContent ?? "").toMatch(/local view cleared/i);
    // The destructive /clear confirm bar must NOT have appeared.
    expect(container.querySelector('[data-testid="danger-confirm"]')).toBeNull();
  });

  // Companion: clicking the destructive /clear row (with the same "/clear"
  // draft) still routes to the destructive command and shows its confirm bar —
  // the fix narrows the click to the chosen row, it doesn't disable /clear.
  test("clicking the destructive /clear row raises the /clear confirm bar", async () => {
    const ClearClickHarness = () => {
      const [value, setValue] = useState("/clear");
      return <ChatComposer composer={makeComposer(value, setValue)} commandContext={ctx} />;
    };
    const container = await mount(<ClearClickHarness />);
    const options = [...container.querySelectorAll('[role="option"]')];
    const clearRow = options.find((el) => {
      const t = el.textContent ?? "";
      return t.includes("/clear") && !t.includes("/clear-view");
    });
    expect(clearRow).toBeTruthy();

    await act(async () => {
      clearRow!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const confirmBar = container.querySelector('[data-testid="danger-confirm"]');
    expect(confirmBar).not.toBeNull();
    expect(confirmBar?.getAttribute("aria-label")).toBe("Confirm /clear");

    // Settle the pending confirm() promise for a clean unmount.
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    );
    await act(async () => {
      cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  // Regression (adversarial review): a slash-command draft must never reach the
  // agent as chat. After the palette is dismissed (Escape) the popover is gone
  // but the draft still matches a command, so the composer must block the Enter
  // send path and nudge instead of delivering "/help" as a message. Uses /help
  // (no danger confirm) so the dismissed-then-Enter path has nothing pending.
  test("Enter on a dismissed /command draft is blocked from sending (nudges instead)", async () => {
    let sent = 0;
    const SendBlockHarness = () => {
      const [value, setValue] = useState("/help");
      return (
        <ChatComposer
          composer={makeComposer(value, setValue, {
            send: async () => {
              sent += 1;
              return true;
            },
          })}
          commandContext={ctx}
        />
      );
    };
    const container = await mount(<SendBlockHarness />);
    const textarea = container.querySelector("textarea")!;
    // Dismiss the palette with Escape (palette consumes the key), then Enter.
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    // The "/help" draft was NOT delivered to the agent; a nudge explains why.
    expect(sent).toBe(0);
    expect((container.textContent ?? "").toLowerCase()).toContain("slash command");
  });

  test("the send button is disabled while the draft is a slash command", async () => {
    const container = await mount(
      <ChatComposer composer={makeComposer("/clear", () => {})} commandContext={ctx} />,
    );
    const sendButton = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Send message",
    ) as HTMLButtonElement | undefined;
    expect(sendButton).toBeTruthy();
    expect(sendButton!.disabled).toBe(true);
  });

  test("plain chat still sends (the command-draft guard doesn't block messages)", async () => {
    let sent = 0;
    const container = await mount(
      <ChatComposer
        composer={makeComposer("hello there", () => {}, {
          send: async () => {
            sent += 1;
            return true;
          },
        })}
        commandContext={ctx}
      />,
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(sent).toBe(1);
  });
});
