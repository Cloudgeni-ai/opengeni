import type { OpenGeniClient, WorkspaceLearningHistoryResponse } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

type WorkspaceLearningClient = Pick<OpenGeniClient, "getWorkspaceLearningHistory">;

export function useWorkspaceLearningHistory(
  client: WorkspaceLearningClient,
  workspaceId: string,
): {
  response: WorkspaceLearningHistoryResponse | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const generation = useRef(0);
  const [response, setResponse] = useState<WorkspaceLearningHistoryResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await client.getWorkspaceLearningHistory(workspaceId, { limit: 50 });
      if (generation.current === requestGeneration) setResponse(next);
    } catch (loadError) {
      if (generation.current === requestGeneration) {
        setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
      }
    } finally {
      if (generation.current === requestGeneration) setLoading(false);
    }
  }, [client, workspaceId]);
  useEffect(() => {
    setResponse(null);
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);
  return { response, error, loading, reload };
}
