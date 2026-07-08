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
