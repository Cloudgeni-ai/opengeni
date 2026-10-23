import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type {
  ComposerDraft,
  SessionEvent,
  SessionQueueSnapshot,
  SessionTurn,
  ResourceRef,
} from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import * as Composer from "../src/composer";
import {
  hasQueuedSendInFlight,
  latestRecallableQueuedTurn,
  shouldRecallQueuedOnKey,
  useQueuedPromptRecall,
  type ComposerQueuedRecall,
  type QueuedPromptRecallOutcome,
} from "../src/hooks/use-queued-prompt-recall";
import { useTurnQueue, type UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import type { ComposerOptimisticMessage } from "../src/hooks/use-composer";
import type { SlashCommandContext } from "../src/hooks/use-slash-commands";
import { fakeClient, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import {
  flush,
  registerDom,
  renderComponent,
  renderHook,
  type RenderedComponent,
} from "./render-hook";

registerDom();

const noEvents: SessionEvent[] = [];
const commandContext: SlashCommandContext = {
  client: fakeClient({}),
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  status: null,
  permissions: [],
};
const ME = "user:test";

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

function queueSnapshot(items: SessionTurn[], version = 1): SessionQueueSnapshot {
  return {
    version,
    effectiveControl: {
      state: "active",
      controlVersion: 3,
      controlEtag: "control-3",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    stoppingPreviousAttempt: false,
    items,
    pendingInputs: [],
    pendingInputAttachment: null,
    activePersonalConnections: [],
  };
}

function draftFor(turn: SessionTurn, revision: number): ComposerDraft {
  return {
    revision,
    text: turn.prompt,
    resources: turn.resources,
    model: turn.model,
    reasoningEffort: turn.reasoningEffort,
    latencyMode: turn.latencyMode,
    sourceTurnId: turn.id,
    sourceTurnVersion: turn.version,
    updatedAt: new Date().toISOString(),
  };
}

function mutationResponse(items: SessionTurn[], version: number, draft?: ComposerDraft) {
  return {
    receipt: {
      id: crypto.randomUUID(),
      action: "queue.edit",
      operationKey: crypto.randomUUID(),
      targetSessionId: SESSION_ID,
      targetTurnId: null,
      appliedControlRevision: null,
      appliedQueueVersion: version,
      appliedTurnVersion: null,
      appliedDraftRevision: draft?.revision ?? null,
      createdAt: new Date().toISOString(),
    },
    snapshot: queueSnapshot(items, version),
    ...(draft ? { draft } : {}),
  };
}

function promptStartedConflict(): OpenGeniApiError {
  return new OpenGeniApiError(
    409,
    JSON.stringify({
      error: {
        status: 409,
        code: "QUEUE_PROMPT_STARTED",
        message: "Prompt is no longer waiting",
        retryable: false,
      },
    }),
    { mutation: true },
  );
}

async function flushing(run: () => Promise<void> | void): Promise<void> {
  await act(async () => {
    await run();
  });
}

const file: ResourceRef = {
  kind: "file",
  fileId: "f0f0f0f0-1111-4222-8333-444444444444",
};

describe("shouldRecallQueuedOnKey", () => {
  const empty = {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    hasOtherContent: false,
    popupOpen: false,
  };

  test("plain Up in an empty composer recalls", () => {
    expect(shouldRecallQueuedOnKey({ key: "ArrowUp" }, empty)).toBe(true);
  });

  test("other keys and modified Up keep their normal behaviour", () => {
    expect(shouldRecallQueuedOnKey({ key: "ArrowDown" }, empty)).toBe(false);
    for (const modifier of ["shiftKey", "altKey", "metaKey", "ctrlKey"] as const) {
      expect(shouldRecallQueuedOnKey({ key: "ArrowUp", [modifier]: true }, empty)).toBe(false);
    }
  });

  test("IME composition never recalls", () => {
    expect(
      shouldRecallQueuedOnKey({ key: "ArrowUp", nativeEvent: { isComposing: true } }, empty),
    ).toBe(false);
    expect(shouldRecallQueuedOnKey({ key: "ArrowUp", keyCode: 229 }, empty)).toBe(false);
  });

  test("an open popup owns the arrow keys", () => {
    expect(shouldRecallQueuedOnKey({ key: "ArrowUp" }, { ...empty, popupOpen: true })).toBe(false);
  });

  test("any draft text, even with the caret at the start, keeps caret movement", () => {
    expect(
      shouldRecallQueuedOnKey(
        { key: "ArrowUp" },
        { ...empty, value: "line one\nline two", selectionStart: 12, selectionEnd: 12 },
      ),
    ).toBe(false);
    expect(
      shouldRecallQueuedOnKey(
        { key: "ArrowUp" },
        { ...empty, value: "draft", selectionStart: 0, selectionEnd: 0 },
      ),
    ).toBe(false);
    expect(shouldRecallQueuedOnKey({ key: "ArrowUp" }, { ...empty, value: " " })).toBe(false);
  });

  test("attachments or quotes in an otherwise empty draft keep normal behaviour", () => {
    expect(shouldRecallQueuedOnKey({ key: "ArrowUp" }, { ...empty, hasOtherContent: true })).toBe(
      false,
    );
  });
});

describe("latestRecallableQueuedTurn", () => {
  const none = () => null;

  test("takes the newest waiting prompt of this person", () => {
    const older = fakeTurn({ id: "older" });
    const newer = fakeTurn({ id: "newer" });
    const someoneElse = fakeTurn({
      id: "theirs",
      initiator: { kind: "subject", subjectId: "user:other" },
    });
    expect(latestRecallableQueuedTurn([older, newer, someoneElse], none, ME)?.id).toBe("newer");
    expect(latestRecallableQueuedTurn([older, newer, someoneElse], none, null)?.id).toBe("theirs");
  });

  test("skips prompts mid-mutation, machine prompts and once attachments", () => {
    const plain = fakeTurn({ id: "plain" });
    const moving = fakeTurn({ id: "moving" });
    const machine = fakeTurn({ id: "machine", source: "schedule" as SessionTurn["source"] });
    const once = fakeTurn({
      id: "once",
      personalResources: { mode: "once" } as SessionTurn["personalResources"],
    });
    const mutationFor = (id: string) => (id === "moving" ? ("move" as const) : null);
    expect(latestRecallableQueuedTurn([plain, moving, machine, once], mutationFor, ME)?.id).toBe(
      "plain",
    );
    expect(latestRecallableQueuedTurn([], none, ME)).toBeNull();
  });

  test("a known viewer never recalls an unattributed prompt", () => {
    const unattributed = fakeTurn({
      id: "unattributed",
      initiator: undefined as unknown as SessionTurn["initiator"],
    });
    expect(latestRecallableQueuedTurn([unattributed], none, ME)).toBeNull();
  });
});

function optimistic(overrides: Partial<ComposerOptimisticMessage>): ComposerOptimisticMessage {
  return {
    clientEventId: "client-1",
    delivery: "send",
    destination: "queue",
    text: "just sent",
    annotations: [],
    resources: [],
    occurredAt: "2026-10-23T11:00:00.000Z",
    state: "sending",
    ...overrides,
  };
}

describe("hasQueuedSendInFlight", () => {
  const queued = new Set(["in-queue"]);

  test("a send on its way into the queue is in flight", () => {
    expect(hasQueuedSendInFlight([optimistic({})], queued, 4)).toBe(true);
    expect(
      hasQueuedSendInFlight(
        [optimistic({ state: "queued", turnId: "new", appliedQueueVersion: 5 })],
        queued,
        4,
      ),
    ).toBe(true);
  });

  test("settled, failed, steered or chat sends are not", () => {
    expect(hasQueuedSendInFlight(undefined, queued, 4)).toBe(false);
    expect(
      hasQueuedSendInFlight([optimistic({ state: "queued", turnId: "in-queue" })], queued, 4),
    ).toBe(false);
    expect(
      hasQueuedSendInFlight(
        [optimistic({ state: "queued", turnId: "ran", appliedQueueVersion: 4 })],
        queued,
        4,
      ),
    ).toBe(false);
    expect(hasQueuedSendInFlight([optimistic({ state: "failed" })], queued, 4)).toBe(false);
    expect(hasQueuedSendInFlight([optimistic({ delivery: "steer" })], queued, 4)).toBe(false);
    expect(hasQueuedSendInFlight([optimistic({ destination: "chat" })], queued, 4)).toBe(false);
  });
});

describe("useTurnQueue recallTurn", () => {
  test("withdraws the prompt for real and returns its text and attachments", async () => {
    const turn = fakeTurn({ prompt: "fix the login bug", resources: [file], version: 4 });
    let current = queueSnapshot([turn], 5);
    const requests: unknown[] = [];
    const client = fakeClient({
      getQueue: async () => current,
      editQueueItem: async (_ws, _session, turnId, request) => {
        requests.push({ turnId, ...request });
        current = queueSnapshot([], 6);
        return mutationResponse([], 6, draftFor(turn, 3));
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
      undefined,
    );
    await flush();
    let result = null as Awaited<ReturnType<NonNullable<UseTurnQueueResult["recallTurn"]>>> | null;
    await flushing(async () => {
      result = await hook.result.current.recallTurn!(turn.id, { expectedDraftRevision: 2 });
    });
    expect(result).toMatchObject({
      status: "recalled",
      draft: { text: "fix the login bug", resources: [file], sourceTurnId: turn.id },
    });
    expect(requests).toEqual([
      expect.objectContaining({
        turnId: turn.id,
        expectedTurnVersion: 4,
        expectedDraftRevision: 2,
        replaceDraft: false,
      }),
    ]);
    expect(hook.result.current.queue).toEqual([]);
    expect(hook.result.current.mutationError).toBeNull();
    await hook.unmount();
  });

  test("losing the race to the agent is a quiet already_sent", async () => {
    const turn = fakeTurn({ prompt: "already taken" });
    let current = queueSnapshot([turn], 5);
    const client = fakeClient({
      getQueue: async () => current,
      editQueueItem: async () => {
        // The agent claimed the prompt first.
        current = queueSnapshot([], 6);
        throw promptStartedConflict();
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
      undefined,
    );
    await flush();
    let result = null as unknown;
    await flushing(async () => {
      result = await hook.result.current.recallTurn!(turn.id, { expectedDraftRevision: 0 });
    });
    expect(result).toEqual({ status: "already_sent" });
    expect(hook.result.current.mutationError).toBeNull();
    expect(hook.result.current.queue).toEqual([]);
    await hook.unmount();
  });

  test("a failure while the prompt still waits keeps it queued and reports it", async () => {
    const turn = fakeTurn({ prompt: "still waiting" });
    const current = queueSnapshot([turn], 5);
    const client = fakeClient({
      getQueue: async () => current,
      editQueueItem: async () => {
        throw new OpenGeniApiError(
          409,
          JSON.stringify({ error: { status: 409, code: "DRAFT_CHANGED", message: "changed" } }),
          { mutation: true },
        );
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
      undefined,
    );
    await flush();
    let result = null as unknown;
    await flushing(async () => {
      result = await hook.result.current.recallTurn!(turn.id, { expectedDraftRevision: 0 });
    });
    expect(result).toEqual({ status: "failed" });
    expect(hook.result.current.queue.map((item) => item.id)).toEqual([turn.id]);
    expect(hook.result.current.mutationError).not.toBeNull();
    await hook.unmount();
  });
});

type RecallComposer = NonNullable<Parameters<typeof useQueuedPromptRecall>[0]["composer"]>;

function recallComposer(overrides: Partial<RecallComposer> = {}): RecallComposer & {
  applied: ComposerDraft[];
  values: string[];
} {
  const applied: ComposerDraft[] = [];
  const values: string[] = [];
  return {
    value: "",
    setValue: (value) => values.push(value),
    hasDraftContent: () => false,
    draftRevision: 7,
    draftLoading: false,
    draftPersistence: "durable",
    applyDraft: (draft) => applied.push(draft),
    sending: false,
    optimisticMessages: [],
    ...overrides,
    applied,
    values,
  };
}

function recallQueue(
  turns: SessionTurn[],
  recallTurn: NonNullable<UseTurnQueueResult["recallTurn"]>,
): Pick<UseTurnQueueResult, "queue" | "snapshot" | "mutationFor" | "recallTurn"> {
  return { queue: turns, snapshot: queueSnapshot(turns), mutationFor: () => null, recallTurn };
}

describe("useQueuedPromptRecall", () => {
  test("applies the withdrawn prompt, attachments included, to the composer", async () => {
    const turn = fakeTurn({ prompt: "with a file", resources: [file] });
    const calls: unknown[] = [];
    const composer = recallComposer();
    const hook = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([turn], async (turnId, options) => {
            calls.push({ turnId, ...options });
            return { status: "recalled", draft: draftFor(turn, 8) };
          }),
          composer,
          subjectId: ME,
        }),
      undefined,
    );
    expect(hook.result.current).toMatchObject({ available: true, turnId: turn.id });
    let outcome = null as QueuedPromptRecallOutcome | null;
    await flushing(async () => {
      outcome = await hook.result.current!.recall();
    });
    expect(outcome).toBe("recalled");
    expect(calls).toEqual([{ turnId: turn.id, expectedDraftRevision: 7 }]);
    expect(composer.applied).toEqual([
      expect.objectContaining({ text: "with a file", resources: [file] }),
    ]);
    expect(composer.values).toEqual([]);
    await hook.unmount();
  });

  test("never touches the server or the draft when the composer holds content", async () => {
    const turn = fakeTurn();
    let calls = 0;
    const composer = recallComposer({ hasDraftContent: () => true });
    const hook = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([turn], async () => {
            calls += 1;
            return { status: "failed" };
          }),
          composer,
        }),
      undefined,
    );
    let outcome = null as QueuedPromptRecallOutcome | null;
    await flushing(async () => {
      outcome = await hook.result.current!.recall();
    });
    expect(outcome).toBe("unavailable");
    expect(calls).toBe(0);
    expect(composer.applied).toEqual([]);
    await hook.unmount();
  });

  test("the race leaves the composer as it was", async () => {
    const turn = fakeTurn();
    const composer = recallComposer();
    const hook = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([turn], async () => ({ status: "already_sent" })),
          composer,
        }),
      undefined,
    );
    let outcome = null as QueuedPromptRecallOutcome | null;
    await flushing(async () => {
      outcome = await hook.result.current!.recall();
    });
    expect(outcome).toBe("already_sent");
    expect(composer.applied).toEqual([]);
    expect(composer.values).toEqual([]);
    await hook.unmount();
  });

  test("text typed while the withdraw ran is kept after the recalled prompt", async () => {
    const turn = fakeTurn({ prompt: "recalled" });
    const composer = recallComposer({ value: "typed meanwhile" });
    const hook = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([turn], async () => ({
            status: "recalled",
            draft: draftFor(turn, 8),
          })),
          composer: { ...composer, hasDraftContent: () => false },
        }),
      undefined,
    );
    await flushing(async () => {
      await hook.result.current!.recall();
    });
    expect(composer.applied).toHaveLength(1);
    expect(composer.values).toEqual(["recalled\ntyped meanwhile"]);
    await hook.unmount();
  });

  test("Up right after sending waits for the new prompt instead of taking an older one", async () => {
    const older = fakeTurn({ id: "older" });
    let calls = 0;
    const recallTurn = async () => {
      calls += 1;
      return { status: "failed" as const };
    };
    const sending = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([older], recallTurn),
          composer: recallComposer({ sending: true }),
        }),
      undefined,
    );
    expect(sending.result.current).toMatchObject({ available: false, turnId: null });
    await flushing(async () => {
      expect(await sending.result.current!.recall()).toBe("unavailable");
    });
    await sending.unmount();
    const landing = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([older], recallTurn),
          composer: recallComposer({
            optimisticMessages: [optimistic({ state: "queued", turnId: "newer" })],
          }),
        }),
      undefined,
    );
    expect(landing.result.current).toMatchObject({ available: false, turnId: null });
    await flushing(async () => {
      expect(await landing.result.current!.recall()).toBe("unavailable");
    });
    expect(calls).toBe(0);
    await landing.unmount();
    const newer = fakeTurn({ id: "newer" });
    const landed = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([older, newer], recallTurn),
          composer: recallComposer({
            optimisticMessages: [optimistic({ state: "queued", turnId: "newer" })],
          }),
        }),
      undefined,
    );
    expect(landed.result.current).toMatchObject({ available: true, turnId: "newer" });
    await landed.unmount();
  });

  test("is off without durable drafts, and unavailable with nothing waiting", async () => {
    const disabled = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([fakeTurn()], async () => ({ status: "failed" })),
          composer: recallComposer({ draftPersistence: "disabled" }),
        }),
      undefined,
    );
    expect(disabled.result.current).toBeUndefined();
    await disabled.unmount();
    const idle = await renderHook(
      () =>
        useQueuedPromptRecall({
          queue: recallQueue([], async () => ({ status: "failed" })),
          composer: recallComposer(),
        }),
      undefined,
    );
    expect(idle.result.current).toMatchObject({ available: false, turnId: null });
    await idle.unmount();
  });
});

describe("composer Up-arrow recall", () => {
  function delivery(value: string): Composer.ComposerDelivery {
    return {
      value,
      setValue: () => {},
      send: async () => true,
      steer: async () => true,
      sending: false,
      canSend: value.trim().length > 0,
      error: null,
      clearError: () => {},
    };
  }

  async function mountComposer(
    value: string,
    queuedRecall: ComposerQueuedRecall,
    options: { withPalette?: boolean } = {},
  ): Promise<HTMLTextAreaElement> {
    function Harness() {
      const controller = Composer.useChatComposerController({
        delivery: delivery(value),
        queuedRecall,
        ...(options.withPalette ? { commandContext } : {}),
      });
      return (
        <Composer.Root controller={controller}>
          {options.withPalette ? <Composer.CommandPalette /> : null}
          <Composer.Input />
          <Composer.Status />
        </Composer.Root>
      );
    }
    mounted = await renderComponent(<Harness />);
    return mounted.container.querySelector("textarea")!;
  }

  async function pressUp(
    textarea: HTMLTextAreaElement,
    init: KeyboardEventInit = {},
  ): Promise<KeyboardEvent> {
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    return event;
  }

  function fakeRecall(outcome: QueuedPromptRecallOutcome, available = true) {
    const recall = { calls: 0 };
    const value: ComposerQueuedRecall = {
      available,
      turnId: available ? "turn" : null,
      recall: async () => {
        recall.calls += 1;
        return outcome;
      },
    };
    return { recall, value };
  }

  test("Up in an empty composer recalls and suppresses caret movement", async () => {
    const { recall, value } = fakeRecall("recalled");
    const textarea = await mountComposer("", value);
    const event = await pressUp(textarea);
    expect(recall.calls).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a mounted but closed command palette does not block recall", async () => {
    const { recall, value } = fakeRecall("recalled");
    const textarea = await mountComposer("", value, { withPalette: true });
    const event = await pressUp(textarea);
    expect(recall.calls).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("Up with text keeps normal caret movement", async () => {
    const { recall, value } = fakeRecall("recalled");
    const textarea = await mountComposer("first\nsecond", value);
    textarea.setSelectionRange(0, 0);
    const event = await pressUp(textarea);
    expect(recall.calls).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  test("Shift+Up and an empty queue keep normal behaviour", async () => {
    const { recall, value } = fakeRecall("recalled");
    const textarea = await mountComposer("", value);
    expect((await pressUp(textarea, { shiftKey: true })).defaultPrevented).toBe(false);
    expect(recall.calls).toBe(0);
    await mounted?.unmount();
    mounted = null;
    const idle = fakeRecall("recalled", false);
    const idleTextarea = await mountComposer("", idle.value);
    expect((await pressUp(idleTextarea)).defaultPrevented).toBe(false);
    expect(idle.recall.calls).toBe(0);
  });

  test("a prompt the agent already took shows a quiet, announced notice", async () => {
    const { value } = fakeRecall("already_sent");
    const textarea = await mountComposer("", value);
    await pressUp(textarea);
    await flush();
    const notice = mounted?.container.querySelector('[role="status"]');
    expect(notice?.textContent).toBe("Already sent");
    expect(textarea.value).toBe("");
  });

  test("a second Up while the first withdraw runs does not withdraw twice", async () => {
    let calls = 0;
    let release: (outcome: QueuedPromptRecallOutcome) => void = () => {};
    const value: ComposerQueuedRecall = {
      available: true,
      turnId: "turn",
      recall: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const textarea = await mountComposer("", value);
    await pressUp(textarea);
    await pressUp(textarea);
    expect(calls).toBe(1);
    await act(async () => {
      release("already_sent");
      await Promise.resolve();
    });
    await pressUp(textarea);
    expect(calls).toBe(2);
  });

  test("the recalled prompt lands with the caret at its end", async () => {
    const recalledText = "first line\nsecond line";
    let setText: (text: string) => void = () => {};
    function Harness() {
      const [text, setTextState] = useState("");
      setText = setTextState;
      const controller = Composer.useChatComposerController({
        delivery: { ...delivery(text), setValue: setTextState },
        queuedRecall: {
          available: text.length === 0,
          turnId: "turn",
          recall: async () => {
            setText(recalledText);
            return "recalled";
          },
        },
      });
      return (
        <Composer.Root controller={controller}>
          <Composer.Input />
        </Composer.Root>
      );
    }
    mounted = await renderComponent(<Harness />);
    const textarea = mounted.container.querySelector("textarea")!;
    await pressUp(textarea);
    await flush();
    expect(textarea.value).toBe(recalledText);
    expect(textarea.selectionStart).toBe(recalledText.length);
    expect(textarea.selectionEnd).toBe(recalledText.length);
  });
});
