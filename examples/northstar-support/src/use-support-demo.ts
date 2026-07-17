import { useCallback, useEffect, useState } from "react";
import type { DemoHealth, SupportDemoState, SupportDomainEvent } from "./types";

type SupportDemoResult = {
  state: SupportDemoState | null;
  health: DemoHealth | null;
  loading: boolean;
  error: Error | null;
  lastEvent: SupportDomainEvent | null;
  refresh: () => Promise<void>;
  reset: () => Promise<void>;
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(
      String((body as { error?: unknown }).error ?? `Request failed (${response.status})`),
    );
  }
  return (await response.json()) as T;
}

export function useSupportDemo(): SupportDemoResult {
  const [state, setState] = useState<SupportDemoState | null>(null);
  const [health, setHealth] = useState<DemoHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [lastEvent, setLastEvent] = useState<SupportDomainEvent | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextState, nextHealth] = await Promise.all([
        fetchJson<SupportDemoState>("/api/demo/state"),
        fetchJson<DemoHealth>("/api/demo/health"),
      ]);
      setState(nextState);
      setHealth(nextHealth);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/demo/events");
    const reconcile = window.setInterval(() => {
      void fetchJson<SupportDemoState>("/api/demo/state")
        .then((nextState) => {
          setState(nextState);
          setError(null);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        });
    }, 3_000);
    const onDomainEvent = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as SupportDomainEvent;
        setLastEvent(parsed);
        void refresh();
      } catch {
        // Keep the last valid state if a non-domain SSE frame arrives.
      }
    };
    events.addEventListener("ticket.updated", onDomainEvent as EventListener);
    events.addEventListener("ticket.note_added", onDomainEvent as EventListener);
    events.addEventListener("demo.reset", onDomainEvent as EventListener);
    events.onerror = () => setError(new Error("Product update stream disconnected."));
    return () => {
      window.clearInterval(reconcile);
      events.close();
    };
  }, [refresh]);

  const reset = useCallback(async () => {
    const next = await fetchJson<SupportDemoState>("/api/demo/reset", {
      method: "POST",
    });
    setState(next);
    setLastEvent(null);
  }, []);

  return { state, health, loading, error, lastEvent, refresh, reset };
}

export async function createDemoSession(initialMessage: string) {
  return await fetchJson<{ id: string }>("/api/demo/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initialMessage }),
  });
}
