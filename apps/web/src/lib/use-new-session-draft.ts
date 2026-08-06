import { stableJson } from "@opengeni/contracts";
import type {
  FileAsset,
  NewSessionDraft,
  OpenGeniClient,
  ResourceRef,
  SaveNewSessionDraftRequest,
} from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

export type NewSessionDraftEditable = Omit<SaveNewSessionDraftRequest, "expectedRevision">;

export type UseNewSessionDraftOptions = {
  workspaceId: string;
  client: Pick<OpenGeniClient, "getNewSessionDraft" | "saveNewSessionDraft" | "getFile">;
  /** The complete browser-visible value. It must contain ready file refs only. */
  value: NewSessionDraftEditable;
  /** Apply a remote value to the controlled text/model/tool/options state. */
  onApplyRemote: (value: NewSessionDraftEditable) => void;
  /** Replace finalized attachments with freshly revalidated server assets. */
  restoreReadyFiles: (files: Iterable<FileAsset>) => void;
  /** Revalidate non-file resource identities against the current UI catalog. */
  hydrateResources?: (resources: ResourceRef[]) => ResourceRef[] | Promise<ResourceRef[]>;
  /** Keep the first read pending until catalogs needed for hydration are ready. */
  resourceHydrationReady?: boolean;
};

export type FlushedNewSessionDraft = {
  revision: number;
  /** Signature of the exact local snapshot acknowledged by this revision. */
  signature: string;
};

export type AcknowledgeConsumedNewSessionDraftResult =
  | { kind: "consumed" }
  | { kind: "preserved"; flushed: FlushedNewSessionDraft };

export type UseNewSessionDraftResult = {
  draft: NewSessionDraft | null;
  revision: number;
  loading: boolean;
  saving: boolean;
  conflict: Error | null;
  error: Error | null;
  flush: () => Promise<FlushedNewSessionDraft | null>;
  isCurrentSignature: (signature: string) => boolean;
  /**
   * Fence the exact acknowledged snapshot after session creation consumes it,
   * preserving a genuinely newer local value against the safe-seed row.
   */
  acknowledgeConsumed: (
    flushed: FlushedNewSessionDraft,
  ) => Promise<AcknowledgeConsumedNewSessionDraftResult | null>;
  reload: () => Promise<void>;
  resolveConflict: (choice: "keep_mine" | "use_remote") => Promise<void>;
  clearError: () => void;
};

type ValidatedRemoteDraft = {
  draft: NewSessionDraft;
  editable: NewSessionDraftEditable;
  files: FileAsset[];
};

/**
 * Actor-private, server-authoritative state for the composer shown before a
 * session exists. Reads and writes are fenced to one client/workspace target;
 * writes serialize and acquire the latest acknowledged revision at execution
 * time, so a stale closure can never invent its own OCC base.
 */
export function useNewSessionDraft(options: UseNewSessionDraftOptions): UseNewSessionDraftResult {
  const { client, workspaceId } = options;
  const resourceHydrationReady = options.resourceHydrationReady ?? true;
  const hydrateResources = options.hydrateResources;
  const [draft, setDraft] = useState<NewSessionDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Error | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const valueRef = useRef(options.value);
  valueRef.current = options.value;
  const onApplyRemoteRef = useRef(options.onApplyRemote);
  onApplyRemoteRef.current = options.onApplyRemote;
  const restoreReadyFilesRef = useRef(options.restoreReadyFiles);
  restoreReadyFilesRef.current = options.restoreReadyFiles;
  const draftRef = useRef<NewSessionDraft | null>(null);
  const lastSavedSignature = useRef<string | null>(null);
  const targetGeneration = useRef(0);
  const persistenceEpoch = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictRef = useRef<Error | null>(null);
  const loadingRef = useRef(true);
  const targetKey = `${workspaceId}\u0000${clientIdentity(client)}`;
  const targetKeyRef = useRef(targetKey);

  const setCurrentConflict = useCallback((next: Error | null) => {
    conflictRef.current = next;
    setConflict(next);
  }, []);

  const validateRemoteDraft = useCallback(
    async (remote: NewSessionDraft, generation: number): Promise<ValidatedRemoteDraft | null> => {
      if (!resourceHydrationReady) return null;
      const hydratedResources = hydrateResources
        ? await hydrateResources(remote.resources)
        : remote.resources;
      if (generation !== targetGeneration.current) return null;
      const seen = new Set<string>();
      const fileRefs = hydratedResources.flatMap((resource) => {
        if (resource.kind !== "file" || seen.has(resource.fileId)) return [];
        seen.add(resource.fileId);
        return [resource];
      });
      const settled = await Promise.allSettled(
        fileRefs.map((resource) => client.getFile(workspaceId, resource.fileId)),
      );
      if (generation !== targetGeneration.current) return null;
      const files = settled.flatMap((result, index) => {
        if (result.status !== "fulfilled") return [];
        const file = result.value;
        const expected = fileRefs[index]?.fileId;
        return file.id === expected && file.workspaceId === workspaceId && file.status === "ready"
          ? [file]
          : [];
      });
      return {
        draft: remote,
        editable: {
          text: remote.text,
          resources: [
            ...hydratedResources.filter((resource) => resource.kind === "repository"),
            ...files.map((file): ResourceRef => ({ kind: "file", fileId: file.id })),
          ],
          tools: remote.tools,
          toolsProvided: remote.toolsProvided,
          model: remote.model,
          reasoningEffort: remote.reasoningEffort,
          latencyMode: remote.latencyMode ?? "standard",
          options: remote.options,
        },
        files,
      };
    },
    [client, hydrateResources, resourceHydrationReady, workspaceId],
  );

  const readRemote = useCallback(async (): Promise<ValidatedRemoteDraft | null> => {
    const generation = targetGeneration.current;
    const remote = normalizeLegacyNewSessionDraft(await client.getNewSessionDraft(workspaceId));
    if (generation !== targetGeneration.current) return null;
    return await validateRemoteDraft(remote, generation);
  }, [client, validateRemoteDraft, workspaceId]);

  const applyRemote = useCallback(
    (remote: ValidatedRemoteDraft): void => {
      draftRef.current = remote.draft;
      // A remote draft is projected through file revalidation before it enters
      // controlled browser state. Acknowledge that exact visible projection,
      // not the raw row (which may carry normalized mount paths, stale files,
      // or resource kinds this surface deliberately does not rehydrate).
      // Otherwise a read-only reload schedules an immediate write solely
      // because the two equivalent representations serialize differently.
      lastSavedSignature.current = draftSignature(remote.editable);
      setDraft(remote.draft);
      setCurrentConflict(null);
      setError(null);
      restoreReadyFilesRef.current(remote.files);
      onApplyRemoteRef.current(remote.editable);
    },
    [setCurrentConflict],
  );

  const reload = useCallback(async (): Promise<void> => {
    const generation = targetGeneration.current;
    loadingRef.current = true;
    setLoading(true);
    if (!resourceHydrationReady) return;
    try {
      const remote = await readRemote();
      if (remote && generation === targetGeneration.current) applyRemote(remote);
    } catch (cause) {
      if (generation === targetGeneration.current) setError(asError(cause));
    } finally {
      if (generation === targetGeneration.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [applyRemote, readRemote, resourceHydrationReady]);

  // `reload` intentionally follows resource hydration callbacks, but those
  // callbacks can change identity when a catalog refresh publishes a new
  // snapshot. Keep the effect below targeted to durable authority (the actor,
  // workspace/client, and readiness), not to an incidental callback identity.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // A client replacement represents a new authenticated actor. Reset all OCC
  // state before the first await, so no effect in this commit can persist the
  // prior actor/workspace value under the new target.
  useEffect(() => {
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
    }
    targetGeneration.current += 1;
    persistenceEpoch.current += 1;
    draftRef.current = null;
    lastSavedSignature.current = null;
    saveChain.current = Promise.resolve();
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    setDraft(null);
    setCurrentConflict(null);
    setError(null);
    setSaving(false);
    loadingRef.current = true;
    setLoading(true);
    return () => {
      targetGeneration.current += 1;
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    };
  }, [setCurrentConflict, targetKey]);

  // Initial/target reads wait for the catalogs required to validate resources.
  // A later catalog refresh keeps this boolean true and therefore does not
  // restart the read or fence a local/in-flight edit.
  useEffect(() => {
    if (resourceHydrationReady) void reloadRef.current();
  }, [resourceHydrationReady, targetKey]);

  const persistSnapshot = useCallback(
    (snapshot: NewSessionDraftEditable): Promise<FlushedNewSessionDraft | null> => {
      const generation = targetGeneration.current;
      const epoch = persistenceEpoch.current;
      const signature = draftSignature(snapshot);
      const run = async (): Promise<FlushedNewSessionDraft | null> => {
        if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
          return null;
        }
        const current = draftRef.current;
        if (!current) return null;
        if (signature === lastSavedSignature.current) {
          return { revision: current.revision, signature };
        }
        setSaving(true);
        try {
          const saved = await client.saveNewSessionDraft(workspaceId, {
            ...snapshot,
            expectedRevision: current.revision,
          });
          if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
            return null;
          }
          draftRef.current = saved;
          lastSavedSignature.current = signature;
          setDraft(saved);
          setCurrentConflict(null);
          setError(null);
          return { revision: saved.revision, signature };
        } catch (cause) {
          if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
            return null;
          }
          const problem = asError(cause);
          if (isNewSessionDraftConflict(cause)) setCurrentConflict(problem);
          setError(problem);
          return null;
        } finally {
          if (generation === targetGeneration.current && epoch === persistenceEpoch.current) {
            setSaving(false);
          }
        }
      };
      const operation = saveChain.current.then(run, run);
      saveChain.current = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    [client, setCurrentConflict, workspaceId],
  );

  const valueSignature = draftSignature(options.value);
  useEffect(() => {
    if (
      loading ||
      !draftRef.current ||
      conflictRef.current ||
      valueSignature === lastSavedSignature.current
    ) {
      return;
    }
    const snapshot = cloneEditable(valueRef.current);
    autosaveTimer.current = setTimeout(() => {
      autosaveTimer.current = null;
      void persistSnapshot(snapshot);
    }, 500);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    };
  }, [loading, persistSnapshot, valueSignature]);

  const flush = useCallback(async (): Promise<FlushedNewSessionDraft | null> => {
    if (loadingRef.current || conflictRef.current || !draftRef.current) return null;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    return await persistSnapshot(cloneEditable(valueRef.current));
  }, [persistSnapshot]);

  const isCurrentSignature = useCallback(
    (signature: string): boolean => draftSignature(valueRef.current) === signature,
    [],
  );

  const acknowledgeConsumed = useCallback(
    async (
      flushed: FlushedNewSessionDraft,
    ): Promise<AcknowledgeConsumedNewSessionDraftResult | null> => {
      const current = draftRef.current;
      if (
        !current ||
        current.revision !== flushed.revision ||
        lastSavedSignature.current !== flushed.signature
      ) {
        return null;
      }

      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;

      const generation = targetGeneration.current;
      const epoch = persistenceEpoch.current + 1;
      persistenceEpoch.current = epoch;
      const snapshot = cloneEditable(valueRef.current);
      const signature = draftSignature(snapshot);
      const priorSaves = saveChain.current;

      // Session creation accepted this exact server revision. Invalidate every
      // save that captured the old row as its OCC base, then wait for its
      // physical response before reading the safe seed. A late response must
      // not restore stale persistence authority or race the seed read.
      setCurrentConflict(null);
      setError(null);

      const run = async (): Promise<AcknowledgeConsumedNewSessionDraftResult | null> => {
        if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
          return null;
        }
        setSaving(true);
        try {
          await priorSaves;
          if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
            return null;
          }
          const remote = await readRemote();
          if (!remote || generation !== targetGeneration.current) return null;

          // A successful create turns the accepted revision into exactly one
          // newer safe seed. A larger revision proves that a sibling/in-flight
          // edit won after the create; never overwrite that newer authority.
          const expectedSeedRevision = flushed.revision + 1;
          if (remote.draft.revision > expectedSeedRevision) {
            const problem = new Error(
              "New-session defaults changed in another client while the session was created",
            );
            draftRef.current = remote.draft;
            lastSavedSignature.current = draftSignature(remote.editable);
            setDraft(remote.draft);
            setCurrentConflict(problem);
            setError(problem);
            return null;
          }
          if (remote.draft.revision < expectedSeedRevision) {
            const problem = new Error("New-session defaults were not seeded yet");
            setError(problem);
            return null;
          }

          draftRef.current = remote.draft;
          lastSavedSignature.current = draftSignature(remote.editable);
          setDraft(remote.draft);
          if (signature === flushed.signature) {
            // The server now owns the safe seed. Keep the post-create composer
            // UI-only until the next page load instead of persisting the
            // route's deliberate clear as a new empty draft.
            draftRef.current = null;
            lastSavedSignature.current = null;
            setDraft(null);
            return { kind: "consumed" };
          }

          // A newer local edit is the next draft. It may be saved only against
          // the exact safe-seed revision; OCC still fences a concurrent sibling
          // save that lands between this read and this write.
          const saved = await client.saveNewSessionDraft(workspaceId, {
            ...snapshot,
            expectedRevision: remote.draft.revision,
          });
          if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
            return null;
          }
          draftRef.current = saved;
          lastSavedSignature.current = signature;
          setDraft(saved);
          setCurrentConflict(null);
          setError(null);
          return {
            kind: "preserved",
            flushed: { revision: saved.revision, signature },
          };
        } catch (cause) {
          if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
            return null;
          }
          const problem = asError(cause);
          if (isNewSessionDraftConflict(cause)) setCurrentConflict(problem);
          setError(problem);
          return null;
        } finally {
          if (generation === targetGeneration.current && epoch === persistenceEpoch.current) {
            setSaving(false);
          }
        }
      };

      const operation = saveChain.current.then(run, run);
      saveChain.current = operation.then(
        () => undefined,
        () => undefined,
      );
      return await operation;
    },
    [client, readRemote, setCurrentConflict, workspaceId],
  );

  const resolveConflict = useCallback(
    async (choice: "keep_mine" | "use_remote"): Promise<void> => {
      if (choice === "use_remote") {
        await reload();
        return;
      }
      const mine = cloneEditable(valueRef.current);
      const generation = targetGeneration.current;
      loadingRef.current = true;
      setLoading(true);
      try {
        const remote = await readRemote();
        if (!remote || generation !== targetGeneration.current) return;
        draftRef.current = remote.draft;
        lastSavedSignature.current = draftSignature(remote.editable);
        setDraft(remote.draft);
        setCurrentConflict(null);
        await persistSnapshot(mine);
      } catch (cause) {
        if (generation === targetGeneration.current) setError(asError(cause));
      } finally {
        if (generation === targetGeneration.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [persistSnapshot, readRemote, reload, setCurrentConflict],
  );

  return {
    draft,
    revision: draft?.revision ?? 0,
    loading,
    saving,
    conflict,
    error,
    flush,
    isCurrentSignature,
    acknowledgeConsumed,
    reload,
    resolveConflict,
    clearError: useCallback(() => {
      setError(null);
      setCurrentConflict(null);
    }, [setCurrentConflict]),
  };
}

function cloneEditable(value: NewSessionDraftEditable): NewSessionDraftEditable {
  return structuredClone(value);
}

function normalizeLegacyNewSessionDraft(remote: NewSessionDraft): NewSessionDraft {
  // Old servers returned the tools array without the explicitness marker. The
  // old request contract made that array the user's complete selection, so an
  // absent marker must remain explicit (including an empty array) on a new
  // client rather than inheriting current workspace defaults.
  return {
    ...remote,
    toolsProvided: Object.hasOwn(remote, "toolsProvided") ? remote.toolsProvided : true,
    latencyMode: remote.latencyMode ?? "standard",
  };
}

function draftSignature(value: NewSessionDraftEditable): string {
  return stableJson(value);
}

function clientIdentity(client: object): number {
  let identity = clientIdentities.get(client);
  if (identity === undefined) {
    identity = nextClientIdentity;
    nextClientIdentity += 1;
    clientIdentities.set(client, identity);
  }
  return identity;
}

const clientIdentities = new WeakMap<object, number>();
let nextClientIdentity = 1;

function isNewSessionDraftConflict(cause: unknown): boolean {
  return (
    cause instanceof OpenGeniApiError &&
    cause.status === 409 &&
    cause.code === "NEW_SESSION_DRAFT_CONFLICT"
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
