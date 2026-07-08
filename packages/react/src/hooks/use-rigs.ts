import type {
  CreateRigRequest,
  ProposeRigChangeRequest,
  Rig,
  RigChange,
  RigVersion,
  UpdateRigRequest,
} from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue } from "./internal";

export type UseRigsOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseRigsResult = {
  rigs: Rig[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (request: CreateRigRequest) => Promise<Rig | null>;
  update: (rigId: string, request: UpdateRigRequest) => Promise<Rig | null>;
  remove: (rigId: string) => Promise<boolean>;
  listVersions: (rigId: string) => Promise<RigVersion[] | null>;
  activateVersion: (rigId: string, versionId: string) => Promise<RigVersion | null>;
  listChanges: (rigId: string) => Promise<RigChange[] | null>;
  proposeChange: (rigId: string, request: ProposeRigChangeRequest) => Promise<RigChange | null>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * Rigs (workspace-scoped, versioned sandbox machine definitions). The list
 * polls; version/change reads are on-demand (they are per-rig detail, not part
 * of the list surface).
 */
export function useRigs(options: UseRigsOptions = {}): UseRigsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(async () => await client.listRigs(workspaceId), [client, workspaceId]);
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled: options.enabled });
  const mutation = useMutationRunner();

  const create = useCallback(
    async (request: CreateRigRequest): Promise<Rig | null> => {
      const result = await mutation.run(() => client.createRig(workspaceId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const update = useCallback(
    async (rigId: string, request: UpdateRigRequest): Promise<Rig | null> => {
      const result = await mutation.run(() => client.updateRig(workspaceId, rigId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const remove = useCallback(
    async (rigId: string): Promise<boolean> => {
      const result = await mutation.run(async () => {
        await client.deleteRig(workspaceId, rigId);
        return true;
      });
      if (result) {
        await state.refresh();
      }
      return result === true;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const listVersions = useCallback(
    async (rigId: string): Promise<RigVersion[] | null> => {
      return await mutation.run(() => client.listRigVersions(workspaceId, rigId));
    },
    [client, workspaceId, mutation.run],
  );

  const activateVersion = useCallback(
    async (rigId: string, versionId: string): Promise<RigVersion | null> => {
      const result = await mutation.run(() => client.activateRigVersion(workspaceId, rigId, versionId));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  const listChanges = useCallback(
    async (rigId: string): Promise<RigChange[] | null> => {
      return await mutation.run(() => client.listRigChanges(workspaceId, rigId));
    },
    [client, workspaceId, mutation.run],
  );

  const proposeChange = useCallback(
    async (rigId: string, request: ProposeRigChangeRequest): Promise<RigChange | null> => {
      const result = await mutation.run(() => client.proposeRigChange(workspaceId, rigId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, mutation.run, state.refresh],
  );

  return {
    rigs: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
    create,
    update,
    remove,
    listVersions,
    activateVersion,
    listChanges,
    proposeChange,
    mutating: mutation.mutating,
    mutationError: mutation.mutationError,
    clearMutationError: mutation.clearMutationError,
  };
}

export type UseRigOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseRigResult = {
  rig: Rig | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  update: (request: UpdateRigRequest) => Promise<Rig | null>;
  remove: () => Promise<boolean>;
  activateVersion: (versionId: string) => Promise<RigVersion | null>;
  proposeChange: (request: ProposeRigChangeRequest) => Promise<RigChange | null>;
  /** Re-run verification for a change (asynchronous — poll for the outcome). */
  verifyChange: (changeId: string) => Promise<RigChange | null>;
  /** Promote a verified definition_edit into a new active version (rigs:manage). */
  promoteChange: (changeId: string) => Promise<RigVersion | null>;
  /** Re-verify the active version's checks in a clean throwaway sandbox. */
  verify: () => Promise<{ ok: boolean; versionId: string } | null>;
  mutating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/**
 * A single rig (its active version + counts), polled so verification and
 * promotion state stay live. Owns the rig's write actions; the versions and
 * changes lists are separate polled reads (`useRigVersions`/`useRigChanges`).
 */
export function useRig(rigId: string, options: UseRigOptions = {}): UseRigResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(async () => await client.getRig(workspaceId, rigId), [client, workspaceId, rigId]);
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled: options.enabled });
  const mutation = useMutationRunner();

  const update = useCallback(
    async (request: UpdateRigRequest): Promise<Rig | null> => {
      const result = await mutation.run(() => client.updateRig(workspaceId, rigId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, rigId, mutation.run, state.refresh],
  );

  const remove = useCallback(
    async (): Promise<boolean> => {
      const result = await mutation.run(async () => {
        await client.deleteRig(workspaceId, rigId);
        return true;
      });
      return result === true;
    },
    [client, workspaceId, rigId, mutation.run],
  );

  const activateVersion = useCallback(
    async (versionId: string): Promise<RigVersion | null> => {
      const result = await mutation.run(() => client.activateRigVersion(workspaceId, rigId, versionId));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, rigId, mutation.run, state.refresh],
  );

  const proposeChange = useCallback(
    async (request: ProposeRigChangeRequest): Promise<RigChange | null> => {
      const result = await mutation.run(() => client.proposeRigChange(workspaceId, rigId, request));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, rigId, mutation.run, state.refresh],
  );

  const verifyChange = useCallback(
    async (changeId: string): Promise<RigChange | null> => {
      const result = await mutation.run(() => client.verifyRigChange(workspaceId, rigId, changeId));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, rigId, mutation.run, state.refresh],
  );

  const promoteChange = useCallback(
    async (changeId: string): Promise<RigVersion | null> => {
      const result = await mutation.run(() => client.promoteRigChange(workspaceId, rigId, changeId));
      if (result) {
        await state.refresh();
      }
      return result;
    },
    [client, workspaceId, rigId, mutation.run, state.refresh],
  );

  const verify = useCallback(
    async (): Promise<{ ok: boolean; versionId: string } | null> => {
      return await mutation.run(() => client.verifyRig(workspaceId, rigId));
    },
    [client, workspaceId, rigId, mutation.run],
  );

  return {
    rig: state.data,
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
    update,
    remove,
    activateVersion,
    proposeChange,
    verifyChange,
    promoteChange,
    verify,
    mutating: mutation.mutating,
    mutationError: mutation.mutationError,
    clearMutationError: mutation.clearMutationError,
  };
}

export type UseRigVersionsOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseRigVersionsResult = {
  versions: RigVersion[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/** A rig's append-only version history, newest-first (polled). */
export function useRigVersions(rigId: string, options: UseRigVersionsOptions = {}): UseRigVersionsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(async () => await client.listRigVersions(workspaceId, rigId), [client, workspaceId, rigId]);
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled: options.enabled });
  return { versions: state.data ?? [], loading: state.loading, error: state.error, refresh: state.refresh };
}

export type UseRigChangesOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseRigChangesResult = {
  changes: RigChange[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/**
 * A rig's change queue (polled). The default poll cadence lets a change move
 * through verifying → merged/rejected without a manual refresh.
 */
export function useRigChanges(rigId: string, options: UseRigChangesOptions = {}): UseRigChangesResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(async () => await client.listRigChanges(workspaceId, rigId), [client, workspaceId, rigId]);
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled: options.enabled });
  return { changes: state.data ?? [], loading: state.loading, error: state.error, refresh: state.refresh };
}
