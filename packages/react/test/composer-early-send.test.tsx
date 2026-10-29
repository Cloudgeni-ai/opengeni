import { afterEach, describe, expect, jest, test } from "bun:test";
import { act, useState } from "react";

import { ChatComposer } from "../src/components/chat-composer";
import type { ChatComposerMessages } from "../src/composer-messages";
import type { ComposerState } from "../src/hooks/use-composer";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

type Gate = { preparing: boolean; canSend: boolean };

const controls: {
  setGate: (gate: Gate) => void;
  setText: (text: string) => void;
  setError: (error: Error | null) => void;
} = { setGate: () => {}, setText: () => {}, setError: () => {} };

const GAVE_UP = "This is taking longer than usual, so it wasn't sent. Try again in a moment.";

/** The notice the composer shows now (its announcement region; the visible line animates out). */
function noticeText(container: HTMLElement): string {
  return container.querySelector(".sr-only")?.textContent ?? "";
}

// A delivery like a new chat right after the page opens: the text box takes
// input while what Send needs (the model list, the saved draft) still loads.
function Harness({
  sends,
  initial,
  messages,
  sendKeepsDraft = false,
}: {
  sends: string[];
  initial: Gate;
  messages?: Partial<ChatComposerMessages>;
  /** Leave the text in the box after sending, so only the Send itself can clear a notice. */
  sendKeepsDraft?: boolean;
}) {
  const [gate, setGate] = useState<Gate>(initial);
  const [value, setValue] = useState("Sum column B");
  const [error, setError] = useState<Error | null>(null);
  controls.setGate = setGate;
  controls.setText = setValue;
  controls.setError = setError;
  const state: ComposerState = {
    value,
    setValue,
    hasDraftContent: () => value.length > 0,
    // Reads this render's draft, like a real delivery.
    send: async () => {
      sends.push(value);
      if (!sendKeepsDraft) setValue("");
      return true;
    },
    steer: async () => {
      sends.push(`steer:${value}`);
      return true;
    },
    sending: false,
    canSend: gate.canSend && value.trim().length > 0,
    preparing: gate.preparing,
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
    error,
    clearError: () => setError(null),
  };
  return <ChatComposer composer={state} messages={messages} />;
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector("textarea");
  if (!element) throw new Error("missing the message box");
  return element;
}

function sendButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-analytics-action="send"]');
  if (!button) throw new Error("missing Send");
  return button;
}

async function pressEnter(element: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

async function settle(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Send pressed before the composer can send", () => {
  test("Enter while Send is still preparing waits and sends once it is ready", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: true, canSend: false }} />,
    );
    const send = sendButton(mounted.container);
    // A draft can be sent while preparing; Send isn't greyed out.
    expect(send.disabled).toBe(false);

    await pressEnter(textarea(mounted.container));
    expect(sends).toEqual([]);
    // The draft stays visible and the Send button shows it is on its way.
    expect(textarea(mounted.container).value).toBe("Sum column B");
    expect(send.disabled).toBe(true);
    expect(send.querySelector(".animate-og-spin")).not.toBeNull();

    // A second Enter while waiting does not send twice.
    await pressEnter(textarea(mounted.container));

    await settle(() => controls.setGate({ preparing: false, canSend: true }));
    expect(sends).toEqual(["Sum column B"]);
    expect(textarea(mounted.container).value).toBe("");
  });

  test("a load that never finishes ends the wait with a message instead of spinning forever", async () => {
    const sends: string[] = [];
    jest.useFakeTimers();
    try {
      mounted = await renderComponent(
        <Harness sends={sends} initial={{ preparing: true, canSend: false }} />,
      );
      await pressEnter(textarea(mounted.container));
      const send = sendButton(mounted.container);
      expect(send.querySelector(".animate-og-spin")).not.toBeNull();
      await act(async () => jest.advanceTimersByTime(30_000));
    } finally {
      jest.useRealTimers();
    }
    await settle(() => {});
    expect(sends).toEqual([]);
    expect(sendButton(mounted.container).querySelector(".animate-og-spin")).toBeNull();
    expect(textarea(mounted.container).value).toBe("Sum column B");
    expect(noticeText(mounted.container)).toContain(GAVE_UP);
    // Once it does load, Send works as usual.
    await settle(() => controls.setGate({ preparing: false, canSend: true }));
    await pressEnter(textarea(mounted.container));
    await settle(() => {});
    expect(sends).toEqual(["Sum column B"]);
    // The notice belonged to the Send that gave up; it goes with the next one.
    expect(noticeText(mounted.container)).not.toContain(GAVE_UP);
  });

  async function giveUp(mountedComposer: RenderedComponent): Promise<void> {
    jest.useFakeTimers();
    try {
      await pressEnter(textarea(mountedComposer.container));
      await act(async () => jest.advanceTimersByTime(30_000));
    } finally {
      jest.useRealTimers();
    }
    await settle(() => {});
  }

  test("a later Send clears the notice of a held Send that gave up, and a later error shows", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: true, canSend: false }} sendKeepsDraft />,
    );
    await giveUp(mounted);
    expect(noticeText(mounted.container)).toContain(GAVE_UP);

    await settle(() => controls.setGate({ preparing: false, canSend: true }));
    await pressEnter(textarea(mounted.container));
    await settle(() => {});
    expect(sends).toEqual(["Sum column B"]);
    // The draft didn't change, so the Send itself ended the notice.
    expect(textarea(mounted.container).value).toBe("Sum column B");
    expect(noticeText(mounted.container)).not.toContain(GAVE_UP);

    // A real error afterwards is shown, not hidden behind the old notice.
    await settle(() => controls.setError(new Error("The message could not be delivered.")));
    expect(noticeText(mounted.container)).toContain("The request could not be completed.");
  });

  test("editing the draft clears the notice of a held Send that gave up", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: true, canSend: false }} />,
    );
    await giveUp(mounted);
    expect(noticeText(mounted.container)).toContain(GAVE_UP);
    await settle(() => controls.setText("Sum column B, please"));
    expect(noticeText(mounted.container)).not.toContain(GAVE_UP);
    expect(sends).toEqual([]);
  });

  test("a background error doesn't replace the notice of a held Send that gave up", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: true, canSend: false }} />,
    );
    await giveUp(mounted);
    // For example the saved draft's read timing out again while it retries:
    // the person still needs to know their message wasn't sent.
    await settle(() => controls.setError(new Error("The message could not be delivered.")));
    expect(noticeText(mounted.container)).toContain(GAVE_UP);
    // The next Send ends it.
    await settle(() => controls.setGate({ preparing: false, canSend: true }));
    await pressEnter(textarea(mounted.container));
    await settle(() => {});
    expect(sends).toEqual(["Sum column B"]);
    expect(noticeText(mounted.container)).not.toContain(GAVE_UP);
  });

  test("a host can word the held-Send notice through the composer messages", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness
        sends={sends}
        initial={{ preparing: true, canSend: false }}
        messages={{ heldSendGaveUp: "Still loading. Send again in a moment." }}
      />,
    );
    await giveUp(mounted);
    expect(noticeText(mounted.container)).toContain("Still loading. Send again in a moment.");
    expect(noticeText(mounted.container)).not.toContain(GAVE_UP);
  });

  test("a held Send uses the draft as it is when it goes out", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: true, canSend: false }} />,
    );
    await pressEnter(textarea(mounted.container));
    await settle(() => controls.setText("Sum column B and C"));
    await settle(() => controls.setGate({ preparing: false, canSend: true }));
    expect(sends).toEqual(["Sum column B and C"]);
  });

  test("a held Send goes out as soon as Send is allowed, even while something else loads", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: true, canSend: false }} />,
    );
    await pressEnter(textarea(mounted.container));
    await settle(() => controls.setGate({ preparing: true, canSend: true }));
    expect(sends).toEqual(["Sum column B"]);
  });

  test("a held Send is dropped when the composer turns out unable to send", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: true, canSend: false }} />,
    );
    await pressEnter(textarea(mounted.container));
    await settle(() => controls.setGate({ preparing: false, canSend: false }));
    expect(sends).toEqual([]);
    // The draft is kept and Send no longer spins.
    expect(textarea(mounted.container).value).toBe("Sum column B");
    const send = sendButton(mounted.container);
    expect(send.querySelector(".animate-og-spin")).toBeNull();
    expect(send.disabled).toBe(true);

    // Ready later: an ordinary Enter sends.
    await settle(() => controls.setGate({ preparing: false, canSend: true }));
    await pressEnter(textarea(mounted.container));
    expect(sends).toEqual(["Sum column B"]);
  });

  test("clearing the draft while it waits cancels the Send", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: true, canSend: false }} />,
    );
    await pressEnter(textarea(mounted.container));
    await settle(() => controls.setText(""));
    await settle(() => controls.setGate({ preparing: false, canSend: true }));
    expect(sends).toEqual([]);
  });

  test("without preparing, Enter on a composer that can't send still does nothing", async () => {
    const sends: string[] = [];
    mounted = await renderComponent(
      <Harness sends={sends} initial={{ preparing: false, canSend: false }} />,
    );
    expect(sendButton(mounted.container).disabled).toBe(true);
    await pressEnter(textarea(mounted.container));
    await settle(() => controls.setGate({ preparing: false, canSend: true }));
    expect(sends).toEqual([]);
  });
});
