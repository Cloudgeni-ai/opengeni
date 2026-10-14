import { describe, expect, test } from "bun:test";
import type { NewSessionDraft, OpenGeniClient, SaveNewSessionDraftRequest } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useState } from "react";

import {
  actRun,
  flush,
  registerDom,
  renderHook,
} from "../../../../packages/react/test/render-hook";
import { useNewSessionDraft, type NewSessionDraftEditable } from "./use-new-session-draft";

registerDom();

const WORKSPACE = "00000000-0000-4000-8000-0000000000a1";
const FAST = { delaysMs: [5, 5], reconnectIntervalMs: 20 };

type DraftClient = Pick<OpenGeniClient, "getNewSessionDraft" | "saveNewSessionDraft" | "getFile">;

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
