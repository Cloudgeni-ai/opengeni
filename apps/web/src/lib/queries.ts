import { queryOptions } from "@tanstack/react-query";
import { fetchRun, fetchRunEvents } from "./api";

export function runQueryOptions(runId: string) {
  return queryOptions({
    queryKey: ["runs", runId] as const,
    queryFn: () => fetchRun(runId),
    staleTime: 1_000,
  });
}

export function runEventsQueryOptions(runId: string) {
  return queryOptions({
    queryKey: ["runs", runId, "events"] as const,
    queryFn: () => fetchRunEvents(runId),
    staleTime: 1_000,
  });
}
