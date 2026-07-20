import { stableJson } from "@opengeni/contracts";
import type {
  FileAsset,
  NewSessionDraft,
  OpenGeniClient,
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
};

export type FlushedNewSessionDraft = {
  revision: number;
  /** Signature of the exact local snapshot acknowledged by this revision. */
  signature: string;
};

export type UseNewSessionDraftResult = {
  draft: NewSessionDraft | null;
  revision: number;
  loading: boolean;
  saving: boolean;
  conflict: Error | null;
  error: Error | null;
  flush: () => Promise<FlushedNewSessionDraft | null>;
  isCurrentSignature: (signature: string) => boolean;
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
      const seen = new Set<string>();
      const fileRefs = remote.resources.flatMap((resource) => {
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
          // Repository state is not persisted by this browser surface until it
          // has visible repository rehydration. Revalidated ready files are the
          // only resource identities restored here.
          resources: files.map((file) => ({ kind: "file", fileId: file.id })),
          tools: remote.tools,
          model: remote.model,
          reasoningEffort: remote.reasoningEffort,
          options: remote.options,
        },
        files,
      };
    },
    [client, workspaceId],
  );

  const readRemote = useCallback(async (): Promise<ValidatedRemoteDraft | null> => {
    const generation = targetGeneration.current;
    const remote = await client.getNewSessionDraft(workspaceId);
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
  }, [applyRemote, readRemote]);

  // A client replacement represents a new authenticated actor. Reset all OCC
  // state before the first await, so no effect in this commit can persist the
  // prior actor/workspace value under the new target.
  useEffect(() => {
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
    }
    targetGeneration.current += 1;
    draftRef.current = null;
    lastSavedSignature.current = null;
    saveChain.current = Promise.resolve();
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    setDraft(null);
    setCurrentConflict(null);
    setError(null);
    setSaving(false);
    void reload();
    return () => {
      targetGeneration.current += 1;
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    };
  }, [reload, setCurrentConflict, targetKey]);

  const persistSnapshot = useCallback(
    (snapshot: NewSessionDraftEditable): Promise<FlushedNewSessionDraft | null> => {
      const generation = targetGeneration.current;
      const signature = draftSignature(snapshot);
      const run = async (): Promise<FlushedNewSessionDraft | null> => {
        if (generation !== targetGeneration.current) return null;
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
          if (generation !== targetGeneration.current) return null;
          draftRef.current = saved;
          lastSavedSignature.current = signature;
          setDraft(saved);
          setCurrentConflict(null);
          setError(null);
          return { revision: saved.revision, signature };
        } catch (cause) {
          if (generation !== targetGeneration.current) return null;
          const problem = asError(cause);
          if (isNewSessionDraftConflict(cause)) setCurrentConflict(problem);
          setError(problem);
          return null;
        } finally {
          if (generation === targetGeneration.current) setSaving(false);
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
