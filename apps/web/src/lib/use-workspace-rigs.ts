import type { Rig } from "@opengeni/sdk";
import { useOpenGeni, useRigs, type UseRigsOptions } from "@opengeni/react";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

const EMPTY_RIGS: Rig[] = [];
const ignoreRefresh = async () => {};

// Keep stock-console catalog reads and retries inside the workspace grant.
export function useWorkspaceRigs(options: UseRigsOptions = {}) {
  const { workspaceId } = useOpenGeni();
  const { accessContext } = useAppContext();
  const canUse = hasWorkspacePermission(
    accessContext,
    options.workspaceId ?? workspaceId,
    "rigs:use",
  );
  const rigs = useRigs({ ...options, enabled: canUse && options.enabled !== false });
  return {
    ...rigs,
    rigs: canUse ? rigs.rigs : EMPTY_RIGS,
    loading: canUse && rigs.loading,
    error: canUse ? rigs.error : null,
    refresh: canUse ? rigs.refresh : ignoreRefresh,
  };
}
