import { describe, expect, test } from "bun:test";
import type {
  FileAsset,
  NewSessionDraft,
  NewSessionSelectionHistory,
  OpenGeniClient,
  SaveNewSessionDraftRequest,
} from "@opengeni/sdk";
import { stableJson } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useLayoutEffect, useRef, useState } from "react";

import {
  actRun,
  flush,
  registerDom,
  renderHook,
} from "../../../../packages/react/test/render-hook";
import {
  hydratedNewSessionProjectProvenancePresent,
  initialNewSessionProjectLaunchIntent,
  newSessionProjectSelection,
  nextFocusedNewSessionProjectLaunchIntent,
  nextNewSessionProjectLaunchIntent,
  resolveHydratedNewSessionProjectSelection,
} from "../routes/sessions-index-hydration";
import {
  newSessionDraftOptionsFromSessionDraft,
  sessionDraftFromNewSessionDraftOptions,
} from "./session-create";
import { useNewSessionDraft, type NewSessionDraftEditable } from "./use-new-session-draft";

registerDom();

const WORKSPACE_A = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE_B = "00000000-0000-4000-8000-0000000000b2";
const PROJECT_A = "00000000-0000-4000-8000-0000000000c3";
const PROJECT_B = "00000000-0000-4000-8000-0000000000d4";
const MACHINE_A = "00000000-0000-4000-8000-0000000000e5";
const MACHINE_B = "00000000-0000-4000-8000-0000000000f6";

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

type RouteDraftHookProps = {
  launchChannelId: string | null | undefined;
};

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

function renderRouteDraftHook(
  draftClient: DraftClient,
  initialLaunchChannelId: string | null | undefined = undefined,
  onRemoteApplied?: () => void,
) {
  return renderHook(
    (props: RouteDraftHookProps) => {
      const { launchChannelId } = props;
      const [remoteValue, setRemoteValue] = useState(() => editable());
      const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
        launchChannelId ?? null,
      );
      const selectedChannelIdRef = useRef(selectedChannelId);
      const setSelectedProjectChannelId = (channelId: string | null) => {
        selectedChannelIdRef.current = channelId;
        setSelectedChannelId(channelId);
      };
      const [selectionHistory, setSelectionHistory] = useState<NewSessionSelectionHistory>({
        projects: [],
      });
      const [projectProvenancePresent, setProjectProvenancePresent] = useState(
        launchChannelId !== undefined,
      );
      const remoteDraftHydratedRef = useRef(false);
      const [, setCreateComposerFocusGen] = useState(0);
      const launchIntentRef = useRef(initialNewSessionProjectLaunchIntent(launchChannelId));
      const previousLaunchChannelIdRef = useRef(launchChannelId);
      useLayoutEffect(() => {
        launchIntentRef.current = nextNewSessionProjectLaunchIntent(
          launchIntentRef.current,
          previousLaunchChannelIdRef.current,
          launchChannelId,
        );
        previousLaunchChannelIdRef.current = launchChannelId;
      }, [launchChannelId]);
      const value = {
        ...remoteValue,
        ...(projectProvenancePresent ? { selectedProjectChannelId: selectedChannelId } : {}),
      };
      const selectProject = (channelId: string | null, explicit = true) => {
        const previousChannelId = selectedChannelIdRef.current;
        if (explicit) setProjectProvenancePresent(true);
        setSelectedProjectChannelId(channelId);
        setRemoteValue((current) => {
          const restored = sessionDraftFromNewSessionDraftOptions(current.options);
          const selection = newSessionProjectSelection(selectionHistory, channelId, {
            channelId: previousChannelId,
            compute: restored.compute,
          });
          return selection.compute === restored.compute
            ? current
            : {
                ...current,
                options: newSessionDraftOptionsFromSessionDraft({
                  ...restored,
                  compute: selection.compute,
                }),
              };
        });
      };
      const draft = useNewSessionDraft({
        client: draftClient,
        workspaceId: WORKSPACE_A,
        value,
        onApplyRemote: (nextRemote, history) => {
          const {
            selectedProjectChannelId: _selectedProjectChannelId,
            ...nextRemoteWithoutProvenance
          } = nextRemote;
          const restored = sessionDraftFromNewSessionDraftOptions(nextRemote.options);
          const selection = resolveHydratedNewSessionProjectSelection({
            launchIntent: launchIntentRef.current,
            remote: nextRemote,
            history,
            restoredCompute: restored.compute,
          });
          remoteDraftHydratedRef.current = true;
          setSelectionHistory(history);
          setRemoteValue({
            ...nextRemoteWithoutProvenance,
            options: newSessionDraftOptionsFromSessionDraft({
              ...restored,
              compute: selection.compute,
            }),
          });
          setSelectedProjectChannelId(selection.channelId);
          setProjectProvenancePresent(
            hydratedNewSessionProjectProvenancePresent(launchIntentRef.current, nextRemote),
          );
          onRemoteApplied?.();
        },
        restoreReadyFiles: () => {},
      });
      return {
        draft,
        value,
        setValue: setRemoteValue,
        selectedChannelId,
        launchIntent: launchIntentRef.current,
        selectProject,
        selectCompute: (
          compute: ReturnType<typeof sessionDraftFromNewSessionDraftOptions>["compute"],
        ) => {
          setProjectProvenancePresent(true);
          setRemoteValue((current) => {
            const restored = sessionDraftFromNewSessionDraftOptions(current.options);
            return {
              ...current,
              options: newSessionDraftOptionsFromSessionDraft({ ...restored, compute }),
            };
          });
        },
        requestComposerFocus: (channelId?: string | null) => {
          launchIntentRef.current = nextFocusedNewSessionProjectLaunchIntent(
            launchIntentRef.current,
            channelId,
          );
          if (channelId !== undefined) {
            selectProject(channelId);
          } else if (remoteDraftHydratedRef.current) {
            setProjectProvenancePresent(false);
            selectProject(selectionHistory.projects[0]?.channelId ?? null, false);
          }
          setCreateComposerFocusGen((current) => current + 1);
        },
      };
    },
    { launchChannelId: initialLaunchChannelId } as RouteDraftHookProps,
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

async function settleBeforePassiveEffects(run: () => Promise<void> | void): Promise<void> {
  // This helper is paired with renderHook.rerenderThroughLayout: the test needs
  // the real browser microtask window after layout commit but before React's
  // passive-effect task. Ordinary assertions and cleanup return to `act`.
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await run();
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
}

function exactCreateAccepts(
  authoritative: NewSessionDraft,
  expectedRevision: number,
  local: NewSessionDraftEditable,
): boolean {
  const {
    revision,
    selectionHistory: _selectionHistory,
    updatedAt: _updatedAt,
    selectedProjectChannelId: _authoritativeProject,
    ...authoritativeSnapshot
  } = authoritative;
  const { selectedProjectChannelId: _localProject, ...localSnapshot } = local;
  return (
    revision === expectedRevision && stableJson(authoritativeSnapshot) === stableJson(localSnapshot)
  );
}

describe("useNewSessionDraft", () => {
  test("revalidates persisted files while retaining ordinary repository resources", async () => {
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
              {
                kind: "repository",
                uri: "https://example.com/repo.git",
                ref: "main",
              },
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
    expect(hook.result.current.value.resources).toEqual([
      { kind: "repository", uri: "https://example.com/repo.git", ref: "main" },
      { kind: "file", fileId: readyId },
    ]);
    expect(hook.result.current.files.map((file) => file.id)).toEqual([readyId]);
    expect(hook.result.current.draft.loading).toBe(false);
    expect(saves).toHaveLength(0);
    await hook.unmount();
  });

  test("treats an old-server response without toolsProvided as explicit", async () => {
    const { toolsProvided: _toolsProvided, ...legacy } = remote(4, {
      tools: [{ kind: "mcp", id: "docs" }],
    });
    const hook = await renderDraftHook(
      client({ getNewSessionDraft: async () => legacy as NewSessionDraft }),
    );
    await flush();

    expect(hook.result.current.value.toolsProvided).toBe(true);
    expect(hook.result.current.value.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    expect(Object.hasOwn(hook.result.current.value, "selectedProjectChannelId")).toBe(false);
    await hook.unmount();
  });

  test("hydrates and serializes explicit project provenance including Default", async () => {
    const requests: SaveNewSessionDraftRequest[] = [];
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => remote(3, { selectedProjectChannelId: PROJECT_A }),
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();

    expect(hook.result.current.value.selectedProjectChannelId).toBe(PROJECT_A);
    await actRun(() =>
      hook.result.current.setValue({
        ...hook.result.current.value,
        selectedProjectChannelId: null,
      }),
    );
    await flush(550);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.selectedProjectChannelId).toBeNull();
    expect(Object.hasOwn(requests[0]!, "selectedProjectChannelId")).toBe(true);
    await hook.unmount();
  });

  test("legacy route hydration stays read-only across concurrent initial readers until explicit selection", async () => {
    const history = {
      projects: [{ channelId: PROJECT_A, targetSandboxId: null, machines: [] }],
    };
    let authoritative = { ...remote(0), selectionHistory: history };
    const initialReads = [deferred<NewSessionDraft>(), deferred<NewSessionDraft>()];
    let reads = 0;
    const requests: SaveNewSessionDraftRequest[] = [];
    const draftClient = client({
      getNewSessionDraft: async () => {
        const pending = initialReads[reads];
        reads += 1;
        return pending ? await pending.promise : authoritative;
      },
      saveNewSessionDraft: async (_workspaceId, request) => {
        requests.push(request);
        if (request.expectedRevision !== authoritative.revision) throw conflict();
        authoritative = {
          ...remote(request.expectedRevision + 1, request),
          selectionHistory: history,
        };
        return authoritative;
      },
    });
    const first = await renderRouteDraftHook(draftClient);
    const second = await renderRouteDraftHook(draftClient);
    expect(reads).toBe(2);
    await actRun(() => {
      initialReads[0]?.resolve(authoritative);
      initialReads[1]?.resolve(authoritative);
    });
    await flush(550);

    expect(first.result.current.selectedChannelId).toBe(PROJECT_A);
    expect(second.result.current.selectedChannelId).toBe(PROJECT_A);
    expect(Object.hasOwn(first.result.current.value, "selectedProjectChannelId")).toBe(false);
    expect(Object.hasOwn(second.result.current.value, "selectedProjectChannelId")).toBe(false);
    expect(requests).toHaveLength(0);

    await actRun(() => first.result.current.selectProject(PROJECT_A));
    await flush(550);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      expectedRevision: 0,
      selectedProjectChannelId: PROJECT_A,
    });

    await actRun(() => second.result.current.selectProject(null));
    expect(await actRun(() => second.result.current.draft.flush())).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedRevision: 0,
      selectedProjectChannelId: null,
    });
    expect(second.result.current.draft.conflict).not.toBeNull();

    await first.unmount();
    await second.unmount();
  });

  test("route-projected legacy compute is the passive baseline and keeps sibling OCC authority", async () => {
    const history = {
      projects: [
        {
          channelId: PROJECT_A,
          targetSandboxId: MACHINE_A,
          machines: [{ sandboxId: MACHINE_A, workingDir: "/workspace/project-a" }],
        },
      ],
    };
    let authoritative = {
      ...remote(1, {
        options: {
          visibility: "workspace",
          targetSandboxId: MACHINE_B,
          workingDir: "/workspace/project-b",
        },
      }),
      selectionHistory: history,
    };
    const requests: SaveNewSessionDraftRequest[] = [];
    const draftClient = client({
      getNewSessionDraft: async () => authoritative,
      saveNewSessionDraft: async (_workspaceId, request) => {
        requests.push(request);
        if (request.expectedRevision !== authoritative.revision) throw conflict();
        authoritative = {
          ...remote(request.expectedRevision + 1, request),
          selectionHistory: history,
        };
        return authoritative;
      },
    });
    const first = await renderRouteDraftHook(draftClient);
    const second = await renderRouteDraftHook(draftClient);
    await flush(550);

    for (const hook of [first, second]) {
      expect(hook.result.current.selectedChannelId).toBe(PROJECT_A);
      expect(hook.result.current.value.options).toMatchObject({
        targetSandboxId: MACHINE_A,
        workingDir: "/workspace/project-a",
      });
      expect(Object.hasOwn(hook.result.current.value, "selectedProjectChannelId")).toBe(false);
    }
    expect(requests).toHaveLength(0);

    await actRun(() =>
      first.result.current.setValue({ ...first.result.current.value, text: "first tab edit" }),
    );
    await flush(550);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ expectedRevision: 1, text: "first tab edit" });

    await actRun(() =>
      second.result.current.setValue({ ...second.result.current.value, text: "stale tab edit" }),
    );
    expect(await actRun(() => second.result.current.draft.flush())).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ expectedRevision: 1, text: "stale tab edit" });
    expect(second.result.current.draft.conflict).not.toBeNull();

    await first.unmount();
    await second.unmount();
  });

  test.each([
    ["explicit route", PROJECT_A],
    ["Recents", undefined],
  ] as const)(
    "%s projection stays passively read-only but an immediate create flush persists its exact snapshot",
    async (_label, launchChannelId) => {
      const history = {
        projects: [
          {
            channelId: PROJECT_A,
            targetSandboxId: MACHINE_A,
            machines: [{ sandboxId: MACHINE_A, workingDir: "/workspace/project-a" }],
          },
        ],
      };
      let authoritative = {
        ...remote(1, {
          ...(launchChannelId === undefined ? {} : { selectedProjectChannelId: PROJECT_B }),
          options: {
            visibility: "workspace" as const,
            targetSandboxId: MACHINE_B,
            workingDir: "/workspace/project-b",
          },
        }),
        selectionHistory: history,
      };
      const requests: SaveNewSessionDraftRequest[] = [];
      const hook = await renderRouteDraftHook(
        client({
          getNewSessionDraft: async () => authoritative,
          saveNewSessionDraft: async (_workspaceId, request) => {
            requests.push(request);
            if (request.expectedRevision !== authoritative.revision) throw conflict();
            const { expectedRevision: _expectedRevision, ...savedEditable } = request;
            authoritative = {
              ...remote(request.expectedRevision + 1, savedEditable),
              selectionHistory: history,
            };
            return authoritative;
          },
        }),
        launchChannelId,
      );
      await flush(550);

      expect(hook.result.current.selectedChannelId).toBe(PROJECT_A);
      expect(hook.result.current.value.options).toMatchObject({
        targetSandboxId: MACHINE_A,
        workingDir: "/workspace/project-a",
      });
      expect(requests).toHaveLength(0);

      const flushed = await actRun(() => hook.result.current.draft.flush());
      expect(flushed?.revision).toBe(2);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        expectedRevision: 1,
        options: {
          targetSandboxId: MACHINE_A,
          workingDir: "/workspace/project-a",
        },
      });
      if (launchChannelId === undefined) {
        expect(Object.hasOwn(requests[0]!, "selectedProjectChannelId")).toBe(false);
      } else {
        expect(requests[0]?.selectedProjectChannelId).toBe(PROJECT_A);
      }
      expect(
        flushed && exactCreateAccepts(authoritative, flushed.revision, hook.result.current.value),
      ).toBe(true);
      await hook.unmount();
    },
  );

  test.each([
    ["named", PROJECT_B],
    ["Default", null],
  ] as const)(
    "deferred GET honors a newer %s-to-omitted route intent without a passive write",
    async (_label, initialLaunchChannelId) => {
      const pending = deferred<NewSessionDraft>();
      const applied = deferred<void>();
      const requests: SaveNewSessionDraftRequest[] = [];
      const history = {
        projects: [
          {
            channelId: PROJECT_A,
            targetSandboxId: MACHINE_A,
            machines: [{ sandboxId: MACHINE_A, workingDir: "/workspace/project-a" }],
          },
        ],
      };
      const hydratedRemote = {
        ...remote(3, {
          selectedProjectChannelId: PROJECT_B,
          options: {
            visibility: "workspace" as const,
            targetSandboxId: MACHINE_B,
            workingDir: "/workspace/project-b",
          },
        }),
        selectionHistory: history,
      };
      const hook = await renderRouteDraftHook(
        client({
          getNewSessionDraft: async () => await pending.promise,
          saveNewSessionDraft: async (_workspaceId, request) => {
            requests.push(request);
            return remote(request.expectedRevision + 1, request);
          },
        }),
        initialLaunchChannelId,
        () => applied.resolve(),
      );

      await hook.rerenderThroughLayout({ launchChannelId: undefined });
      await settleBeforePassiveEffects(async () => {
        pending.resolve(hydratedRemote);
        await applied.promise;
      });
      await flush(550);

      expect(hook.result.current.selectedChannelId).toBe(PROJECT_A);
      expect(hook.result.current.value.options).toMatchObject({
        targetSandboxId: MACHINE_A,
        workingDir: "/workspace/project-a",
      });
      expect(Object.hasOwn(hook.result.current.value, "selectedProjectChannelId")).toBe(false);
      expect(requests).toHaveLength(0);
      await hook.unmount();
    },
  );

  test("repeated omitted focus requests defer Recents until pending history hydrates", async () => {
    const pending = deferred<NewSessionDraft>();
    const requests: SaveNewSessionDraftRequest[] = [];
    const history = {
      projects: [
        {
          channelId: PROJECT_A,
          targetSandboxId: MACHINE_A,
          machines: [{ sandboxId: MACHINE_A, workingDir: "/workspace/project-a" }],
        },
      ],
    };
    const hook = await renderRouteDraftHook(
      client({
        getNewSessionDraft: async () => await pending.promise,
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );

    await actRun(() => {
      hook.result.current.requestComposerFocus();
      hook.result.current.requestComposerFocus();
    });
    expect(hook.result.current.launchIntent).toEqual({
      generation: 2,
      kind: "omitted_after_explicit",
    });
    expect(hook.result.current.selectedChannelId).toBeNull();

    await actRun(() =>
      pending.resolve({
        ...remote(4, {
          selectedProjectChannelId: PROJECT_B,
          options: {
            visibility: "workspace",
            targetSandboxId: MACHINE_B,
            workingDir: "/workspace/project-b",
          },
        }),
        selectionHistory: history,
      }),
    );
    await flush(550);

    expect(hook.result.current.selectedChannelId).toBe(PROJECT_A);
    expect(hook.result.current.value.options).toMatchObject({
      targetSandboxId: MACHINE_A,
      workingDir: "/workspace/project-a",
    });
    expect(Object.hasOwn(hook.result.current.value, "selectedProjectChannelId")).toBe(false);
    expect(requests).toHaveLength(0);
    await hook.unmount();
  });

  test("explicit machine and folder changes persist provenance across autosave and reload", async () => {
    const history = {
      projects: [
        {
          channelId: PROJECT_A,
          targetSandboxId: MACHINE_A,
          machines: [{ sandboxId: MACHINE_A, workingDir: "/workspace/project-a" }],
        },
      ],
    };
    let authoritative = {
      ...remote(2, {
        options: {
          visibility: "workspace",
          targetSandboxId: MACHINE_B,
          workingDir: "/workspace/project-b",
        },
      }),
      selectionHistory: history,
    };
    const requests: SaveNewSessionDraftRequest[] = [];
    const hook = await renderRouteDraftHook(
      client({
        getNewSessionDraft: async () => authoritative,
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          authoritative = {
            ...remote(request.expectedRevision + 1, request),
            selectionHistory: history,
          };
          return authoritative;
        },
      }),
    );
    await flush(550);

    expect(hook.result.current.selectedChannelId).toBe(PROJECT_A);
    expect(hook.result.current.value.options).toMatchObject({
      targetSandboxId: MACHINE_A,
      workingDir: "/workspace/project-a",
    });
    expect(Object.hasOwn(hook.result.current.value, "selectedProjectChannelId")).toBe(false);
    expect(requests).toHaveLength(0);

    await actRun(() =>
      hook.result.current.selectCompute({
        kind: "machine",
        sandboxId: MACHINE_B,
        folder: { kind: "path", path: "/workspace/project-b" },
      }),
    );
    await flush(550);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      expectedRevision: 2,
      selectedProjectChannelId: PROJECT_A,
      options: {
        targetSandboxId: MACHINE_B,
        workingDir: "/workspace/project-b",
      },
    });

    await actRun(() => hook.result.current.draft.reload());
    await flush(550);

    expect(hook.result.current.selectedChannelId).toBe(PROJECT_A);
    expect(hook.result.current.value.selectedProjectChannelId).toBe(PROJECT_A);
    expect(hook.result.current.value.options).toMatchObject({
      targetSandboxId: MACHINE_B,
      workingDir: "/workspace/project-b",
    });
    expect(requests).toHaveLength(1);
    await hook.unmount();
  });

  test("an explicit compute interaction persists an explicit Default provenance", async () => {
    const requests: SaveNewSessionDraftRequest[] = [];
    const hook = await renderRouteDraftHook(
      client({
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();

    await actRun(() =>
      hook.result.current.selectCompute({
        kind: "machine",
        sandboxId: MACHINE_B,
        folder: { kind: "root" },
      }),
    );
    await flush(550);

    expect(requests).toHaveLength(1);
    expect(Object.hasOwn(requests[0]!, "selectedProjectChannelId")).toBe(true);
    expect(requests[0]?.selectedProjectChannelId).toBeNull();
    await hook.unmount();
  });

  test("catalog callback identity changes do not reset an in-flight newest edit", async () => {
    const pendingSave = deferred<NewSessionDraft>();
    const requests: SaveNewSessionDraftRequest[] = [];
    let reads = 0;
    const draftClient = client({
      getNewSessionDraft: async () => {
        reads += 1;
        return remote(1, { text: "server" });
      },
      saveNewSessionDraft: async (_workspaceId, request) => {
        requests.push(request);
        return await pendingSave.promise;
      },
    });
    const hook = await renderHook(
      (props: {
        hydrateResources: (
          resources: NewSessionDraftEditable["resources"],
        ) => NewSessionDraftEditable["resources"];
      }) => {
        const [value, setValue] = useState(() => editable());
        const draft = useNewSessionDraft({
          client: draftClient,
          workspaceId: WORKSPACE_A,
          value,
          onApplyRemote: setValue,
          restoreReadyFiles: () => {},
          hydrateResources: props.hydrateResources,
          resourceHydrationReady: true,
        });
        return { draft, value, setValue };
      },
      { hydrateResources: (resources) => resources },
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "newest local edit" })));

    let pending!: Promise<unknown>;
    await actRun(() => {
      pending = hook.result.current.draft.flush();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      expectedRevision: 1,
      text: "newest local edit",
    });

    await hook.rerender({ hydrateResources: (resources) => [...resources] });
    await flush();
    expect(reads).toBe(1);
    expect(hook.result.current.value.text).toBe("newest local edit");

    const request = requests[0];
    if (!request) throw new Error("Expected an in-flight draft save");
    await actRun(() => pendingSave.resolve(remote(2, request)));
    await actRun(async () => await pending);
    expect(hook.result.current.draft.revision).toBe(2);
    expect(hook.result.current.value.text).toBe("newest local edit");
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
    expect(requests[0]).toMatchObject({
      expectedRevision: 0,
      text: "autosave",
    });
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

    expect(requests.at(-1)).toMatchObject({
      expectedRevision: 5,
      text: "mine",
    });
    expect(hook.result.current.value.text).toBe("mine");
    expect(hook.result.current.draft.revision).toBe(6);
    expect(hook.result.current.draft.conflict).toBeNull();
    await hook.unmount();
  });

  test("a create-time conflict enters recovery instead of reusing the stale flushed revision", async () => {
    let authoritative = remote(2, { text: "initial" });
    const requests: SaveNewSessionDraftRequest[] = [];
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => authoritative,
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          authoritative = remote(request.expectedRevision + 1, request);
          return authoritative;
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "mine" })));
    const flushed = await actRun(() => hook.result.current.draft.flush());
    expect(flushed?.revision).toBe(3);

    authoritative = remote(4, { text: "sibling" });
    expect(await actRun(() => hook.result.current.draft.captureConflict(conflict()))).toBe(true);
    expect(hook.result.current.draft.conflict?.message).toContain("draft changed");
    expect(await actRun(() => hook.result.current.draft.flush())).toBeNull();

    await actRun(() => hook.result.current.draft.resolveConflict("keep_mine"));
    expect(requests.at(-1)).toMatchObject({ expectedRevision: 4, text: "mine" });
    expect(hook.result.current.draft.revision).toBe(5);
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
            : remote(7, {
                text: "remote wins",
                resources: [{ kind: "file", fileId }],
              });
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
    expect(requests[1]).toMatchObject({
      expectedRevision: 1,
      text: "edited in flight",
    });
    expect(preserved?.revision).toBe(2);
    expect(preserved && hook.result.current.draft.isCurrentSignature(preserved.signature)).toBe(
      true,
    );
    await hook.unmount();
  });

  test("marking the accepted snapshot consumed preserves the safe seed", async () => {
    const requests: SaveNewSessionDraftRequest[] = [];
    let reads = 0;
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => {
          reads += 1;
          return reads === 1 ? remote(0) : remote(2, { model: "seed-model" });
        },
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "submitted" })));
    const flushed = await actRun(() => hook.result.current.draft.flush());
    expect(flushed).not.toBeNull();
    expect(requests).toHaveLength(1);

    const acknowledged = await actRun(() =>
      flushed ? hook.result.current.draft.acknowledgeConsumed(flushed) : null,
    );
    expect(acknowledged).toEqual({ kind: "consumed" });
    await actRun(() => hook.result.current.setValue(editable()));
    // Navigation may take longer than the normal autosave debounce. The clear
    // must remain UI-only after the accepted row was consumed server-side.
    await flush(550);
    expect(requests).toHaveLength(1);
    expect(await actRun(() => hook.result.current.draft.flush())).toBeNull();
    expect(reads).toBe(2);
    await hook.unmount();
  });

  test("preserves a newer post-create edit against the safe-seed revision", async () => {
    const requests: SaveNewSessionDraftRequest[] = [];
    let reads = 0;
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => {
          reads += 1;
          return reads === 1 ? remote(0) : remote(2, { model: "seed-model" });
        },
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "submitted" })));
    const flushed = await actRun(() => hook.result.current.draft.flush());
    expect(flushed).not.toBeNull();
    if (!flushed) throw new Error("Expected the submitted draft to flush");

    await actRun(() => hook.result.current.setValue(editable({ text: "newer local edit" })));
    const acknowledged = await actRun(() => hook.result.current.draft.acknowledgeConsumed(flushed));

    expect(acknowledged).toEqual({
      kind: "preserved",
      flushed: expect.objectContaining({ revision: 3 }),
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedRevision: 2,
      text: "newer local edit",
    });
    expect(hook.result.current.draft.revision).toBe(3);
    expect(hook.result.current.draft.conflict).toBeNull();
    await hook.unmount();
  });

  test("keeps a sibling-tab newer winner as a visible conflict", async () => {
    const requests: SaveNewSessionDraftRequest[] = [];
    let reads = 0;
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => {
          reads += 1;
          return reads === 1 ? remote(0) : remote(3, { text: "sibling" });
        },
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "submitted" })));
    const flushed = await actRun(() => hook.result.current.draft.flush());
    if (!flushed) throw new Error("Expected the submitted draft to flush");

    await actRun(() => hook.result.current.setValue(editable({ text: "keep this local" })));
    const acknowledged = await actRun(() => hook.result.current.draft.acknowledgeConsumed(flushed));

    expect(acknowledged).toBeNull();
    expect(requests).toHaveLength(1);
    expect(hook.result.current.value.text).toBe("keep this local");
    expect(hook.result.current.draft.revision).toBe(3);
    expect(hook.result.current.draft.conflict?.message).toContain("another client");
    await hook.unmount();
  });

  test("retries a safe-seed preservation failure without losing the newer value", async () => {
    const fileId = "00000000-0000-4000-8000-000000000099";
    const requests: SaveNewSessionDraftRequest[] = [];
    let reads = 0;
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => {
          reads += 1;
          return reads === 1 ? remote(0) : remote(2, { model: "seed-model" });
        },
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          if (requests.length === 2) throw new Error("temporary preservation failure");
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "submitted" })));
    const flushed = await actRun(() => hook.result.current.draft.flush());
    if (!flushed) throw new Error("Expected the submitted draft to flush");

    const newer = editable({
      text: "newer local edit",
      resources: [{ kind: "file", fileId }],
    });
    await actRun(() => hook.result.current.setValue(newer));
    const acknowledged = await actRun(() => hook.result.current.draft.acknowledgeConsumed(flushed));

    expect(acknowledged).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedRevision: 2,
      text: newer.text,
      resources: newer.resources,
    });
    expect(hook.result.current.value).toEqual(newer);
    expect(hook.result.current.draft.revision).toBe(2);
    expect(hook.result.current.draft.conflict).toBeNull();
    expect(hook.result.current.draft.error?.message).toContain("temporary preservation failure");

    const preserved = await actRun(() => hook.result.current.draft.flush());
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({
      expectedRevision: 2,
      text: newer.text,
      resources: newer.resources,
    });
    expect(preserved && hook.result.current.draft.isCurrentSignature(preserved.signature)).toBe(
      true,
    );
    expect(hook.result.current.value).toEqual(newer);
    expect(hook.result.current.draft.error).toBeNull();
    await hook.unmount();
  });

  test("invalidates an in-flight old-revision autosave before preserving the newer value", async () => {
    const staleAutosave = deferred<NewSessionDraft>();
    const requests: SaveNewSessionDraftRequest[] = [];
    let reads = 0;
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => {
          reads += 1;
          return reads === 1 ? remote(0) : remote(2, { model: "seed-model" });
        },
        saveNewSessionDraft: async (_workspaceId, request) => {
          requests.push(request);
          if (requests.length === 2) return await staleAutosave.promise;
          return remote(request.expectedRevision + 1, request);
        },
      }),
    );
    await flush();
    await actRun(() => hook.result.current.setValue(editable({ text: "submitted" })));
    const flushed = await actRun(() => hook.result.current.draft.flush());
    if (!flushed) throw new Error("Expected the submitted draft to flush");

    await actRun(() => hook.result.current.setValue(editable({ text: "newer local edit" })));
    await flush(520);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      expectedRevision: 1,
      text: "newer local edit",
    });

    let acknowledgement!: ReturnType<(typeof hook.result.current.draft)["acknowledgeConsumed"]>;
    await actRun(() => {
      acknowledgement = hook.result.current.draft.acknowledgeConsumed(flushed);
    });
    expect(requests).toHaveLength(2);

    const acknowledged = await actRun(async () => {
      staleAutosave.reject(conflict());
      return await acknowledgement;
    });
    expect(acknowledged).toEqual({
      kind: "preserved",
      flushed: expect.objectContaining({ revision: 3 }),
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({
      expectedRevision: 2,
      text: "newer local edit",
    });
    expect(hook.result.current.draft.conflict).toBeNull();
    expect(hook.result.current.draft.error).toBeNull();
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
    const clientB = client({
      getNewSessionDraft: async () => remote(9, { text: "actor b" }),
    });
    await hook.rerender({ client: clientB, workspaceId: WORKSPACE_A });
    await flush();
    await actRun(() => firstSave.resolve(remote(2, { text: "stale actor a" })));
    await actRun(async () => await pendingFlush);
    expect(hook.result.current.value.text).toBe("actor b");
    expect(hook.result.current.draft.revision).toBe(9);
    await hook.unmount();
  });

  test("physically aborts an old draft GET when the actor target changes", async () => {
    let oldSignal: AbortSignal | undefined;
    const dynamic = client({
      getNewSessionDraft: async (workspaceId, options) => {
        if (workspaceId === WORKSPACE_B) return remote(8, { text: "workspace b" });
        oldSignal = options?.signal;
        return await new Promise<NewSessionDraft>((_resolve, reject) => {
          oldSignal?.addEventListener(
            "abort",
            () => reject(oldSignal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const hook = await renderDraftHook(dynamic);
    await flush();
    expect(oldSignal?.aborted).toBe(false);

    await hook.rerender({ client: dynamic, workspaceId: WORKSPACE_B });
    await flush();

    expect(oldSignal?.aborted).toBe(true);
    expect(hook.result.current.value.text).toBe("workspace b");
    expect(hook.result.current.draft.revision).toBe(8);
    expect(hook.result.current.draft.error).toBeNull();
    await hook.unmount();
  });

  test("physically aborts pending file hydration when the hook unmounts", async () => {
    const fileId = "00000000-0000-4000-8000-000000000011";
    let fileSignal: AbortSignal | undefined;
    const hook = await renderDraftHook(
      client({
        getNewSessionDraft: async () => remote(4, { resources: [{ kind: "file", fileId }] }),
        getFile: async (_workspaceId, _fileId, options) => {
          fileSignal = options?.signal;
          return await new Promise<FileAsset>((_resolve, reject) => {
            fileSignal?.addEventListener(
              "abort",
              () => reject(fileSignal?.reason ?? new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        },
      }),
    );
    await flush();
    expect(fileSignal?.aborted).toBe(false);

    await hook.unmount();

    expect(fileSignal?.aborted).toBe(true);
  });

  test("reload before catalogs are ready does not fetch", async () => {
    let reads = 0;
    const draftClient = client({
      getNewSessionDraft: async () => {
        reads += 1;
        return remote(1, { text: "hydrated" });
      },
    });
    const hook = await renderHook(
      (props: { resourceHydrationReady: boolean }) => {
        const [value, setValue] = useState(() => editable());
        const draft = useNewSessionDraft({
          client: draftClient,
          workspaceId: WORKSPACE_A,
          value,
          onApplyRemote: setValue,
          restoreReadyFiles: () => {},
          resourceHydrationReady: props.resourceHydrationReady,
        });
        return { draft, value };
      },
      { resourceHydrationReady: false },
    );
    expect(reads).toBe(0);
    expect(hook.result.current.draft.loading).toBe(true);

    await hook.rerender({ resourceHydrationReady: true });
    await flush();
    expect(reads).toBe(1);
    expect(hook.result.current.value.text).toBe("hydrated");
    expect(hook.result.current.draft.loading).toBe(false);
    await hook.unmount();
  });
});
