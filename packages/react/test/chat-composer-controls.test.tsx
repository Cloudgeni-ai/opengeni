import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

import { ChatComposer } from "../src/components/chat-composer";
import type { ComposerMode, ComposerState } from "../src/hooks/use-composer";
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

function composer(spy: {
  sends: Array<ComposerMode | undefined>;
  pauses: number;
  resumes: number;
}): ComposerState {
  return {
    value: "next prompt",
    setValue: () => {},
    send: async (_text, mode) => {
      spy.sends.push(mode);
      return true;
    },
    sending: false,
    canSend: true,
    pause: async () => {
      spy.pauses += 1;
    },
    pausing: false,
    resume: async () => {
      spy.resumes += 1;
    },
    resuming: false,
    error: null,
    clearError: () => {},
  };
}

async function press(textarea: HTMLTextAreaElement, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    textarea.focus();
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    await Promise.resolve();
  });
}

describe("ChatComposer delivery and lifecycle controls", () => {
  test("Enter queues while Cmd/Ctrl+Enter steers", async () => {
    const spy = { sends: [] as Array<ComposerMode | undefined>, pauses: 0, resumes: 0 };
    mounted = await renderComponent(<ChatComposer composer={composer(spy)} status="running" />);
    const textarea = mounted.container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    await press(textarea!, {});
    await press(textarea!, { metaKey: true });
    await press(textarea!, { ctrlKey: true });

    expect(spy.sends).toEqual(["queue", "steer", "steer"]);
    expect(textarea?.getAttribute("aria-keyshortcuts")).toContain("Meta+Enter");
  });

  test("running shows one Pause control; paused replaces it with one Resume control", async () => {
    const spy = { sends: [] as Array<ComposerMode | undefined>, pauses: 0, resumes: 0 };
    mounted = await renderComponent(<ChatComposer composer={composer(spy)} status="running" />);

    const pause = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pause the session"]',
    );
    expect(pause).not.toBeNull();
    expect(
      mounted.container.querySelectorAll('button[aria-label="Pause the session"]'),
    ).toHaveLength(1);
    expect(mounted.container.querySelector('button[aria-label="Resume the session"]')).toBeNull();
    await act(async () => pause?.click());
    expect(spy.pauses).toBe(1);

    await mounted.rerender(<ChatComposer composer={composer(spy)} status="paused" />);
    const resume = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume the session"]',
    );
    expect(resume).not.toBeNull();
    expect(mounted.container.querySelector('button[aria-label="Pause the session"]')).toBeNull();
    await act(async () => resume?.click());
    expect(spy.resumes).toBe(1);
  });

  test("the send button queues and explains the steer shortcut", async () => {
    const spy = { sends: [] as Array<ComposerMode | undefined>, pauses: 0, resumes: 0 };
    mounted = await renderComponent(<ChatComposer composer={composer(spy)} status="idle" />);
    const send = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]',
    );
    expect(send?.title).toContain("Queue message");
    expect(send?.title).toContain("Cmd/Ctrl+Enter");
    await act(async () => send?.click());
    expect(spy.sends).toEqual([undefined]);
  });
});
