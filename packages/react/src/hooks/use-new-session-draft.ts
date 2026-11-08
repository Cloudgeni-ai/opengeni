import type {
  FileAsset,
  NewSessionDraft,
  NewSessionSelectionHistory,
  OpenGeniClient,
  ResourceRef,
  SaveNewSessionDraftRequest,
} from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { OpenGeniContext } from "../session-context";
import {
  isTransientServiceFailure,
  retryTransient,
  TRANSIENT_RECONNECT_INTERVAL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
} from "../lib/transient-retry";

export type NewSessionDraftEditable = Omit<SaveNewSessionDraftRequest, "expectedRevision">;

export type UseNewSessionDraftOptions = {
  workspaceId: string;
  client: Pick<OpenGeniClient, "getNewSessionDraft" | "saveNewSessionDraft" | "getFile">;
  /** The complete browser-visible value. It must contain ready file refs only. */
  value: NewSessionDraftEditable;
  /** Apply a remote value to the controlled text/model/tool/options state. */
  onApplyRemote: (
    value: NewSessionDraftEditable,
    selectionHistory: NewSessionSelectionHistory,
    /** The caller's own default placement ("Your default machine"), when usable. */
    memberDefaultExecutionTarget: NewSessionDraft["memberDefaultExecutionTarget"] | null,
  ) => void;
  /** Replace finalized attachments with freshly revalidated server assets. */
  restoreReadyFiles: (files: Iterable<FileAsset>) => void;
  /** Revalidate non-file resource identities against the current UI catalog. */
  hydrateResources?: (resources: ResourceRef[]) => ResourceRef[] | Promise<ResourceRef[]>;
  /** Keep the first read pending until catalogs needed for hydration are ready. */
  resourceHydrationReady?: boolean;
  /** A create in flight owns the exact clicked snapshot; resume autosave on settlement. */
  suspendAutosave?: boolean;
  /** Test seam for the quiet retry backoff and the background reconnect pace. */
  transientRetry?: { delaysMs?: readonly number[]; reconnectIntervalMs?: number };
};

export type FlushedNewSessionDraft = {
  revision: number;
  /** Signature of the exact local snapshot acknowledged by this revision. */
  signature: string;
};

export type AcknowledgeConsumedNewSessionDraftResult =
  | { kind: "consumed" }
  | { kind: "preserved"; flushed: FlushedNewSessionDraft }
  /** A newer draft from another device stayed as the draft; the form now shows it. */
  | { kind: "followed" };

export type UseNewSessionDraftResult = {
  draft: NewSessionDraft | null;
  revision: number;
  loading: boolean;
  saving: boolean;
  conflict: Error | null;
  error: Error | null;
  /**
   * `error` only says Opengeni was briefly unreachable (a deploy or database
   * restart). Show the calm updating notice instead of the error; the hook
   * keeps reconnecting in the background and clears this on success.
   */
  unavailable: boolean;
  /** The latest failure, readable right after an awaited call (state lags a render). */
  currentError: () => Error | null;
  /** Mark Opengeni unreachable after a transient failure elsewhere in the send path. */
  reportUnavailable: (cause: unknown) => boolean;
  flush: () => Promise<FlushedNewSessionDraft | null>;
  /** Send the visible snapshot, rebasing a stale draft revision without replacing the composer. */
  flushForSend: (snapshot?: NewSessionDraftEditable) => Promise<FlushedNewSessionDraft | null>;
  isCurrentSignature: (signature: string) => boolean;
  /**
   * Fence the exact acknowledged snapshot after session creation consumes it,
   * preserving a genuinely newer local value against the safe-seed row.
   */
  acknowledgeConsumed: (
    flushed: FlushedNewSessionDraft,
    visibleSignature?: string,
  ) => Promise<AcknowledgeConsumedNewSessionDraftResult | null>;
  reload: () => Promise<void>;
  /** Surface a create-time OCC rejection through the ordinary draft recovery UI. */
  captureConflict: (cause: unknown) => boolean;
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
  const suspendAutosave = options.suspendAutosave ?? false;
  const hydrateResources = options.hydrateResources;
  const retryDelaysMs = options.transientRetry?.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const reconnectIntervalMs =
    options.transientRetry?.reconnectIntervalMs ?? TRANSIENT_RECONNECT_INTERVAL_MS;
  const [draft, setDraft] = useState<NewSessionDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Error | null>(null);
  const [error, setErrorState] = useState<Error | null>(null);
  const errorRef = useRef<Error | null>(null);
  const setError = useCallback((next: Error | null) => {
    errorRef.current = next;
    setErrorState(next);
  }, []);
  /**
   * Composer value when a first load failed. A background reconnect may apply
   * the remote draft only while the person has not edited since then.
   */
  const unloadedValueSignature = useRef<string | null>(null);
  const valueRef = useRef(options.value);
  valueRef.current = options.value;
  const onApplyRemoteRef = useRef(options.onApplyRemote);
  onApplyRemoteRef.current = options.onApplyRemote;
  const restoreReadyFilesRef = useRef(options.restoreReadyFiles);
  restoreReadyFilesRef.current = options.restoreReadyFiles;
  const draftRef = useRef<NewSessionDraft | null>(null);
  const lastSavedSignature = useRef<string | null>(null);
  // The newest draft revision this form saved or showed. A reconnect read
  // can make another device's newer draft the save base without showing it;
  // Send then goes ahead from this revision without saving, so the server
  // keeps that draft. 0 when the form has only typed over a draft it never
  // saw.
  const sendBasisRef = useRef<number | null>(null);
  // The create was refused over the draft. Only an older server does that,
  // and it accepts the Send only at the draft's current revision. It lasts
  // only until this form next learns that revision (a save, a followed
  // draft, or an accepted create).
  const createRefusedRef = useRef(false);
  const passiveProjectionSignature = useRef<string | null>(null);
  const pendingHydratedBaselineGeneration = useRef<number | null>(null);
  const targetGeneration = useRef(0);
  const persistenceEpoch = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictRef = useRef<Error | null>(null);
  const loadingRef = useRef(true);
  const activeRemoteReads = useRef(new Set<AbortController>());
  const targetKey = `${workspaceId}\u0000${clientIdentity(client)}`;
  const targetKeyRef = useRef(targetKey);

  const setCurrentConflict = useCallback((next: Error | null) => {
    conflictRef.current = next;
    setConflict(next);
  }, []);

  const captureConflict = useCallback(
    (cause: unknown): boolean => {
      if (!isNewSessionDraftConflict(cause)) return false;
      const problem = asError(cause);
      createRefusedRef.current = true;
      setCurrentConflict(problem);
      setError(problem);
      return true;
    },
    [setCurrentConflict, setError],
  );

  const abortActiveRemoteReads = useCallback(() => {
    for (const controller of activeRemoteReads.current) controller.abort();
    activeRemoteReads.current.clear();
  }, []);

  const validateRemoteDraft = useCallback(
    async (
      remote: NewSessionDraft,
      generation: number,
      signal: AbortSignal,
    ): Promise<ValidatedRemoteDraft | null> => {
      if (!resourceHydrationReady || signal.aborted) return null;
      const hydratedResources = hydrateResources
        ? await hydrateResources(remote.resources)
        : remote.resources;
      if (generation !== targetGeneration.current || signal.aborted) return null;
      const seen = new Set<string>();
      const fileRefs = hydratedResources.flatMap((resource) => {
        if (resource.kind !== "file" || seen.has(resource.fileId)) return [];
        seen.add(resource.fileId);
        return [resource];
      });
      const settled = await Promise.allSettled(
        fileRefs.map((resource) =>
          retryTransient(() => client.getFile(workspaceId, resource.fileId, { signal }), {
            signal,
            delaysMs: retryDelaysMs,
          }),
        ),
      );
      if (generation !== targetGeneration.current || signal.aborted) return null;
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
            ...files.map(
              (file): ResourceRef => ({
                kind: "file",
                fileId: file.id,
              }),
            ),
          ],
          tools: remote.tools,
          toolsProvided: remote.toolsProvided,
          model: remote.model,
          reasoningEffort: remote.reasoningEffort,
          latencyMode: remote.latencyMode ?? "standard",
          ...(remote.modelProvided !== undefined ? { modelProvided: remote.modelProvided } : {}),
          ...(Object.hasOwn(remote, "selectedProjectChannelId")
            ? { selectedProjectChannelId: remote.selectedProjectChannelId }
            : {}),
          options: remote.options,
        },
        files,
      };
    },
    [client, hydrateResources, resourceHydrationReady, retryDelaysMs, workspaceId],
  );

  const readRemote = useCallback(
    async (quietRetries = true): Promise<ValidatedRemoteDraft | null> => {
      const controller = new AbortController();
      activeRemoteReads.current.add(controller);
      const generation = targetGeneration.current;
      try {
        // A deploy or database restart answers 502/503 for a few seconds; the
        // read is safe to repeat, so retry it quietly before reporting anything.
        const remote = normalizeLegacyNewSessionDraft(
          await retryTransient(
            () => client.getNewSessionDraft(workspaceId, { signal: controller.signal }),
            {
              signal: controller.signal,
              shouldContinue: () => generation === targetGeneration.current,
              delaysMs: quietRetries ? retryDelaysMs : [],
            },
          ),
        );
        if (generation !== targetGeneration.current || controller.signal.aborted) return null;
        return await validateRemoteDraft(remote, generation, controller.signal);
      } finally {
        activeRemoteReads.current.delete(controller);
      }
    },
    [client, retryDelaysMs, validateRemoteDraft, workspaceId],
  );

  const applyRemote = useCallback(
    (remote: ValidatedRemoteDraft): void => {
      draftRef.current = remote.draft;
      sendBasisRef.current = remote.draft.revision;
      createRefusedRef.current = false;
      // The box shows this draft from now on, before React renders it, so a
      // save queued for the previous box sees it as stale.
      valueRef.current = cloneEditable(remote.editable);
      // A GET may project away revoked files, repositories, or tools without
      // changing the stored row. This signature suppresses passive autosave;
      // explicit Send always writes its exact snapshot before create.
      lastSavedSignature.current = draftSignature(remote.editable);
      passiveProjectionSignature.current = null;
      pendingHydratedBaselineGeneration.current = targetGeneration.current;
      unloadedValueSignature.current = null;
      setDraft(remote.draft);
      setCurrentConflict(null);
      setError(null);
      restoreReadyFilesRef.current(remote.files);
      onApplyRemoteRef.current(
        remote.editable,
        remote.draft.selectionHistory,
        remote.draft.memberDefaultExecutionTarget ?? null,
      );
    },
    [setCurrentConflict, setError],
  );

  const reload = useCallback(async (): Promise<void> => {
    if (!resourceHydrationReady) return;
    const generation = targetGeneration.current;
    const valueAtStart = draftSignature(valueRef.current);
    loadingRef.current = true;
    setLoading(true);
    try {
      const remote = await readRemote();
      if (remote && generation === targetGeneration.current) applyRemote(remote);
    } catch (cause) {
      if (generation === targetGeneration.current) {
        if (!draftRef.current) unloadedValueSignature.current = valueAtStart;
        setError(asError(cause));
      }
    } finally {
      if (generation === targetGeneration.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [applyRemote, readRemote, resourceHydrationReady, setError]);

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
    abortActiveRemoteReads();
    persistenceEpoch.current += 1;
    draftRef.current = null;
    sendBasisRef.current = null;
    createRefusedRef.current = false;
    lastSavedSignature.current = null;
    passiveProjectionSignature.current = null;
    pendingHydratedBaselineGeneration.current = null;
    unloadedValueSignature.current = null;
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
      abortActiveRemoteReads();
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    };
  }, [abortActiveRemoteReads, setCurrentConflict, setError, targetKey]);

  // Initial/target reads wait for the catalogs required to validate resources.
  // A later catalog refresh keeps this boolean true and therefore does not
  // restart the read or fence a local/in-flight edit.
  useEffect(() => {
    if (resourceHydrationReady) void reloadRef.current();
  }, [resourceHydrationReady, targetKey]);

  const persistSnapshot = useCallback(
    (
      snapshot: NewSessionDraftEditable,
      force = false,
      rebase = true,
      onlyIfCurrent = false,
    ): Promise<FlushedNewSessionDraft | null> => {
      const generation = targetGeneration.current;
      const epoch = persistenceEpoch.current;
      const signature = draftSignature(snapshot);
      const run = async (): Promise<FlushedNewSessionDraft | null> => {
        if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
          return null;
        }
        const current = draftRef.current;
        if (!current) return null;
        if (!force && signature === lastSavedSignature.current) {
          return { revision: current.revision, signature };
        }
        // An autosave queued behind other work whose snapshot is no longer in
        // the box (the form followed another device's draft meanwhile) is
        // stale: saving it would write over that draft. Any later change to
        // the box starts its own autosave.
        if (onlyIfCurrent && signature !== draftSignature(valueRef.current)) return null;
        setSaving(true);
        // A newer draft saved on another device is saved over: this composer
        // saves only what is being typed in it, so the latest typing wins.
        // An autosave of a box holding no message has no typing to keep, so
        // it never lands on another device's message this form never showed:
        // a save base the form never showed is checked first, and a newer
        // draft it meets is read before anything is saved on top of it.
        const emptyAutosave = onlyIfCurrent && !holdsMessage(snapshot);
        let expectedRevision =
          emptyAutosave && sendBasisRef.current !== null && sendBasisRef.current < current.revision
            ? sendBasisRef.current
            : current.revision;
        const newer: { message: ValidatedRemoteDraft | null } = { message: null };
        try {
          const save = async (): Promise<NewSessionDraft> => {
            for (let attempt = 0; ; attempt += 1) {
              try {
                return await client.saveNewSessionDraft(workspaceId, {
                  ...snapshot,
                  expectedRevision,
                });
              } catch (cause) {
                const currentRevision = newSessionDraftConflictRevision(cause);
                const superseded =
                  attempt >= 2 ||
                  generation !== targetGeneration.current ||
                  epoch !== persistenceEpoch.current;
                if (emptyAutosave && !superseded && isNewSessionDraftConflict(cause)) {
                  const remote = await readRemote();
                  if (
                    !remote ||
                    generation !== targetGeneration.current ||
                    epoch !== persistenceEpoch.current
                  ) {
                    throw cause;
                  }
                  // Another device's message is kept and followed; picks over
                  // a draft holding no message still save on top of it.
                  if (holdsMessage(remote.editable)) {
                    newer.message = remote;
                    throw cause;
                  }
                  expectedRevision = remote.draft.revision;
                  continue;
                }
                // A save that was superseded meanwhile (another target, or
                // Send taking over the draft) is dropped, never rebased.
                if (!rebase || currentRevision === undefined || superseded) {
                  throw cause;
                }
                expectedRevision = currentRevision;
              }
            }
          };
          // Send's save is idempotent by construction: it writes one exact
          // snapshot against one expected revision. If an unconfirmed attempt
          // did commit, the repeat is a revision conflict, which flushForSend
          // recognises as this form's own write by rereading, so it can never
          // apply twice.
          const saved = force
            ? await retryTransient(save, {
                shouldContinue: () =>
                  generation === targetGeneration.current && epoch === persistenceEpoch.current,
                delaysMs: retryDelaysMs,
              })
            : await save();
          if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
            return null;
          }
          draftRef.current = saved;
          sendBasisRef.current = saved.revision;
          createRefusedRef.current = false;
          lastSavedSignature.current = signature;
          passiveProjectionSignature.current = null;
          setDraft(saved);
          setCurrentConflict(null);
          setError(null);
          return { revision: saved.revision, signature };
        } catch (cause) {
          if (generation !== targetGeneration.current || epoch !== persistenceEpoch.current) {
            return null;
          }
          if (newer.message) {
            // The form follows the other device's message while its box
            // still holds none; typing since then saves on top of it.
            if (!holdsMessage(valueRef.current)) applyRemote(newer.message);
            setCurrentConflict(null);
            setError(null);
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
    [applyRemote, client, readRemote, retryDelaysMs, setCurrentConflict, setError, workspaceId],
  );

  const valueSignature = draftSignature(options.value);
  useEffect(() => {
    if (
      !loading &&
      draftRef.current &&
      pendingHydratedBaselineGeneration.current === targetGeneration.current
    ) {
      // Route hydration may deliberately project the durable row through newer
      // route intent (Recents/Default/named project) and therefore change its
      // compute/provenance representation. The first complete controlled value
      // after onApplyRemote is a passive-autosave baseline only. It is not a
      // durable acknowledgement: an immediate create-time flush must persist
      // this projection against the remote revision before exact create.
      pendingHydratedBaselineGeneration.current = null;
      passiveProjectionSignature.current = valueSignature;
      return;
    }
    if (
      loading ||
      suspendAutosave ||
      !draftRef.current ||
      conflictRef.current ||
      valueSignature === lastSavedSignature.current ||
      valueSignature === passiveProjectionSignature.current
    ) {
      return;
    }
    passiveProjectionSignature.current = null;
    const snapshot = cloneEditable(valueRef.current);
    autosaveTimer.current = setTimeout(() => {
      autosaveTimer.current = null;
      void persistSnapshot(snapshot, false, true, true);
    }, 500);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    };
  }, [loading, persistSnapshot, suspendAutosave, valueSignature]);

  const flush = useCallback(async (): Promise<FlushedNewSessionDraft | null> => {
    if (loadingRef.current || conflictRef.current || !draftRef.current) return null;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    return await persistSnapshot(cloneEditable(valueRef.current));
  }, [persistSnapshot]);

  const flushForSend = useCallback(
    async (sendSnapshot?: NewSessionDraftEditable): Promise<FlushedNewSessionDraft | null> => {
      if (loadingRef.current) return null;
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
      const snapshot = cloneEditable(sendSnapshot ?? valueRef.current);
      const generation = targetGeneration.current;
      if (!draftRef.current) {
        // A consumed draft can be followed by a newer local edit. Reacquire
        // the safe seed before preserving that edit.
        try {
          const remote = await readRemote();
          if (!remote || generation !== targetGeneration.current) return null;
          draftRef.current = remote.draft;
          // This form never showed what it reads here. Another device's
          // message is not a basis, so Send keeps it instead of saving over it.
          sendBasisRef.current =
            !holdsMessage(remote.editable) ||
            draftSignature(remote.editable) === draftSignature(snapshot)
              ? remote.draft.revision
              : 0;
          lastSavedSignature.current = draftSignature(remote.editable);
          setDraft(remote.draft);
        } catch (cause) {
          if (generation === targetGeneration.current) setError(asError(cause));
          return null;
        }
      }
      if (generation !== targetGeneration.current) return null;
      // The route clears the visible error after a refused create, so the
      // refusal itself also asks for the reread.
      if (conflictRef.current || createRefusedRef.current) {
        // A refusal already seen (an older server that still fences Send on
        // the draft, or a save that met another device's) leaves an unknown
        // base: read it once before saving.
        await saveChain.current;
        const refused = createRefusedRef.current;
        createRefusedRef.current = false;
        try {
          const remote = await readRemote();
          if (!remote || generation !== targetGeneration.current) return null;
          draftRef.current = remote.draft;
          // Another device's message read here was never shown: it is not a
          // basis, so Send keeps it instead of saving over it. After an older
          // server refused the create, the current revision is the only basis
          // it accepts.
          if (
            refused ||
            !holdsMessage(remote.editable) ||
            draftSignature(remote.editable) === draftSignature(snapshot)
          ) {
            sendBasisRef.current = remote.draft.revision;
          } else {
            sendBasisRef.current ??= 0;
          }
          lastSavedSignature.current = draftSignature(remote.editable);
          passiveProjectionSignature.current = null;
          setDraft(remote.draft);
          setCurrentConflict(null);
          setError(null);
        } catch (cause) {
          // The reread is still owed to the next Send.
          if (refused) createRefusedRef.current = true;
          if (generation === targetGeneration.current) setError(asError(cause));
          return null;
        }
      }
      // A save of this form that is still running decides the basis: it is
      // this form's own write.
      await saveChain.current;
      if (generation !== targetGeneration.current) return null;
      const sentFrom = (): FlushedNewSessionDraft | null => {
        const base = draftRef.current;
        if (!base || generation !== targetGeneration.current) return null;
        const basis = sendBasisRef.current;
        return {
          revision: basis !== null && basis < base.revision ? basis : base.revision,
          signature: draftSignature(snapshot),
        };
      };
      // The save base is another device's draft this form never showed (a
      // reconnect read while typing): Send goes ahead from the draft as last
      // seen without saving, and the server keeps that newer draft.
      const basis = sendBasisRef.current;
      if (draftRef.current && basis !== null && basis < draftRef.current.revision) {
        return sentFrom();
      }
      // GET can be a sanitized projection of a different stored row. An
      // explicit Send always writes its clicked snapshot, even when its
      // signature appears unchanged. It never writes over a newer draft from
      // another device: on a conflict it sends from the draft as last seen,
      // and the server keeps that newer draft.
      const flushed = await persistSnapshot(snapshot, true, false);
      if (flushed) return flushed;
      // The save only keeps the draft in step: Send carries the snapshot
      // itself. Unless Opengeni is unreachable, it goes ahead from the draft
      // as last seen, which the server clears only if nothing newer replaced it.
      if (generation !== targetGeneration.current || isTransientServiceFailure(errorRef.current)) {
        return null;
      }
      if (isNewSessionDraftConflict(errorRef.current)) {
        // A save whose reply was lost can have committed, so its retry finds
        // the draft moved on. A draft holding exactly this snapshot is this
        // form's own write: go ahead from it.
        try {
          const remote = await readRemote(false);
          if (
            remote &&
            generation === targetGeneration.current &&
            draftSignature(remote.editable) === draftSignature(snapshot)
          ) {
            draftRef.current = remote.draft;
            sendBasisRef.current = remote.draft.revision;
            lastSavedSignature.current = draftSignature(snapshot);
            passiveProjectionSignature.current = null;
            setDraft(remote.draft);
          }
        } catch {
          // The draft as last seen still serves as the basis.
        }
      }
      setCurrentConflict(null);
      setError(null);
      return sentFrom();
    },
    [persistSnapshot, readRemote, setCurrentConflict, setError],
  );

  const isCurrentSignature = useCallback(
    (signature: string): boolean => draftSignature(valueRef.current) === signature,
    [],
  );

  const acknowledgeConsumed = useCallback(
    async (
      flushed: FlushedNewSessionDraft,
      visibleSignature = flushed.signature,
    ): Promise<AcknowledgeConsumedNewSessionDraftResult | null> => {
      // The create was accepted, so no older server's refusal is pending.
      createRefusedRef.current = false;
      const current = draftRef.current;
      // A Send that went ahead from an older basis leaves a newer save base.
      if (!current || current.revision < flushed.revision) return null;

      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;

      const generation = targetGeneration.current;
      const epoch = persistenceEpoch.current + 1;
      persistenceEpoch.current = epoch;
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
          // A cleared draft is the next-create seed: no text and no files. A
          // revision past that seed, or one that still holds a message, is a
          // newer draft another device saved.
          const keptNewer =
            remote.draft.revision > expectedSeedRevision ||
            (remote.draft.revision === expectedSeedRevision && holdsMessage(remote.editable));
          if (keptNewer) {
            // Another device saved a newer draft. It stays as the draft, and a
            // form showing only the sent message, or nothing (a form emptied
            // as it sent), now shows it instead.
            if (
              draftSignature(valueRef.current) === visibleSignature ||
              !holdsMessage(valueRef.current)
            ) {
              applyRemote(remote);
              return { kind: "followed" };
            }
            draftRef.current = remote.draft;
            lastSavedSignature.current = draftSignature(remote.editable);
            passiveProjectionSignature.current = null;
            setDraft(remote.draft);
            return null;
          }
          if (remote.draft.revision < expectedSeedRevision) {
            const problem = new Error("New-session defaults were not seeded yet");
            setError(problem);
            return null;
          }

          draftRef.current = remote.draft;
          sendBasisRef.current = remote.draft.revision;
          lastSavedSignature.current = draftSignature(remote.editable);
          passiveProjectionSignature.current = null;
          setDraft(remote.draft);
          // Typing may continue while the safe-seed fetch is pending.
          const snapshot = cloneEditable(valueRef.current);
          const signature = draftSignature(snapshot);
          if (signature === visibleSignature) {
            // The server now owns the safe seed. Keep the post-create composer
            // UI-only until the next page load instead of persisting the
            // route's deliberate clear as a new empty draft.
            draftRef.current = null;
            sendBasisRef.current = null;
            lastSavedSignature.current = null;
            passiveProjectionSignature.current = null;
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
          sendBasisRef.current = saved.revision;
          lastSavedSignature.current = signature;
          passiveProjectionSignature.current = null;
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
    [applyRemote, client, readRemote, setCurrentConflict, setError, workspaceId],
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
        sendBasisRef.current = remote.draft.revision;
        lastSavedSignature.current = draftSignature(remote.editable);
        passiveProjectionSignature.current = null;
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
    [persistSnapshot, readRemote, reload, setCurrentConflict, setError],
  );

  const unavailable = error !== null && conflict === null && isTransientServiceFailure(error);

  // This person's new-chat draft changed on another of their devices. A form
  // that isn't being typed in follows it; one being typed in keeps its text,
  // and its next save goes on top of the newer draft.
  const draftsEvent = useContext(OpenGeniContext)?.workspaceDraftsEvent ?? null;
  useEffect(() => {
    if (!draftsEvent?.newSession || draftsEvent.workspaceId !== workspaceId) return;
    const generation = targetGeneration.current;
    const idle = () =>
      !loadingRef.current &&
      autosaveTimer.current === null &&
      (draftRef.current === null
        ? // A form whose draft was just sent holds no message to keep. A
          // model, project or visibility picked on it since is replaced by
          // the followed draft, like any other setting of that draft.
          !holdsMessage(valueRef.current)
        : draftSignature(valueRef.current) === lastSavedSignature.current ||
          draftSignature(valueRef.current) === passiveProjectionSignature.current);
    if (!idle()) return;
    void (async () => {
      try {
        await saveChain.current;
        const remote = await readRemote(false);
        if (!remote || generation !== targetGeneration.current || !idle()) return;
        if (remote.draft.revision <= (draftRef.current?.revision ?? 0)) return;
        // A sent form stays cleared until another device saves a message.
        if (draftRef.current === null && !holdsMessage(remote.editable)) return;
        applyRemote(remote);
      } catch {
        // A missed follow is harmless: the next hint or read catches up.
      }
    })();
  }, [applyRemote, draftsEvent, readRemote, workspaceId]);

  /**
   * Re-read after Opengeni was unreachable. The remote draft replaces the
   * composer only when the first load never succeeded and nothing was typed
   * since; otherwise it only becomes the save base, so local text survives and
   * an unconfirmed save is reconciled by what the server actually holds.
   */
  const reconnect = useCallback(async (): Promise<void> => {
    if (!resourceHydrationReady) return;
    const generation = targetGeneration.current;
    try {
      // One attempt per tick: the loop itself is the retry.
      const remote = await readRemote(false);
      if (!remote || generation !== targetGeneration.current) return;
      if (
        !draftRef.current &&
        unloadedValueSignature.current !== null &&
        unloadedValueSignature.current === draftSignature(valueRef.current)
      ) {
        applyRemote(remote);
        return;
      }
      unloadedValueSignature.current = null;
      draftRef.current = remote.draft;
      // The form keeps its own text, so the remote draft is shown only when it
      // matches that text; one holding no message has nothing to lose.
      if (
        !holdsMessage(remote.editable) ||
        draftSignature(remote.editable) === draftSignature(valueRef.current)
      ) {
        sendBasisRef.current = remote.draft.revision;
      } else {
        sendBasisRef.current ??= 0;
      }
      lastSavedSignature.current = draftSignature(remote.editable);
      passiveProjectionSignature.current = null;
      setDraft(remote.draft);
      setError(null);
    } catch (cause) {
      if (generation === targetGeneration.current) setError(asError(cause));
    }
  }, [applyRemote, readRemote, resourceHydrationReady, setError]);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  useEffect(() => {
    if (!unavailable) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      timer = setTimeout(() => {
        if (stopped) return;
        void reconnectRef.current().finally(() => {
          if (!stopped) tick();
        });
      }, reconnectIntervalMs);
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [unavailable, reconnectIntervalMs, targetKey]);

  return {
    draft,
    revision: draft?.revision ?? 0,
    loading,
    saving,
    conflict,
    error,
    unavailable,
    currentError: useCallback(() => errorRef.current, []),
    reportUnavailable: useCallback(
      (cause: unknown): boolean => {
        if (!isTransientServiceFailure(cause)) return false;
        setError(asError(cause));
        return true;
      },
      [setError],
    ),
    flush,
    flushForSend,
    isCurrentSignature,
    acknowledgeConsumed,
    reload,
    captureConflict,
    resolveConflict,
    clearError: useCallback(() => {
      setError(null);
      setCurrentConflict(null);
    }, [setCurrentConflict, setError]),
  };
}

function cloneEditable(value: NewSessionDraftEditable): NewSessionDraftEditable {
  return structuredClone(value);
}

/** Whether a new-chat draft holds a message: text or files. */
function holdsMessage(value: NewSessionDraftEditable): boolean {
  return value.text.length > 0 || value.resources.some((resource) => resource.kind === "file");
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
    selectionHistory: remote.selectionHistory ?? { projects: [] },
  };
}

function draftSignature(value: NewSessionDraftEditable): string {
  return JSON.stringify(sortedJson(value));
}

/** Key-sorted copy so equal drafts compare equal regardless of key order. */
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortedJson(nested)]),
    );
  }
  return value;
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

export function isNewSessionDraftConflict(cause: unknown): boolean {
  return (
    cause instanceof OpenGeniApiError &&
    cause.status === 409 &&
    cause.code === "NEW_SESSION_DRAFT_CONFLICT"
  );
}

/**
 * The draft revision the server held when it refused a Send as a draft
 * conflict, or undefined when the refusal does not say (an older server).
 * Equal to the revision this Send just saved, it means nothing else changed
 * the draft: the Send and its own draft disagree, and a retry cannot help.
 */
export function newSessionDraftConflictRevision(cause: unknown): number | undefined {
  if (!isNewSessionDraftConflict(cause)) return undefined;
  const error = cause as OpenGeniApiError;
  const detailed = error.details?.["currentRevision"];
  if (typeof detailed === "number") return detailed;
  try {
    const body = JSON.parse(error.body) as {
      currentRevision?: unknown;
      error?: { currentRevision?: unknown };
    };
    const revision = body.currentRevision ?? body.error?.currentRevision;
    return typeof revision === "number" ? revision : undefined;
  } catch {
    return undefined;
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
