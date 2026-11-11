// An open chat's composer while its saved draft is still loading: the real
// useComposer and ChatComposer, wired the way the session page wires them.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ComposerDraft, SessionEvent } from "@opengeni/sdk";
import { act } from "react";

import {
  useSessionComposerDelivery,
  useSessionSendGate,
  type SessionSendState,
} from "../src/app/lib/session-composer-readiness";
import { ChatComposer } from "../src/components/chat-composer";
import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

// The composer remembers an outcome-unknown send per workspace and session for
// the life of the page (module state and sessionStorage), and other test files
// in the same process leave one behind for the shared fake session. A fresh
// session per test keeps these tests independent of whatever ran before.
let sessionId = crypto.randomUUID();
beforeEach(() => {
  sessionId = crypto.randomUUID();
});

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

const savedDraft: ComposerDraft = {
  revision: 3,
  text: "",
  resources: [],
  model: "model-x",
  reasoningEffort: "medium",
  latencyMode: "standard",
  sourceTurnId: null,
  sourceTurnVersion: null,
  updatedAt: null,
};

/**
 * The session page's composer wiring, from the module the page uses: Send's
 * guard reads the committed model check while the composer renders, and the
 * delivery handed to the composer reports preparing until Send can go.
 */
function SessionComposer({
  client,
  modelRunnable,
  loading = false,
}: {
  client: ReturnType<typeof fakeClient>;
  modelRunnable: (model: string) => boolean;
  loading?: boolean;
}) {
  const gate = useSessionSendGate();
  const send: SessionSendState = {
    uploadPending: false,
    repositoryError: null,
    personalDecision: false,
    machineAccessDenied: false,
    loading,
    loadFailed: false,
  };
  const composer = useComposer(sessionId, {
    client,
    workspaceId: WORKSPACE_ID,
    sendBlocked: () => gate.blocker(send) !== null,
  });
  const policyValid = composer.policy !== null && modelRunnable(composer.policy.model);
  typeInto.current = composer.setValue;
  const delivery = useSessionComposerDelivery(composer, gate, {
    policyValid,
    catalogLoading: false,
    replacingModel: false,
    send,
  });
  return <ChatComposer composer={delivery} />;
}

const typeInto: { current: (text: string) => void } = { current: () => {} };

function draftGate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function clientWithSlowDraft(sent: string[]) {
  const gate = draftGate();
  const client = fakeClient({
    getComposerDraft: async () => {
      await gate.opened;
      return savedDraft;
    },
    sendMessage: async (_workspaceId, _sessionId, message) => {
      const input = typeof message === "string" ? { text: message } : message;
      sent.push(input.text ?? "");
      return {
        id: crypto.randomUUID(),
        sessionId,
        sequence: 2,
        type: "user.message",
        payload: { text: input.text },
        createdAt: new Date().toISOString(),
      } as unknown as SessionEvent;
    },
  });
  return { client, openDraft: gate.open };
}

/** Types into the box the way its onChange does. */
async function type(container: HTMLElement, text: string): Promise<HTMLTextAreaElement> {
  const box = container.querySelector("textarea");
  if (!box) throw new Error("missing the message box");
  await act(async () => typeInto.current(text));
  await flush();
  return box;
}

async function pressEnter(box: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    box.focus();
    box.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

function sendSpinner(container: HTMLElement): Element | null {
  return container.querySelector('[data-analytics-action="send"] .animate-og-spin');
}

describe("Enter while an open chat's saved draft is still loading", () => {
  test("waits, then sends as soon as the composer can", async () => {
    const sent: string[] = [];
    const { client, openDraft } = clientWithSlowDraft(sent);
    mounted = await renderComponent(
      <SessionComposer client={client} modelRunnable={(model) => model === "model-x"} />,
    );
    const box = await type(mounted.container, "Fix the totals");
    await pressEnter(box);
    await flush();
    expect(sent).toEqual([]);
    expect(sendSpinner(mounted.container)).not.toBeNull();

    openDraft();
    await flush(50);
    expect(sent).toEqual(["Fix the totals"]);
  });

  test("keeps waiting while something else Send needs is loading", async () => {
    const sent: string[] = [];
    const { client, openDraft } = clientWithSlowDraft(sent);
    const runnable = (model: string) => model === "model-x";
    mounted = await renderComponent(
      <SessionComposer client={client} modelRunnable={runnable} loading />,
    );
    const box = await type(mounted.container, "Fix the totals");
    await pressEnter(box);
    openDraft();
    await flush(50);
    expect(sent).toEqual([]);
    expect(sendSpinner(mounted.container)).not.toBeNull();

    await mounted.rerender(
      <SessionComposer client={client} modelRunnable={runnable} loading={false} />,
    );
    await flush(50);
    expect(sent).toEqual(["Fix the totals"]);
  });

  test("ends without sending when the model can't run, leaving the draft and Send idle", async () => {
    const sent: string[] = [];
    const { client, openDraft } = clientWithSlowDraft(sent);
    mounted = await renderComponent(
      <SessionComposer client={client} modelRunnable={() => false} />,
    );
    const box = await type(mounted.container, "Fix the totals");
    await pressEnter(box);
    openDraft();
    await flush(50);
    expect(sent).toEqual([]);
    expect(sendSpinner(mounted.container)).toBeNull();
    expect(box.value).toBe("Fix the totals");
  });

  test("keeps waiting through a retry when the first draft read times out, then sends once", async () => {
    const sent: string[] = [];
    let reads = 0;
    const firstRead = draftGate();
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        if (reads === 1) {
          await firstRead.opened;
          throw new DOMException("Request timed out", "TimeoutError");
        }
        return savedDraft;
      },
      sendMessage: async (_workspaceId, _sessionId, message) => {
        const input = typeof message === "string" ? { text: message } : message;
        sent.push(input.text ?? "");
        return {
          id: crypto.randomUUID(),
          sessionId,
          sequence: 2,
          type: "user.message",
          payload: { text: input.text },
          createdAt: new Date().toISOString(),
        } as unknown as SessionEvent;
      },
    });
    mounted = await renderComponent(
      <SessionComposer client={client} modelRunnable={(model) => model === "model-x"} />,
    );
    const box = await type(mounted.container, "Fix the totals");
    await pressEnter(box);
    firstRead.open();
    await flush(50);
    // The read timed out and is retried shortly: the send still waits.
    expect(sent).toEqual([]);
    expect(sendSpinner(mounted.container)).not.toBeNull();

    // The retry comes about a second later and settles the draft.
    await flush(1_500);
    expect(reads).toBe(2);
    expect(sent).toEqual(["Fix the totals"]);
  });

  test("never waits forever: a draft that doesn't arrive ends the wait with a message", async () => {
    const sent: string[] = [];
    const { client } = clientWithSlowDraft(sent);
    jest.useFakeTimers();
    try {
      mounted = await renderComponent(
        <SessionComposer client={client} modelRunnable={(model) => model === "model-x"} />,
      );
      const box = await type(mounted.container, "Fix the totals");
      await pressEnter(box);
      expect(sendSpinner(mounted.container)).not.toBeNull();
      await act(async () => jest.advanceTimersByTime(29_000));
      expect(sendSpinner(mounted.container)).not.toBeNull();
      await act(async () => jest.advanceTimersByTime(1_500));
    } finally {
      jest.useRealTimers();
    }
    await flush();
    expect(sent).toEqual([]);
    expect(sendSpinner(mounted.container)).toBeNull();
    expect(mounted.container.textContent).toContain(
      "This is taking longer than usual, so it wasn't sent. Try again in a moment.",
    );
    expect(mounted.container.querySelector("textarea")?.value).toBe("Fix the totals");
  });
});
