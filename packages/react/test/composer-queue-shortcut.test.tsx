import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { latestEditableQueuedTurn } from "../src/components/queue-draft-policy";
import {
  useComposer,
  type ComposerControllerState,
  type ComposerState,
} from "../src/hooks/use-composer";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import type { UseFileAttachmentsResult } from "../src/hooks/use-file-attachments";
import { fakeClient, fakeTurn, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";
import type {
  ComposerDraft,
  DraftTimelineAnnotation,
  SaveComposerDraftRequest,
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

describe("queued-message Arrow Up", () => {
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

  test("deferred checkout preserves intervening real composer notes, text and policy, then autosaves on its receipt", async () => {
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
    expect(calls).toEqual([["newest", { expectedDraftRevision: 7, replaceDraft: false }]]);
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
