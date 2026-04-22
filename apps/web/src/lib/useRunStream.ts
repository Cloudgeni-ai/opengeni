import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { runStreamUrl } from "./api";
import { runEventsQueryOptions, runQueryOptions } from "./queries";
import {
  TERMINAL_STATUSES,
  type AgentRun,
  type RunEvent,
  type RunProgress,
  type StreamMessage,
} from "./types";

export type StreamConnectionState = "connecting" | "live" | "closed" | "error";

export interface RunStreamState {
  progress: RunProgress | null;
  connectionState: StreamConnectionState;
  error: string | null;
}

export function useRunStream(run: AgentRun): RunStreamState {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [connectionState, setConnectionState] = useState<StreamConnectionState>(
    TERMINAL_STATUSES.has(run.status) ? "closed" : "connecting",
  );
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (TERMINAL_STATUSES.has(run.status)) {
      setConnectionState("closed");
      return;
    }

    const eventsKey = runEventsQueryOptions(run.id).queryKey;
    const cachedEvents = queryClient.getQueryData<RunEvent[]>(eventsKey) ?? [];
    const startingSequence = cachedEvents.reduce(
      (max, event) => Math.max(max, event.sequence),
      0,
    );
    const url = runStreamUrl(run.id, startingSequence + 1);

    const socket = new WebSocket(url);
    socketRef.current = socket;
    setConnectionState("connecting");

    socket.addEventListener("open", () => {
      setConnectionState("live");
      setError(null);
    });
    socket.addEventListener("close", () => {
      setConnectionState((current) => (current === "error" ? current : "closed"));
    });
    socket.addEventListener("error", () => {
      setConnectionState("error");
      setError("Stream connection error.");
    });
    socket.addEventListener("message", (event) => {
      let message: StreamMessage;
      try {
        message = JSON.parse(event.data as string) as StreamMessage;
      } catch {
        return;
      }

      switch (message.type) {
        case "run": {
          queryClient.setQueryData(runQueryOptions(run.id).queryKey, message.run);
          break;
        }
        case "event": {
          queryClient.setQueryData<RunEvent[] | undefined>(eventsKey, (current) => {
            const base = current ?? [];
            if (base.some((existing) => existing.id === message.event.id)) {
              return base;
            }
            return [...base, message.event].sort((a, b) => a.sequence - b.sequence);
          });
          break;
        }
        case "progress": {
          setProgress(message.progress);
          break;
        }
        case "progress.error": {
          setError(message.error);
          break;
        }
        case "error": {
          setError(message.error);
          break;
        }
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [run.id, run.status, queryClient]);

  return { progress, connectionState, error };
}
