import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import { latestEditableQueuedTurn } from "../src/components/queue-draft-policy";
import type { ComposerState } from "../src/hooks/use-composer";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import type { UseFileAttachmentsResult } from "../src/hooks/use-file-attachments";
import { fakeTurn } from "./fake-client";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";
import type { ComposerDraft } from "@opengeni/sdk";

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
  await act(async () => {
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
          { id: "upload", filename: "notes.txt", contentType: "text/plain", sizeBytes: 10, status },
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
