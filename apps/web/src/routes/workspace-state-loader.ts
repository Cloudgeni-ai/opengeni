import type { OpenGeniClient, WorkspaceStateResponse } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

type WorkspaceStateClient = Pick<OpenGeniClient, "getWorkspaceState">;

type WorkspaceStateLoad = {
  client: WorkspaceStateClient;
  workspaceId: string;
  attemptId: string | undefined;
  state: WorkspaceStateResponse | null;
  error: Error | null;
  loading: boolean;
};

export function useWorkspaceStateInventory(
  client: WorkspaceStateClient,
  workspaceId: string,
  attemptId?: string,
): Omit<WorkspaceStateLoad, "client" | "workspaceId" | "attemptId"> & {
  reload: () => Promise<void>;
} {
  const generation = useRef(0);
  const [result, setResult] = useState<WorkspaceStateLoad>(() => ({
    client,
    workspaceId,
    attemptId,
    state: null,
    error: null,
    loading: true,
  }));

  const reload = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setResult((previous) => ({
      client,
      workspaceId,
      attemptId,
      state:
        previous.client === client &&
        previous.workspaceId === workspaceId &&
        previous.attemptId === attemptId
          ? previous.state
          : null,
      error: null,
      loading: true,
    }));
    try {
      const state = await client.getWorkspaceState(workspaceId, { attemptId });
      if (generation.current !== requestGeneration) return;
      setResult({ client, workspaceId, attemptId, state, error: null, loading: false });
    } catch (loadError) {
      if (generation.current !== requestGeneration) return;
      setResult((previous) => ({
        client,
        workspaceId,
        attemptId,
        state:
          previous.client === client &&
          previous.workspaceId === workspaceId &&
          previous.attemptId === attemptId
            ? previous.state
            : null,
        error: loadError instanceof Error ? loadError : new Error(String(loadError)),
        loading: false,
      }));
    }
  }, [attemptId, client, workspaceId]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  if (
    result.client !== client ||
    result.workspaceId !== workspaceId ||
    result.attemptId !== attemptId
  ) {
    return { state: null, error: null, loading: true, reload };
  }
  return { state: result.state, error: result.error, loading: result.loading, reload };
}
