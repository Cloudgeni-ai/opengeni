import { describe, expect, test } from "bun:test";
import type { ChatClient } from "@opengeni/sdk";
import type { NewSessionDraft, OpenGeniClient, SaveNewSessionDraftRequest } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useState } from "react";

import {
  actRun,
  flush,
  registerDom,
  renderHook,
} from "../../../../packages/react/test/render-hook";
import {
  useNewSessionDraft,
  type NewSessionDraftEditable,
} from "@opengeni/react/app/lib/use-new-session-draft";

registerDom();

const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const FAST = { delaysMs: [5, 5], reconnectIntervalMs: 20 };

type DraftClient = Pick<
  ChatClient<OpenGeniClient>,
  "getNewSessionDraft" | "saveNewSessionDraft" | "getFile"
>;

function editable(overrides: Partial<NewSessionDraftEditable> = {}): NewSessionDraftEditable {
  return {
    text: "",
    resources: [],
    tools: [],
    toolsProvided: false,
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    options: {},
    ...overrides,
  };
}

function remote(
  revision: number,
  overrides: Partial<NewSessionDraftEditable> = {},
): NewSessionDraft {
  return {
    revision,
    ...editable(overrides),
    selectionHistory: { projects: [] },
    updatedAt: revision === 0 ? null : "2026-10-04T00:00:00.000Z",
  };
}

/** What the API answers while a deploy drain has terminated its database connections. */
function databaseUnavailable(method: "GET" | "PUT" = "GET"): OpenGeniApiError {
  return new OpenGeniApiError(
    503,
    JSON.stringify({
      error: {
        status: 503,
        code: "upstream_unavailable",
        message: "Opengeni is temporarily unavailable. Retry shortly.",
        retryable: true,
        ...(method === "PUT" ? { outcomeUnknown: true } : {}),
        requestId: "ce622307-55da-476b-ac96-785cc499b044",
        details: { code: "DATABASE_UNAVAILABLE" },
      },
    }),
    { mutation: method === "PUT" },
  );
}

function renderDraft(client: DraftClient) {
  return renderHook(
    (props: { client: DraftClient }) => {
      const [value, setValue] = useState(() => editable());
      const draft = useNewSessionDraft({
        client: props.client,
        workspaceId: WORKSPACE,
        value,
        onApplyRemote: setValue,
        restoreReadyFiles: () => {},
        transientRetry: FAST,
      });
      return { draft, value, setValue };
    },
    { client },
  );
}

async function settle(ms = 40) {
  for (let index = 0; index < 4; index += 1) await flush(ms / 4);
}

describe("useNewSessionDraft during a brief outage", () => {
  test("a draft load that recovers within the quiet retries never shows an error", async () => {
    let reads = 0;
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        reads += 1;
        if (reads < 3) throw databaseUnavailable();
        return remote(3, { text: "saved earlier" });
      },
      saveNewSessionDraft: async (_workspace, request) =>
        remote(request.expectedRevision + 1, request),
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    expect(reads).toBe(3);
    expect(hook.result.current.draft.error).toBeNull();
    expect(hook.result.current.draft.unavailable).toBe(false);
    expect(hook.result.current.draft.loading).toBe(false);
    expect(hook.result.current.value.text).toBe("saved earlier");
    await hook.unmount();
  });

  test("a longer outage is reported as unavailable, keeps typed text, and reconnects on its own", async () => {
    let down = true;
    let reads = 0;
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        reads += 1;
        if (down) throw databaseUnavailable();
        return remote(7, { text: "older server text" });
      },
      saveNewSessionDraft: async (_workspace, request) =>
        remote(request.expectedRevision + 1, request),
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    expect(hook.result.current.draft.unavailable).toBe(true);
    expect(hook.result.current.draft.loading).toBe(false);
    const readsWhileDown = reads;
    expect(readsWhileDown).toBeGreaterThanOrEqual(3);

    // The person keeps typing while the notice is up.
    await actRun(() => hook.result.current.setValue(editable({ text: "my new task" })));
    await settle(60);
    expect(reads).toBeGreaterThan(readsWhileDown);
    expect(hook.result.current.draft.unavailable).toBe(true);

    down = false;
    await settle(80);
    expect(hook.result.current.draft.unavailable).toBe(false);
    expect(hook.result.current.draft.error).toBeNull();
    // Reconnecting rebased onto the server revision without replacing the text.
    expect(hook.result.current.value.text).toBe("my new task");
    expect(hook.result.current.draft.revision).toBe(7);
    await hook.unmount();
  });

  test("an untouched composer receives the remote draft once Opengeni is back", async () => {
    let down = true;
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        if (down) throw databaseUnavailable();
        return remote(2, { text: "restored draft" });
      },
      saveNewSessionDraft: async (_workspace, request) =>
        remote(request.expectedRevision + 1, request),
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    expect(hook.result.current.draft.unavailable).toBe(true);
    down = false;
    await settle(80);
    expect(hook.result.current.draft.unavailable).toBe(false);
    expect(hook.result.current.value.text).toBe("restored draft");
    await hook.unmount();
  });

  test("Send's draft save retries an unconfirmed write without applying it twice", async () => {
    const saves: SaveNewSessionDraftRequest[] = [];
    let stored = remote(1, { text: "" });
    let failNext = 2;
    const hook = await renderDraft({
      getNewSessionDraft: async () => stored,
      saveNewSessionDraft: async (_workspace, request) => {
        saves.push(request);
        if (request.expectedRevision !== stored.revision) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({ code: "NEW_SESSION_DRAFT_CONFLICT", message: "changed" }),
          );
        }
        // The first attempt commits but its response is lost to the drain.
        stored = remote(stored.revision + 1, request);
        if (failNext > 0) {
          failNext -= 1;
          throw databaseUnavailable("PUT");
        }
        return stored;
      },
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    await actRun(() => hook.result.current.setValue(editable({ text: "ship it" })));
    const flushed = await actRun(() =>
      hook.result.current.draft.flushForSend(editable({ text: "ship it" })),
    );
    expect(flushed).not.toBeNull();
    expect(stored.text).toBe("ship it");
    expect(flushed!.revision).toBe(stored.revision);
    expect(hook.result.current.draft.error).toBeNull();
    await hook.unmount();
  });

  test("Send after a reconnect never saves over a draft from another device it did not show", async () => {
    const saves: [number, string][] = [];
    let stored = remote(1, { text: "" });
    let down = false;
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        if (down) throw databaseUnavailable();
        return stored;
      },
      saveNewSessionDraft: async (_workspace, request) => {
        saves.push([request.expectedRevision, request.text]);
        if (down) throw databaseUnavailable("PUT");
        if (request.expectedRevision !== stored.revision) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({ code: "NEW_SESSION_DRAFT_CONFLICT", message: "changed" }),
          );
        }
        stored = remote(stored.revision + 1, request);
        return stored;
      },
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    down = true;
    await actRun(() => hook.result.current.setValue(editable({ text: "sent from here" })));
    await settle(700);
    expect(hook.result.current.draft.unavailable).toBe(true);
    // While this device is cut off, the person's phone saves a draft.
    stored = remote(3, { text: "typed on my phone" });
    down = false;
    await settle(80);
    expect(hook.result.current.draft.unavailable).toBe(false);
    expect(hook.result.current.value.text).toBe("sent from here");

    const flushed = await actRun(() =>
      hook.result.current.draft.flushForSend(editable({ text: "sent from here" })),
    );
    // Send goes ahead from the draft this device last saw, without saving.
    expect(flushed?.revision).toBe(1);
    expect(saves.filter(([revision]) => revision === 3)).toEqual([]);
    expect(stored.text).toBe("typed on my phone");

    // The create kept the phone's draft; the form now shows it.
    const acknowledged = await actRun(() =>
      hook.result.current.draft.acknowledgeConsumed(flushed!),
    );
    expect(acknowledged).toEqual({ kind: "followed" });
    expect(hook.result.current.value.text).toBe("typed on my phone");
    await hook.unmount();
  });

  test("a form emptied as it sent follows a newer draft the create kept, never blanking it", async () => {
    const saves: [number, string][] = [];
    let stored = remote(1, { text: "" });
    const hook = await renderDraft({
      getNewSessionDraft: async () => stored,
      saveNewSessionDraft: async (_workspace, request) => {
        saves.push([request.expectedRevision, request.text]);
        if (request.expectedRevision !== stored.revision) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({ code: "NEW_SESSION_DRAFT_CONFLICT", message: "changed" }),
          );
        }
        stored = remote(stored.revision + 1, request);
        return stored;
      },
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    await actRun(() => hook.result.current.setValue(editable({ text: "hi" })));
    const flushed = await actRun(() =>
      hook.result.current.draft.flushForSend(editable({ text: "hi" })),
    );
    expect(flushed?.revision).toBe(2);
    // The create clears the draft to its seed; then the laptop saves a draft.
    stored = remote(4, { text: "typed on my laptop" });
    // As mobile does: the box empties as soon as the create is accepted.
    await actRun(() => hook.result.current.setValue(editable()));
    const acknowledged = await actRun(() =>
      hook.result.current.draft.acknowledgeConsumed(flushed!),
    );
    await settle(700);

    expect(acknowledged).toEqual({ kind: "followed" });
    expect(hook.result.current.value.text).toBe("typed on my laptop");
    expect(stored.text).toBe("typed on my laptop");
    expect(saves).toEqual([[1, "hi"]]);
    await hook.unmount();
  });

  test("an emptied form whose post-Send read is slow never autosaves over the kept draft", async () => {
    const saves: [number, string][] = [];
    let stored = remote(1, { text: "" });
    let slowReads = false;
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        const snapshot = stored;
        if (slowReads) await new Promise((resolve) => setTimeout(resolve, 900));
        return snapshot;
      },
      saveNewSessionDraft: async (_workspace, request) => {
        saves.push([request.expectedRevision, request.text]);
        if (request.expectedRevision !== stored.revision) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({ code: "NEW_SESSION_DRAFT_CONFLICT", message: "changed" }),
          );
        }
        stored = remote(stored.revision + 1, request);
        return stored;
      },
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    await actRun(() => hook.result.current.setValue(editable({ text: "hi" })));
    const flushed = await actRun(() =>
      hook.result.current.draft.flushForSend(editable({ text: "hi" })),
    );
    stored = remote(4, { text: "typed on my laptop" });
    slowReads = true;
    // Mobile's order: acknowledge without waiting, then empty the box, with
    // autosave running again while the slow read is still out.
    let acknowledging: Promise<unknown> | null = null;
    await actRun(() => {
      acknowledging = hook.result.current.draft.acknowledgeConsumed(flushed!);
    });
    await actRun(() => hook.result.current.setValue(editable()));
    await settle(1_600);
    await actRun(async () => await acknowledging);
    await settle(700);

    expect(saves).toEqual([[1, "hi"]]);
    expect(stored.text).toBe("typed on my laptop");
    expect(hook.result.current.value.text).toBe("typed on my laptop");
    await hook.unmount();
  });

  test.each([
    { failingReads: 1, follows: true },
    { failingReads: 2, follows: false },
  ])(
    "an emptied form whose post-Send read failed never autosaves over the kept draft (%o)",
    async ({ failingReads, follows }) => {
      const saves: [number, string][] = [];
      let stored = remote(1, { text: "" });
      let failReads = 0;
      const hook = await renderDraft({
        getNewSessionDraft: async () => {
          if (failReads > 0) {
            failReads -= 1;
            // A refusal that is not retried, unlike an outage.
            throw new OpenGeniApiError(400, JSON.stringify({ code: "BAD_REQUEST", message: "no" }));
          }
          return stored;
        },
        saveNewSessionDraft: async (_workspace, request) => {
          saves.push([request.expectedRevision, request.text]);
          if (request.expectedRevision !== stored.revision) {
            // As the server answers: the refusal names the current revision.
            throw new OpenGeniApiError(
              409,
              JSON.stringify({
                code: "NEW_SESSION_DRAFT_CONFLICT",
                message: "changed",
                currentRevision: stored.revision,
              }),
            );
          }
          stored = remote(stored.revision + 1, request);
          return stored;
        },
        getFile: async () => {
          throw new Error("unused");
        },
      });
      await settle();
      await actRun(() => hook.result.current.setValue(editable({ text: "hi" })));
      const flushed = await actRun(() =>
        hook.result.current.draft.flushForSend(editable({ text: "hi" })),
      );
      // The create kept the laptop's newer draft, and the post-Send read fails.
      stored = remote(4, { text: "typed on my laptop" });
      failReads = failingReads;
      // The acknowledgement fails, then the box empties as it does on mobile.
      await actRun(async () => {
        await hook.result.current.draft.acknowledgeConsumed(flushed!).catch(() => null);
      });
      await actRun(() => hook.result.current.setValue(editable()));
      await settle(1_600);

      expect(saves.filter(([, text]) => text === "").every(([revision]) => revision < 4)).toBe(
        true,
      );
      expect(stored.text).toBe("typed on my laptop");
      if (follows) {
        expect(hook.result.current.value.text).toBe("typed on my laptop");
        expect(hook.result.current.draft.error).toBeNull();
      } else {
        // The read that would follow failed too: the form says so.
        expect(hook.result.current.value.text).toBe("");
        expect(hook.result.current.draft.error).not.toBeNull();
      }
      await hook.unmount();
    },
  );

  test("a pick on an emptied form still saves over a newer draft that holds no message", async () => {
    let stored = remote(1, { text: "" });
    const hook = await renderDraft({
      getNewSessionDraft: async () => stored,
      saveNewSessionDraft: async (_workspace, request) => {
        if (request.expectedRevision !== stored.revision) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({
              code: "NEW_SESSION_DRAFT_CONFLICT",
              message: "changed",
              currentRevision: stored.revision,
            }),
          );
        }
        stored = remote(stored.revision + 1, request);
        return stored;
      },
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    // Another device's Send or settings change moved the draft, with no message.
    stored = remote(2, { model: "other-device-model" });
    await actRun(() => hook.result.current.setValue(editable({ model: "my-pick" })));
    await settle(700);

    expect(stored).toMatchObject({ revision: 3, model: "my-pick", text: "" });
    expect(hook.result.current.value.model).toBe("my-pick");
    expect(hook.result.current.draft.conflict).toBeNull();
    await hook.unmount();
  });

  test("an emptied form never saves over a message a reconnect read did not show", async () => {
    const saves: [number, string][] = [];
    let stored = remote(1, { text: "" });
    let down = false;
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        if (down) throw databaseUnavailable();
        return stored;
      },
      saveNewSessionDraft: async (_workspace, request) => {
        saves.push([request.expectedRevision, request.text]);
        if (down) throw databaseUnavailable("PUT");
        if (request.expectedRevision !== stored.revision) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({
              code: "NEW_SESSION_DRAFT_CONFLICT",
              message: "changed",
              currentRevision: stored.revision,
            }),
          );
        }
        stored = remote(stored.revision + 1, request);
        return stored;
      },
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    await actRun(() => hook.result.current.setValue(editable({ text: "hi" })));
    const flushed = await actRun(() =>
      hook.result.current.draft.flushForSend(editable({ text: "hi" })),
    );
    // The create kept the laptop's newer draft; the post-Send read meets an outage.
    stored = remote(4, { text: "typed on my laptop" });
    down = true;
    await actRun(async () => {
      await hook.result.current.draft.acknowledgeConsumed(flushed!).catch(() => null);
    });
    await actRun(() => hook.result.current.setValue(editable()));
    await settle(700);
    down = false;
    await settle(200);
    // A pick on the emptied box after the reconnect.
    await actRun(() => hook.result.current.setValue(editable({ text: "", model: "picked-model" })));
    await settle(1_000);

    expect(saves.filter(([revision, text]) => revision >= 4 && text === "")).toEqual([]);
    expect(stored.text).toBe("typed on my laptop");
    await hook.unmount();
  });

  test("a Send after the post-Send save met another device's draft never saves over it", async () => {
    const saves: [number, string][] = [];
    let stored = remote(1, { text: "" });
    let laptopSavesAfterNextRead = false;
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        const snapshot = stored;
        if (laptopSavesAfterNextRead) {
          laptopSavesAfterNextRead = false;
          await new Promise((resolve) => setTimeout(resolve, 100));
          // The laptop saves its draft right after this read.
          stored = remote(4, { text: "typed on my laptop" });
        }
        return snapshot;
      },
      saveNewSessionDraft: async (_workspace, request) => {
        saves.push([request.expectedRevision, request.text]);
        if (request.expectedRevision !== stored.revision) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({ code: "NEW_SESSION_DRAFT_CONFLICT", message: "changed" }),
          );
        }
        stored = remote(stored.revision + 1, request);
        return stored;
      },
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    await actRun(() => hook.result.current.setValue(editable({ text: "first" })));
    const flushed = await actRun(() =>
      hook.result.current.draft.flushForSend(editable({ text: "first" })),
    );
    // The create cleared the draft to its seed.
    stored = remote(3, { text: "" });
    laptopSavesAfterNextRead = true;
    let acknowledging: Promise<unknown> | null = null;
    await actRun(() => {
      acknowledging = hook.result.current.draft.acknowledgeConsumed(flushed!);
    });
    // The person starts the next message while the acknowledgement reads.
    await actRun(() => hook.result.current.setValue(editable({ text: "nex" })));
    await actRun(async () => await acknowledging);
    await actRun(() => hook.result.current.setValue(editable({ text: "next" })));
    const next = await actRun(() =>
      hook.result.current.draft.flushForSend(editable({ text: "next" })),
    );

    expect(saves.filter(([revision]) => revision === 4)).toEqual([]);
    expect(stored.text).toBe("typed on my laptop");
    expect(next?.revision).toBe(3);
    await hook.unmount();
  });

  test("Send waits for the form's own running save before choosing its draft basis", async () => {
    let stored = remote(1, { text: "" });
    let down = false;
    let hold: Promise<void> | null = null;
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        if (down) throw databaseUnavailable();
        return stored;
      },
      saveNewSessionDraft: async (_workspace, request) => {
        if (down) throw databaseUnavailable("PUT");
        const held = hold;
        hold = null;
        if (held) await held;
        if (request.expectedRevision !== stored.revision) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({ code: "NEW_SESSION_DRAFT_CONFLICT", message: "changed" }),
          );
        }
        stored = remote(stored.revision + 1, request);
        return stored;
      },
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    down = true;
    await actRun(() => hook.result.current.setValue(editable({ text: "hello" })));
    await settle(700);
    stored = remote(3, { text: "typed on my phone" });
    down = false;
    await settle(80);
    expect(hook.result.current.draft.unavailable).toBe(false);
    // The person keeps typing; autosave saves it on top, with a slow reply.
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await actRun(() => hook.result.current.setValue(editable({ text: "hello world" })));
    await settle(700);
    await actRun(() => hook.result.current.setValue(editable({ text: "hello world!" })));
    let sending: Promise<unknown> | null = null;
    await actRun(() => {
      sending = hook.result.current.draft.flushForSend(editable({ text: "hello world!" }));
    });
    await settle();
    release();
    const flushed = (await actRun(async () => await sending)) as { revision: number } | null;

    // The form's own save was the basis, so Send saved on top of it.
    expect(stored.text).toBe("hello world!");
    expect(flushed?.revision).toBe(stored.revision);
    await hook.unmount();
  });

  test("a permanent failure stays an ordinary error", async () => {
    const hook = await renderDraft({
      getNewSessionDraft: async () => {
        throw new OpenGeniApiError(
          403,
          JSON.stringify({ error: { status: 403, code: "forbidden" } }),
        );
      },
      saveNewSessionDraft: async (_workspace, request) =>
        remote(request.expectedRevision + 1, request),
      getFile: async () => {
        throw new Error("unused");
      },
    });
    await settle();
    expect(hook.result.current.draft.error).toBeInstanceOf(OpenGeniApiError);
    expect(hook.result.current.draft.unavailable).toBe(false);
    await hook.unmount();
  });
});
