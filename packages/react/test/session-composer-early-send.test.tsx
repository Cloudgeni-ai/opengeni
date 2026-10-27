// An open chat's composer while its saved draft is still loading: the real
// useComposer and ChatComposer, wired the way the session page wires them.
import { afterEach, describe, expect, test } from "bun:test";
import type { ComposerDraft, SessionEvent } from "@opengeni/sdk";
import { act, useState } from "react";

import { useSessionComposerDelivery } from "../src/app/lib/session-composer-readiness";
import { ChatComposer } from "../src/components/chat-composer";
import { useComposer } from "../src/hooks/use-composer";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

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
 * As on the session page: Send's guard is read while the composer renders,
 * and whether the model choice can run is worked out from the composer's own
 * policy after it renders.
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
  const [committedPolicyValid, commitPolicyValid] = useState(false);
  const composer = useComposer(SESSION_ID, {
    client,
    workspaceId: WORKSPACE_ID,
    // Like the page, Send is also blocked while what it waits on loads.
    sendBlocked: () => !committedPolicyValid || loading,
  });
  const policyValid = composer.policy !== null && modelRunnable(composer.policy.model);
  typeInto.current = composer.setValue;
  const delivery = useSessionComposerDelivery(composer, {
    policyValid,
    committedPolicyValid,
    commitPolicyValid,
    loading,
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
        sessionId: SESSION_ID,
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
});
