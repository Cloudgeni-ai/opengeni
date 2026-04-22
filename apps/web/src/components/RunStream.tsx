import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { runStreamUrl } from "../lib/api";
import {
  TERMINAL_STATUSES,
  type AgentRun,
  type RunEvent,
  type RunProgress,
  type StreamMessage,
} from "../lib/types";
import {
  runEventsQueryOptions,
  runQueryOptions,
} from "../lib/queries";

interface RunStreamProps {
  run: AgentRun;
  initialEvents: RunEvent[];
}

export function RunStream({ run, initialEvents }: RunStreamProps) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<RunEvent[]>(initialEvents);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useEffect(() => {
    if (TERMINAL_STATUSES.has(run.status)) {
      return;
    }
    const lastSequence = initialEvents.reduce(
      (max, event) => Math.max(max, event.sequence),
      0,
    );
    const url = runStreamUrl(run.id, lastSequence + 1);
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnected(true);
      setStreamError(null);
    });
    socket.addEventListener("close", () => {
      setConnected(false);
    });
    socket.addEventListener("error", () => {
      setStreamError("WebSocket error; stream closed.");
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
          setEvents((current) => {
            if (current.some((existing) => existing.id === message.event.id)) {
              return current;
            }
            const next = [...current, message.event].sort(
              (a, b) => a.sequence - b.sequence,
            );
            queryClient.setQueryData(
              runEventsQueryOptions(run.id).queryKey,
              next,
            );
            return next;
          });
          break;
        }
        case "progress": {
          setProgress(message.progress);
          break;
        }
        case "progress.error": {
          setStreamError(message.error);
          break;
        }
        case "error": {
          setStreamError(message.error);
          break;
        }
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [run.id, run.status, initialEvents, queryClient]);

  return (
    <div className="run-detail-grid">
      <section className="card">
        <div className="card-header">
          <h2>Event stream</h2>
          <span className="muted">
            {connected ? "live" : TERMINAL_STATUSES.has(run.status) ? "closed" : "connecting..."}
          </span>
        </div>
        {streamError ? <div className="notice">{streamError}</div> : null}
        {events.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <div className="event-stream">
            {events.map((event) => (
              <div className="event-item" key={event.id}>
                <div className="seq">#{event.sequence}</div>
                <div>
                  <strong>{event.type}</strong>
                  <div className="muted">
                    {new Date(event.created_at).toLocaleTimeString()}
                  </div>
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <aside className="card">
        <div className="card-header">
          <h2>Workflow progress</h2>
        </div>
        {progress ? (
          <dl className="progress-box">
            <dt>State</dt>
            <dd>{progress.state}</dd>
            <dt>Turn</dt>
            <dd>{progress.turn}</dd>
            <dt>Queue depth</dt>
            <dd>{progress.queue_depth}</dd>
            <dt>Waiting for follow-up</dt>
            <dd>{progress.waiting_for_follow_up ? "yes" : "no"}</dd>
            <dt>Cancellation requested</dt>
            <dd>{progress.cancellation_requested ? "yes" : "no"}</dd>
            {progress.last_output ? (
              <>
                <dt>Last output</dt>
                <dd>
                  <pre>{progress.last_output}</pre>
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="muted">
            {TERMINAL_STATUSES.has(run.status)
              ? "Run is terminal; no live progress."
              : "Awaiting workflow progress snapshot..."}
          </p>
        )}
      </aside>
    </div>
  );
}
