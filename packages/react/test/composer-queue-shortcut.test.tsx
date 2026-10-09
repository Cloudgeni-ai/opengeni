import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { checkoutQueueDraft, latestEditableQueuedTurn } from "../src/components/queue-draft-policy";
import {
  useComposer,
  type ComposerControllerState,
  type ComposerState,
} from "../src/hooks/use-composer";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import { useTurnQueue } from "../src/hooks/use-turn-queue";
import type { UseFileAttachmentsResult } from "../src/hooks/use-file-attachments";
import { fakeClient, fakeTurn, WORKSPACE_ID } from "./fake-client";
import {
  flush,
  registerDom,
  renderComponent,
  renderHook,
  type RenderedComponent,
} from "./render-hook";
import {
  OpenGeniApiError,
  type ComposerDraft,
  type DraftTimelineAnnotation,
  type ResourceRef,
  type SaveComposerDraftRequest,
  type SessionQueueSnapshot,
} from "@opengeni/sdk";

registerDom();
let mounted: RenderedComponent | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function composer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "",
    setValue: () => {},
    hasDraftContent: () => false,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: false,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 7,
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

const older = fakeTurn({ id: "older", createdAt: "2026-10-09T10:00:00.000Z" });
const newest = fakeTurn({ id: "newest", createdAt: "2026-10-09T11:00:00.000Z" });
const immutable = fakeTurn({
  ...newest,
  id: "immutable",
  personalResources: {
    mode: "once",
    context: "workspace_shared",
    resourceCount: 1,
    resourceKinds: ["variable_set"],
    sharedOutputWarningVersion: 1,
  },
});

function note(text: string): DraftTimelineAnnotation {
  return {
    id: crypto.randomUUID(),
    source: {
      kind: "user_message",
      eventId: crypto.randomUUID(),
      eventType: "user.message",
      sequence: 2,
      turnId: null,
      startOffset: 0,
      endOffset: 5,
      contextBefore: "",
      contextAfter: " world",
    },
    quote: "hello",
    note: text,
  };
}

function queue(overrides: Partial<UseTurnQueueResult> = {}): UseTurnQueueResult {
  return {
    snapshot: null,
    queue: [newest, older],
    pendingInputs: [],
    pendingInputAttachment: null,
    activePersonalConnections: [],
    effectiveControl: null,
    stoppingPreviousAttempt: false,
    loading: false,
    error: null,
    refresh: async () => {},
    moveTurn: async () => true,
    editTurn: async () => null,
    steerTurn: async () => true,
    removeTurn: async () => true,
    pendingByTurn: {},
    mutationFor: () => null,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
    ...overrides,
  };
}

async function press(input: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "ArrowUp",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (input.disabled) return event;
  await act(async () => {
    input.focus();
    input.dispatchEvent(event);
  });
  return event;
}

/** Native hooks and production composer; only the HTTP boundary is simulated. */
async function nativeCheckoutFixture(
  failure = new OpenGeniApiError(504, "Edit response lost", { outcomeUnknown: true }),
  replayFailure = failure,
) {
  const sessionId = crypto.randomUUID();
  const turn = { ...newest, sessionId };
  const base = await fakeClient({}).getComposerDraft(WORKSPACE_ID, sessionId);
  const queuedNote = note("Keep queued note");
  const queuedResource: ResourceRef = { kind: "file", fileId: crypto.randomUUID() };
  const receipt: ComposerDraft = {
    ...base,
    text: "Withdrawn queued prompt",
    resources: [queuedResource],
    annotations: [queuedNote],
    revision: 1,
    sourceTurnId: turn.id,
    sourceTurnVersion: turn.version,
  };
  let serverDraft = base;
  let readFailure: Error | null = null;
  let live!: ComposerControllerState;
  let turns!: UseTurnQueueResult;
  let rejectFirst!: (cause: Error) => void;
  const keys: string[] = [];
  const saves: SaveComposerDraftRequest[] = [];
  let localResources: ResourceRef[] = [];
  const snapshot = (): SessionQueueSnapshot => ({
    version: serverDraft.sourceTurnId ? 2 : 1,
    items: serverDraft.sourceTurnId ? [] : [turn],
    pendingInputs: [],
    pendingInputAttachment: null,
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    effectiveControl: {
      state: "active",
      directState: "active",
      controlVersion: 1,
      controlEtag: "control-1",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
  });
  const client = fakeClient({
    getQueue: async () => snapshot(),
    getComposerDraft: async () => {
      if (readFailure) throw readFailure;
      return serverDraft;
    },
    editQueueItem: async (_workspace, _session, _turn, input) => {
      keys.push(input.clientEventId);
      if (keys.length > 1) throw replayFailure;
      return await new Promise((_resolve, reject) => {
        rejectFirst = reject;
      });
    },
    saveComposerDraft: async (_workspace, _session, input) => {
      saves.push(input);
      serverDraft = { ...serverDraft, ...input, revision: input.expectedRevision + 1 };
      return serverDraft;
    },
  });
  function Harness() {
    live = useComposer(sessionId, {
      client,
      workspaceId: WORKSPACE_ID,
      events: [],
      sendExtras: () => ({ resources: localResources }),
    });
    turns = useTurnQueue(sessionId, { client, workspaceId: WORKSPACE_ID, events: [] });
    return <ChatComposer composer={live} queue={turns} />;
  }
  mounted = await renderComponent(<Harness />);
  return {
    get composer() {
      return live;
    },
    get queue() {
      return turns;
    },
    get serverDraft() {
      return serverDraft;
    },
    receipt,
    queuedNote,
    queuedResource,
    saves,
    keys,
    input: mounted.container.querySelector("textarea")!,
    observeReceipt: () => {
      serverDraft = receipt;
    },
    failReads: (cause: Error | null) => {
      readFailure = cause;
    },
    addResources: (resources: ResourceRef[]) => {
      localResources = resources;
    },
    failEdit: async () => {
      await act(async () => rejectFirst(failure));
    },
    softRead: async () => {
      await act(async () => window.dispatchEvent(new Event("pageshow")));
    },
  };
}

describe("queued-message Arrow Up", () => {
  test("lost native Edit and replay receipts reconcile the advanced draft before autosave", async () => {
    const fixture = await nativeCheckoutFixture();
    const localNote = note("New local note");
    const localResource: ResourceRef = { kind: "file", fileId: crypto.randomUUID() };
    await press(fixture.input);
    fixture.observeReceipt();
    await act(async () => {
      fixture.addResources([localResource]);
      fixture.composer.addAnnotation!(localNote);
    });
    await fixture.softRead();
    expect(fixture.composer.draftRevision).toBe(1);
    expect(fixture.composer.value).toBe("");
    await act(async () => fixture.composer.reloadDraft());
    expect(fixture.composer.value).toBe("");
    expect(fixture.composer.annotations).toEqual([localNote]);
    await flush(600);
    expect(fixture.saves).toHaveLength(0);
    await fixture.failEdit();
    expect(fixture.keys).toHaveLength(2);
    expect(fixture.keys[0]).toBe(fixture.keys[1]);
    expect(fixture.queue.mutationError).not.toBeNull();
    expect(fixture.composer.draftCheckoutBlocked).toBe(false);
    expect(fixture.composer.value).toBe(fixture.receipt.text);
    expect(fixture.composer.annotations).toEqual([fixture.queuedNote, localNote]);
    await flush(600);
    expect(fixture.saves).toHaveLength(1);
    expect(fixture.saves[0]).toMatchObject({
      expectedRevision: 1,
      text: fixture.receipt.text,
      resources: [fixture.queuedResource, localResource],
      annotations: [fixture.queuedNote, localNote],
    });
    expect(fixture.serverDraft.text).toBe(fixture.receipt.text);
  });

  test("lost receipts preserve local edits and removals after checkout hydration", async () => {
    const fixture = await nativeCheckoutFixture();
    const localNote = note("Keep replacement local note");
    await press(fixture.input);
    fixture.observeReceipt();
    await fixture.softRead();
    expect(fixture.composer.value).toBe(fixture.receipt.text);
    await act(async () => {
      fixture.composer.setValue("Edited withdrawn prompt");
      fixture.composer.removeAnnotation!(fixture.queuedNote.id);
      fixture.composer.addAnnotation!(localNote);
      fixture.composer.removeRestoredResource(0);
    });
    await fixture.failEdit();
    expect(fixture.composer.draftCheckoutBlocked).toBe(false);
    expect(fixture.composer.value).toBe("Edited withdrawn prompt");
    expect(fixture.composer.restoredResources).toEqual([]);
    expect(fixture.composer.annotations).toEqual([localNote]);
    await flush(600);
    expect(fixture.saves).toHaveLength(1);
    expect(fixture.saves[0]).toMatchObject({
      expectedRevision: 1,
      text: "Edited withdrawn prompt",
      resources: [],
      annotations: [localNote],
    });
  });

  test("a definite native rejection releases writes without losing local notes or resources", async () => {
    const fixture = await nativeCheckoutFixture(
      new OpenGeniApiError(409, "Prompt already started", { outcomeUnknown: false }),
    );
    const localNote = note("Keep local note");
    const localResource: ResourceRef = { kind: "file", fileId: crypto.randomUUID() };
    await press(fixture.input);
    await act(async () => {
      fixture.addResources([localResource]);
      fixture.composer.addAnnotation!(localNote);
      fixture.composer.setValue("Keep local text");
    });
    await fixture.failEdit();
    expect(fixture.keys).toHaveLength(1);
    expect(fixture.composer.draftCheckoutBlocked).toBe(false);
    expect(fixture.composer.canSend).toBe(true);
    await flush(600);
    expect(fixture.saves).toHaveLength(1);
    expect(fixture.saves[0]).toMatchObject({
      expectedRevision: 0,
      text: "Keep local text",
      resources: [localResource],
      annotations: [localNote],
    });
  });

  test("uncertain Edit stays fenced across unchanged reads and conflict actions, then recovers", async () => {
    const fixture = await nativeCheckoutFixture(
      new OpenGeniApiError(504, "Edit response lost", { outcomeUnknown: true }),
      new OpenGeniApiError(403, "Replay refused", { outcomeUnknown: false }),
    );
    const localNote = note("Keep intervening note");
    const laterNote = note("Keep later note");
    const localResource: ResourceRef = { kind: "file", fileId: crypto.randomUUID() };
    await press(fixture.input);
    await act(async () => {
      fixture.addResources([localResource]);
      fixture.composer.addAnnotation!(localNote);
      fixture.composer.setValue("Host-written local text");
    });
    await fixture.failEdit();
    expect(fixture.composer.draftCheckoutBlocked).toBe(true);
    expect(fixture.composer.draftConflict).not.toBeNull();
    expect(fixture.input.disabled).toBe(false);
    expect(mounted!.container.textContent).toContain("Retry draft sync");
    expect(mounted!.container.textContent).not.toContain("Keep mine");
    await act(async () => {
      fixture.composer.clearError();
      await fixture.composer.resolveDraftConflict("keep_mine");
      await fixture.composer.resolveDraftConflict("use_remote");
      await fixture.composer.reloadDraft();
      fixture.composer.addAnnotation!(laterNote);
      expect(await fixture.composer.send()).toBe(false);
      expect(await fixture.composer.steer()).toBe(false);
      expect(await checkoutQueueDraft(fixture.composer, fixture.queue, newest.id, true)).toBe(
        false,
      );
    });
    await flush(600);
    expect(fixture.keys).toHaveLength(2);
    expect(fixture.saves).toHaveLength(0);
    expect(fixture.composer.canSend).toBe(false);
    expect(fixture.composer.draftConflict).not.toBeNull();
    fixture.observeReceipt();
    const retry = [...mounted!.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry draft sync",
    )!;
    await act(async () => retry.click());
    expect(fixture.composer.draftCheckoutBlocked).toBe(false);
    expect(fixture.composer.draftConflict).toBeNull();
    expect(fixture.composer.canSend).toBe(true);
    expect(fixture.composer.value).toBe(`${fixture.receipt.text}\n\nHost-written local text`);
    expect(fixture.composer.annotations).toEqual([fixture.queuedNote, localNote, laterNote]);
    await flush(600);
    expect(fixture.saves).toHaveLength(1);
    expect(fixture.saves[0]).toMatchObject({
      expectedRevision: 1,
      resources: [fixture.queuedResource, localResource],
      annotations: [fixture.queuedNote, localNote, laterNote],
    });
  });

  test("a failed reconciliation read cannot release an uncertain checkout or lose its shadow", async () => {
    const fixture = await nativeCheckoutFixture();
    const localNote = note("Keep local note through failed read");
    await press(fixture.input);
    await act(async () => {
      fixture.composer.addAnnotation!(localNote);
      fixture.composer.setValue("Keep local text");
    });
    await fixture.failEdit();
    fixture.failReads(new Error("Draft read failed"));
    await act(async () => fixture.composer.reloadDraft());
    await flush(600);
    expect(fixture.composer.draftCheckoutBlocked).toBe(true);
    expect(fixture.composer.canSend).toBe(false);
    expect(fixture.saves).toHaveLength(0);
    expect(fixture.composer.value).toBe("Keep local text");
    expect(fixture.composer.annotations).toEqual([localNote]);
    fixture.failReads(null);
    fixture.observeReceipt();
    await act(async () => fixture.composer.reloadDraft());
    expect(fixture.composer.draftCheckoutBlocked).toBe(false);
    expect(fixture.composer.error).toBeNull();
    expect(fixture.composer.annotations).toEqual([fixture.queuedNote, localNote]);
    expect(fixture.composer.restoredResources).toEqual([fixture.queuedResource]);
    await flush(600);
    expect(fixture.saves).toHaveLength(1);
    expect(fixture.saves[0]?.expectedRevision).toBe(1);
  });

  test("disabled composers cannot check out a queued message", async () => {
    let calls = 0;
    mounted = await renderComponent(
      <ChatComposer
        disabled
        composer={composer()}
        queue={queue({
          editTurn: async () => {
            calls++;
            return null;
          },
        })}
      />,
    );
    await press(mounted.container.querySelector("textarea")!);
    expect(calls).toBe(0);
  });

  for (const status of ["uploading", "ready", "failed"] as const) {
    test(`preserves ${status} attachments even when draft refs have no resources yet`, async () => {
      let calls = 0;
      const attachments = {
        attachments: [
          { id: "upload", name: "notes.txt", contentType: "text/plain", sizeBytes: 10, status },
        ],
        readyResources: [],
        uploading: status === "uploading",
        hasUnresolved: status !== "ready",
        addFiles: () => {},
        addFromPaste: () => {},
        restoreReadyFiles: () => {},
        retry: () => {},
        retainPreview: () => undefined,
        remove: () => {},
        removeReadyFiles: () => {},
        clear: () => {},
      } satisfies UseFileAttachmentsResult;
      mounted = await renderComponent(
        <ChatComposer
          composer={composer()}
          attachments={attachments}
          queue={queue({
            editTurn: async () => {
              calls++;
              return null;
            },
          })}
        />,
      );
      expect((await press(mounted.container.querySelector("textarea")!)).defaultPrevented).toBe(
        false,
      );
      expect(calls).toBe(0);
    });
  }

  test("slash palette navigation takes precedence over queue recall", async () => {
    let calls = 0;
    mounted = await renderComponent(
      <ChatComposer
        composer={composer({ value: "/" })}
        queue={queue({
          editTurn: async () => {
            calls++;
            return null;
          },
        })}
      />,
    );
    const input = mounted.container.querySelector("textarea")!;
    await press(input);
    expect(input.value).toBe("/");
    expect(calls).toBe(0);
  });

  test("selects by creation time, ignoring noneditable turns and execution position", () => {
    expect(latestEditableQueuedTurn([newest, older])?.id).toBe("newest");
    expect(latestEditableQueuedTurn([newest, fakeTurn({ source: "goal" })])?.id).toBe("newest");
    expect(latestEditableQueuedTurn([fakeTurn({ status: "running" })])).toBeUndefined();
    expect(latestEditableQueuedTurn([])).toBeUndefined();
  });

  test("skips immutable once-attached prompts for the most recent editable human/API prompt", () => {
    expect(latestEditableQueuedTurn([immutable, older])?.id).toBe("older");
    expect(latestEditableQueuedTurn([older, { ...immutable, source: "api" }])?.id).toBe("older");
    expect(latestEditableQueuedTurn([immutable, { ...immutable, id: "other" }])).toBeUndefined();
  });

  test("leaves Arrow Up alone when all queued prompts are immutable", async () => {
    let calls = 0;
    mounted = await renderComponent(
      <ChatComposer
        composer={composer()}
        queue={queue({
          queue: [immutable],
          editTurn: async () => {
            calls++;
            return null;
          },
        })}
      />,
    );
    expect((await press(mounted.container.querySelector("textarea")!)).defaultPrevented).toBe(
      false,
    );
    expect(calls).toBe(0);
  });

  test("deferred checkout fences autosave across a soft read, preserves local edits, then saves on its receipt", async () => {
    const sessionId = crypto.randomUUID();
    const base = await fakeClient({}).getComposerDraft(WORKSPACE_ID, sessionId);
    const queuedNote = note("Queued note");
    const addedNote = note("New timeline note");
    const receipt: ComposerDraft = {
      ...base,
      text: "Queued message",
      resources: [{ kind: "file", fileId: crypto.randomUUID() }],
      annotations: [queuedNote],
      reasoningEffort: "high",
      revision: 1,
      sourceTurnId: newest.id,
      sourceTurnVersion: newest.version,
    };
    let serverDraft = base;
    const saves: SaveComposerDraftRequest[] = [];
    const client = fakeClient({
      getComposerDraft: async () => serverDraft,
      saveComposerDraft: async (_workspaceId, _sessionId, input) => {
        saves.push(input);
        serverDraft = { ...serverDraft, ...input, revision: input.expectedRevision + 1 };
        return serverDraft;
      },
    });
    let live!: ComposerControllerState;
    let settle!: (draft: ComposerDraft | null) => void;
    const turns = queue({
      editTurn: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    });
    function Harness() {
      live = useComposer(sessionId, { client, workspaceId: WORKSPACE_ID, events: [] });
      return <ChatComposer composer={live} queue={turns} />;
    }
    mounted = await renderComponent(<Harness />);
    const input = mounted.container.querySelector("textarea")!;
    await press(input);
    expect(input.disabled).toBe(true);
    await act(async () => {
      live.addAnnotation!(addedNote);
      live.setValue("New host-written text");
      live.setModel("local-model");
    });
    await act(async () => {
      serverDraft = receipt;
      // The same soft-refresh path used by SSE must advance the OCC base
      // without pretending that its content replaced the dirty local shadow.
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(live.draft).toBe(receipt);
    expect(live.value).toBe("New host-written text");
    expect(live.annotations).toEqual([addedNote]);
    // The checkout response can lag its SSE/read by more than a debounce.
    // Saving this still-unmerged shadow would erase the withdrawn prompt.
    await flush(650);
    expect(saves).toHaveLength(0);
    expect(live.canSend).toBe(false);
    await act(async () => {
      expect(await live.send()).toBe(false);
      expect(await live.steer()).toBe(false);
    });
    await act(async () => {
      settle(receipt);
    });
    expect(input.disabled).toBe(false);
    expect(live.draft).toBe(receipt);
    expect(live.value).toBe("Queued message\n\nNew host-written text");
    expect(live.annotations).toEqual([queuedNote, addedNote]);
    expect(live.restoredResources).toEqual(receipt.resources);
    expect(live.policy).toMatchObject({ model: "local-model", reasoningEffort: "high" });
    await flush(600);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      expectedRevision: receipt.revision,
      text: live.value,
      annotations: [queuedNote, addedNote],
      resources: receipt.resources,
      model: "local-model",
      reasoningEffort: "high",
    });
    expect(live.draftRevision).toBe(2);
  });

  test("failed checkout releases the autosave fence without replacing intervening notes", async () => {
    const sessionId = crypto.randomUUID();
    let serverDraft = await fakeClient({}).getComposerDraft(WORKSPACE_ID, sessionId);
    const addedNote = note("Keep this local note");
    const saves: SaveComposerDraftRequest[] = [];
    const client = fakeClient({
      getComposerDraft: async () => serverDraft,
      saveComposerDraft: async (_workspaceId, _sessionId, input) => {
        saves.push(input);
        serverDraft = { ...serverDraft, ...input, revision: input.expectedRevision + 1 };
        return serverDraft;
      },
    });
    let live!: ComposerControllerState;
    let settle!: (draft: ComposerDraft | null) => void;
    const turns = queue({
      editTurn: (_turn, options) =>
        new Promise((resolve) => {
          options.onFailure?.(false);
          settle = resolve;
        }),
    });
    function Harness() {
      live = useComposer(sessionId, { client, workspaceId: WORKSPACE_ID, events: [] });
      return <ChatComposer composer={live} queue={turns} />;
    }
    mounted = await renderComponent(<Harness />);
    const input = mounted.container.querySelector("textarea")!;
    await press(input);
    await act(async () => {
      live.addAnnotation!(addedNote);
    });
    await flush(650);
    expect(saves).toHaveLength(0);
    await act(async () => {
      settle(null);
    });
    expect(input.disabled).toBe(false);
    expect(live.value).toBe("");
    expect(live.annotations).toEqual([addedNote]);
    expect(live.canSend).toBe(true);
    await flush(600);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ expectedRevision: 0, text: "", annotations: [addedNote] });
  });

  test("a thrown checkout also completes the native autosave lifecycle", async () => {
    const sessionId = crypto.randomUUID();
    const saves: SaveComposerDraftRequest[] = [];
    const base = await fakeClient({}).getComposerDraft(WORKSPACE_ID, sessionId);
    const client = fakeClient({
      saveComposerDraft: async (_workspaceId, _sessionId, input) => {
        saves.push(input);
        return { ...base, ...input, revision: input.expectedRevision + 1 };
      },
    });
    const hook = await renderHook(
      () => useComposer(sessionId, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    try {
      const failure = new OpenGeniApiError(409, "Checkout failed", { outcomeUnknown: false });
      await act(async () => {
        await expect(
          checkoutQueueDraft(
            hook.result.current,
            queue({
              editTurn: async () => {
                throw failure;
              },
            }),
            newest.id,
            false,
          ),
        ).rejects.toBe(failure);
      });
      await act(async () => {
        hook.result.current.setValue("Keep this draft");
      });
      await flush(600);
      expect(saves).toHaveLength(1);
      expect(saves[0]?.text).toBe("Keep this draft");
    } finally {
      await hook.unmount();
    }
  });

  test("an unclassified thrown checkout stays fenced until positive draft reconciliation", async () => {
    const sessionId = crypto.randomUUID();
    const base = await fakeClient({}).getComposerDraft(WORKSPACE_ID, sessionId);
    let serverDraft = base;
    const saves: SaveComposerDraftRequest[] = [];
    const client = fakeClient({
      getComposerDraft: async () => serverDraft,
      saveComposerDraft: async (_workspace, _session, input) => {
        saves.push(input);
        serverDraft = { ...serverDraft, ...input, revision: input.expectedRevision + 1 };
        return serverDraft;
      },
    });
    const hook = await renderHook(
      () => useComposer(sessionId, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    try {
      const failure = new Error("Transport aborted without execution proof");
      await act(async () => {
        await expect(
          checkoutQueueDraft(
            hook.result.current,
            queue({
              editTurn: async () => {
                hook.result.current.setValue("Local text during the request");
                throw failure;
              },
            }),
            newest.id,
            false,
          ),
        ).rejects.toBe(failure);
      });
      await flush(600);
      expect(hook.result.current.draftCheckoutBlocked).toBe(true);
      expect(hook.result.current.canSend).toBe(false);
      expect(saves).toHaveLength(0);
      serverDraft = {
        ...base,
        revision: 1,
        text: "Queued text",
        sourceTurnId: newest.id,
        sourceTurnVersion: newest.version,
      };
      await act(async () => hook.result.current.reloadDraft());
      expect(hook.result.current.value).toBe("Queued text\n\nLocal text during the request");
      expect(hook.result.current.draftCheckoutBlocked).toBe(false);
      await flush(600);
      expect(saves).toHaveLength(1);
      expect(saves[0]?.expectedRevision).toBe(1);
    } finally {
      await hook.unmount();
    }
  });

  test("a blocked old-session checkout cannot fence or overwrite the new session", async () => {
    const firstSessionId = crypto.randomUUID();
    const nextSessionId = crypto.randomUUID();
    const base = await fakeClient({}).getComposerDraft(WORKSPACE_ID, firstSessionId);
    const saves: Array<{ sessionId: string; input: SaveComposerDraftRequest }> = [];
    const client = fakeClient({
      saveComposerDraft: async (_workspace, sessionId, input) => {
        saves.push({ sessionId, input });
        return { ...base, ...input, revision: input.expectedRevision + 1 };
      },
    });
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client, workspaceId: WORKSPACE_ID, events: [] }),
      firstSessionId,
    );
    try {
      let completeOld!: ReturnType<NonNullable<ComposerState["prepareDraftCheckout"]>>;
      await act(async () => {
        completeOld = hook.result.current.prepareDraftCheckout!(newest.id);
        completeOld?.(null);
      });
      expect(hook.result.current.draftCheckoutBlocked).toBe(true);
      await hook.rerender(nextSessionId);
      await act(async () => {
        completeOld?.({ ...base, revision: 1, text: "Old queued prompt" });
        hook.result.current.setValue("New session draft");
      });
      expect(hook.result.current.draftCheckoutBlocked).toBe(false);
      expect(hook.result.current.canSend).toBe(true);
      await flush(600);
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({
        sessionId: nextSessionId,
        input: { text: "New session draft" },
      });
    } finally {
      await hook.unmount();
    }
  });

  test("old-session checkout callbacks cannot suspend or overwrite the new session draft", async () => {
    const firstSessionId = crypto.randomUUID();
    const nextSessionId = crypto.randomUUID();
    const saves: Array<{ sessionId: string; input: SaveComposerDraftRequest }> = [];
    const base = await fakeClient({}).getComposerDraft(WORKSPACE_ID, firstSessionId);
    const client = fakeClient({
      saveComposerDraft: async (_workspaceId, sessionId, input) => {
        saves.push({ sessionId, input });
        return { ...base, ...input, revision: input.expectedRevision + 1 };
      },
    });
    const hook = await renderHook(
      (sessionId: string) =>
        useComposer(sessionId, { client, workspaceId: WORKSPACE_ID, events: [] }),
      firstSessionId,
    );
    try {
      const prepareOld = hook.result.current.prepareDraftCheckout!;
      let completeOld!: ReturnType<typeof prepareOld>;
      await act(async () => {
        completeOld = prepareOld();
      });
      await hook.rerender(nextSessionId);
      await act(async () => {
        completeOld?.({ ...base, revision: 1, text: "Old session prompt" });
        prepareOld()?.(null);
        hook.result.current.setValue("New session draft");
      });
      await flush(600);
      expect(hook.result.current.value).toBe("New session draft");
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({
        sessionId: nextSessionId,
        input: { text: "New session draft" },
      });
    } finally {
      await hook.unmount();
    }
  });

  test("deferred checkout preserves edits and removals after an authoritative draft hydration", async () => {
    const sessionId = crypto.randomUUID();
    const base = await fakeClient({}).getComposerDraft(WORKSPACE_ID, sessionId);
    const queuedNote = note("Remove this queued note");
    const addedNote = note("Keep this new note");
    const receipt: ComposerDraft = {
      ...base,
      text: "Queued message",
      resources: [{ kind: "file", fileId: crypto.randomUUID() }],
      annotations: [queuedNote],
      revision: 1,
      sourceTurnId: newest.id,
      sourceTurnVersion: newest.version,
    };
    let serverDraft = base;
    const client = fakeClient({ getComposerDraft: async () => serverDraft });
    let live!: ComposerControllerState;
    let settle!: (draft: ComposerDraft | null) => void;
    const turns = queue({
      editTurn: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    });
    function Harness() {
      live = useComposer(sessionId, { client, workspaceId: WORKSPACE_ID, events: [] });
      return <ChatComposer composer={live} queue={turns} />;
    }
    mounted = await renderComponent(<Harness />);
    await press(mounted.container.querySelector("textarea")!);
    await act(async () => {
      serverDraft = receipt;
      await live.reloadDraft();
    });
    await act(async () => {
      live.setValue("Edited queued message");
      live.removeAnnotation!(queuedNote.id);
      live.addAnnotation!(addedNote);
      live.removeRestoredResource(0);
    });
    await act(async () => {
      settle(receipt);
    });
    expect(live.draft).toBe(receipt);
    expect(live.value).toBe("Edited queued message");
    expect(live.annotations).toEqual([addedNote]);
    expect(live.restoredResources).toEqual([]);
    expect(live.draftRevision).toBe(receipt.revision);
  });

  test("uses the exact draft revision, never replaces, and applies only a checkout receipt", async () => {
    const calls: unknown[] = [];
    const receipt = { text: "Latest queued message", revision: 8 } as ComposerDraft;
    let applied: ComposerDraft | undefined;
    mounted = await renderComponent(
      <ChatComposer
        composer={composer({
          applyDraft: (draft) => {
            applied = draft;
          },
        })}
        queue={queue({
          editTurn: async (...args) => {
            calls.push(args);
            return receipt;
          },
        })}
      />,
    );
    expect((await press(mounted.container.querySelector("textarea")!)).defaultPrevented).toBe(true);
    expect(calls).toEqual([
      [
        "newest",
        { expectedDraftRevision: 7, replaceDraft: false, onFailure: expect.any(Function) },
      ],
    ]);
    expect(applied).toBe(receipt);
  });

  for (const [name, overrides] of Object.entries({
    text: { value: "draft" },
    whitespace: { value: " " },
    "draft resources, annotations, or source turn": { hasDraftContent: () => true },
    loading: { draftLoading: true },
    saving: { draftSaving: true },
    conflict: { draftConflict: new Error("Conflict") },
    sending: { sending: true },
    "no durable draft": { draftPersistence: "disabled" as const },
  }))
    test(`does not checkout with ${name}`, async () => {
      let calls = 0;
      mounted = await renderComponent(
        <ChatComposer
          composer={composer(overrides)}
          queue={queue({
            editTurn: async () => {
              calls++;
              return null;
            },
          })}
        />,
      );
      expect((await press(mounted.container.querySelector("textarea")!)).defaultPrevented).toBe(
        false,
      );
      expect(calls).toBe(0);
    });

  for (const init of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
  ]) {
    test(`leaves modified/composing/repeated keys alone: ${JSON.stringify(init)}`, async () => {
      let calls = 0;
      mounted = await renderComponent(
        <ChatComposer
          composer={composer()}
          queue={queue({
            editTurn: async () => {
              calls++;
              return null;
            },
          })}
        />,
      );
      expect(
        (await press(mounted.container.querySelector("textarea")!, init)).defaultPrevented,
      ).toBe(false);
      expect(calls).toBe(0);
    });
  }

  test("locks the input during checkout, prevents duplicate requests, and recovers from a lost race", async () => {
    let settle!: (draft: ComposerDraft | null) => void;
    let calls = 0;
    let applies = 0;
    mounted = await renderComponent(
      <ChatComposer
        composer={composer({
          applyDraft: () => {
            applies++;
          },
        })}
        queue={queue({
          editTurn: () => {
            calls++;
            return new Promise((resolve) => {
              settle = resolve;
            });
          },
        })}
      />,
    );
    const input = mounted.container.querySelector("textarea")!;
    await press(input);
    expect(input.disabled).toBe(true);
    await press(input);
    expect(calls).toBe(1);
    await act(async () => {
      settle(null);
    });
    expect(input.disabled).toBe(false);
    expect(applies).toBe(0);
    expect(input.value).toBe("");
  });

  for (const state of [{ queue: [] }, { mutating: true }, { loading: true }]) {
    test(`does nothing with unavailable queue: ${JSON.stringify(state)}`, async () => {
      let calls = 0;
      mounted = await renderComponent(
        <ChatComposer
          composer={composer()}
          queue={queue({
            ...state,
            editTurn: async () => {
              calls++;
              return null;
            },
          })}
        />,
      );
      expect((await press(mounted.container.querySelector("textarea")!)).defaultPrevented).toBe(
        false,
      );
      expect(calls).toBe(0);
    });
  }
});
