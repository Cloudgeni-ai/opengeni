import { describe, expect, test } from "bun:test";
import type {
  FileAsset,
  NewSessionDraft,
  OpenGeniClient,
  SaveNewSessionDraftRequest,
} from "@opengeni/sdk";
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

const WORKSPACE_A = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE_B = "00000000-0000-4000-8000-0000000000b2";

function editable(overrides: Partial<NewSessionDraftEditable> = {}): NewSessionDraftEditable {
  return {
    text: "",
    resources: [],
    tools: [],
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
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
    updatedAt: revision === 0 ? null : "2026-07-20T00:00:00.000Z",
  };
}

function asset(id: string, overrides: Partial<FileAsset> = {}): FileAsset {
  return {
    id,
    workspaceId: WORKSPACE_A,
    status: "ready",
    filename: `${id}.txt`,
    safeFilename: `${id}.txt`,
    contentType: "text/plain",
    sizeBytes: 12,
    sha256: null,
    bucket: "private",
    objectKey: "private",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

type DraftClient = Pick<OpenGeniClient, "getNewSessionDraft" | "saveNewSessionDraft" | "getFile">;

function renderDraftHook(draftClient: DraftClient, workspaceId = WORKSPACE_A) {
  return renderHook(
    (props: { client: DraftClient; workspaceId: string }) => {
      const [value, setValue] = useState(() => editable());
      const [files, setFiles] = useState<FileAsset[]>([]);
      const draft = useNewSessionDraft({
        client: props.client,
        workspaceId: props.workspaceId,
        value,
        onApplyRemote: setValue,
        restoreReadyFiles: (next) => setFiles([...next]),
      });
      return { draft, value, setValue, files };
    },
    { client: draftClient, workspaceId },
  );
}

function client(overrides: Partial<DraftClient> = {}): DraftClient {
  return {
    getNewSessionDraft: async () => remote(0),
    saveNewSessionDraft: async (_workspaceId, request) =>
      remote(request.expectedRevision + 1, request),
    getFile: async (_workspaceId, fileId) => asset(fileId),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function conflict(): OpenGeniApiError {
  return new OpenGeniApiError(
    409,
    JSON.stringify({
      code: "NEW_SESSION_DRAFT_CONFLICT",
      message: "draft changed",
      currentRevision: 5,
    }),
  );
}

describe("useNewSessionDraft", () => {
  test("revalidates every persisted file and restores only matching ready assets", async () => {
    const readyId = "00000000-0000-4000-8000-000000000011";
    const foreignId = "00000000-0000-4000-8000-000000000012";
    const failedId = "00000000-0000-4000-8000-000000000013";
    const missingId = "00000000-0000-4000-8000-000000000014";
    const reads: string[] = [];
    const saves: SaveNewSessionDraftRequest[] = [];
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () =>
          remote(4, {
            text: "restore me",
            resources: [
              { kind: "repository", uri: "https://example.com/repo.git", ref: "main" },
              { kind: "file", fileId: readyId, mountPath: `files/${readyId}` },
              { kind: "file", fileId: foreignId },
              { kind: "file", fileId: failedId },
              { kind: "file", fileId: missingId },
            ],
          }),
        getFile: async (_workspaceId, fileId) => {
          reads.push(fileId);
          if (fileId === missingId) throw new Error("gone");
          if (fileId === foreignId) return asset(fileId, { workspaceId: WORKSPACE_B });
          if (fileId === failedId) return asset(fileId, { status: "failed" });
          return asset(fileId);
        },
        saveNewSessionDraft: async (_workspaceId, request) => {
          saves.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush(550);

    expect(reads).toEqual([readyId, foreignId, failedId, missingId]);
    expect(hook.result.current.value.text).toBe("restore me");
    expect(hook.result.current.value.resources).toEqual([{ kind: "file", fileId: readyId }]);
    expect(hook.result.current.files.map((file) => file.id)).toEqual([readyId]);
    expect(hook.result.current.draft.loading).toBe(false);
    expect(saves).toHaveLength(0);
    await hook.unmount();
  });

  test("debounces autosave for 500 ms", async () => {
    const requests: SaveNewSessionDraftRequest[] = [];
    const hook = await renderDraftHook(
      client({
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "autosave" })));
    await flush(350);
    expect(requests).toHaveLength(0);
    await flush(180);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ expectedRevision: 0, text: "autosave" });
    await hook.unmount();
  });

  test("serializes saves and advances from the latest acknowledged revision", async () => {
    const first = deferred<NewSessionDraft>();
    const requests: SaveNewSessionDraftRequest[] = [];
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => remote(3),
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          if (requests.length === 1) return await first.promise;
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "first" })));
    await flush(520);
    await actRun(() => hook.result.current.setValue(editable({ text: "second" })));
    await flush(520);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.expectedRevision).toBe(3);

    await actRun(() => first.resolve(remote(4, requests[0])));
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ expectedRevision: 4, text: "second" });
    expect(hook.result.current.draft.revision).toBe(5);
    await hook.unmount();
  });

  test("surfaces only the typed draft 409 as a conflict and leaves local state intact", async () => {
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => remote(2),
        saveNewSessionDraft: async () => {
          throw conflict();
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "keep local" })));
    const result = await actRun(() => hook.result.current.draft.flush());
    expect(result).toBeNull();
    expect(hook.result.current.draft.conflict?.message).toContain("draft changed");
    expect(hook.result.current.value.text).toBe("keep local");
    await hook.unmount();

    const ordinary = await renderDraftHook(
      client({
        saveNewSessionDraft: async () => {
          throw new OpenGeniApiError(409, JSON.stringify({ message: "other conflict" }));
        },
      }),
    );
    await flush();
    await actRun(() => ordinary.result.current.setValue(editable({ text: "still local" })));
    await actRun(() => ordinary.result.current.draft.flush());
    expect(ordinary.result.current.draft.conflict).toBeNull();
    expect(ordinary.result.current.draft.error?.message).toContain("other conflict");
    expect(ordinary.result.current.value.text).toBe("still local");
    await ordinary.unmount();
  });

  test("keep mine rebases the captured local snapshot onto the authoritative revision", async () => {
    let reads = 0;
    let saves = 0;
    const requests: SaveNewSessionDraftRequest[] = [];
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => {
          reads += 1;
          return reads === 1 ? remote(2, { text: "first remote" }) : remote(5, { text: "other" });
        },
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          saves += 1;
          if (saves === 1) throw conflict();
          return remote(6, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "mine" })));
    await actRun(() => hook.result.current.draft.flush());
    await actRun(() => hook.result.current.draft.resolveConflict("keep_mine"));

    expect(requests.at(-1)).toMatchObject({ expectedRevision: 5, text: "mine" });
    expect(hook.result.current.value.text).toBe("mine");
    expect(hook.result.current.draft.revision).toBe(6);
    expect(hook.result.current.draft.conflict).toBeNull();
    await hook.unmount();
  });

  test("use remote replaces local state and revalidates its files", async () => {
    let reads = 0;
    const fileId = "00000000-0000-4000-8000-000000000055";
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => {
          reads += 1;
          return reads === 1
            ? remote(1, { text: "initial" })
            : remote(7, { text: "remote wins", resources: [{ kind: "file", fileId }] });
        },
        saveNewSessionDraft: async () => {
          throw conflict();
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "mine" })));
    await actRun(() => hook.result.current.draft.flush());
    await actRun(() => hook.result.current.draft.resolveConflict("use_remote"));

    expect(hook.result.current.value).toMatchObject({
      text: "remote wins",
      resources: [{ kind: "file", fileId }],
    });
    expect(hook.result.current.files.map((file) => file.id)).toEqual([fileId]);
    expect(hook.result.current.draft.revision).toBe(7);
    await hook.unmount();
  });

  test("flush returns the exact acknowledged revision and detects edits during create", async () => {
    const requests: SaveNewSessionDraftRequest[] = [];
    const hook = await renderDraftHook(
      client({
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "submitted" })));
    const flushed = await actRun(() => hook.result.current.draft.flush());
    expect(flushed?.revision).toBe(1);
    expect(flushed && hook.result.current.draft.isCurrentSignature(flushed.signature)).toBe(true);

    await actRun(() => hook.result.current.setValue(editable({ text: "edited in flight" })));
    expect(flushed && hook.result.current.draft.isCurrentSignature(flushed.signature)).toBe(false);
    const preserved = await actRun(() => hook.result.current.draft.flush());
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ expectedRevision: 1, text: "edited in flight" });
    expect(preserved?.revision).toBe(2);
    expect(preserved && hook.result.current.draft.isCurrentSignature(preserved.signature)).toBe(
      true,
    );
    await hook.unmount();
  });

  test("ignores stale GET and save responses after a target switch", async () => {
    const firstGet = deferred<NewSessionDraft>();
    const firstSave = deferred<NewSessionDraft>();
    const dynamic = client({
      getNewSessionDraft: async (workspaceId) =>
        workspaceId === WORKSPACE_A ? await firstGet.promise : remote(8, { text: "workspace b" }),
      saveNewSessionDraft: async (workspaceId, request) =>
        workspaceId === WORKSPACE_A
          ? await firstSave.promise
          : remote(request.expectedRevision + 1, request),
    });
    const hook = await renderDraftHook(dynamic);
    await hook.rerender({ client: dynamic, workspaceId: WORKSPACE_B });
    await flush();
    expect(hook.result.current.value.text).toBe("workspace b");
    expect(hook.result.current.draft.revision).toBe(8);

    await actRun(() => firstGet.resolve(remote(3, { text: "stale workspace a" })));
    await flush();
    expect(hook.result.current.value.text).toBe("workspace b");

    // Start and fence a save by replacing the client identity for the same
    // workspace, then ensure its late response cannot replace the new actor.
    const clientA = client({
      getNewSessionDraft: async () => remote(1),
      saveNewSessionDraft: async () => await firstSave.promise,
    });
    await hook.rerender({ client: clientA, workspaceId: WORKSPACE_A });
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "actor a" })));
    const pendingFlush = hook.result.current.draft.flush();
    const clientB = client({ getNewSessionDraft: async () => remote(9, { text: "actor b" }) });
    await hook.rerender({ client: clientB, workspaceId: WORKSPACE_A });
    await flush();
    await actRun(() => firstSave.resolve(remote(2, { text: "stale actor a" })));
    await actRun(async () => await pendingFlush);
    expect(hook.result.current.value.text).toBe("actor b");
    expect(hook.result.current.draft.revision).toBe(9);
    await hook.unmount();
  });
});
