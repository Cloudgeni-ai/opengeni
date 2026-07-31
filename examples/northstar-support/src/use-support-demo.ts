import { useCallback, useEffect, useState } from "react";
import type {
  DemoHealth,
  SupportDomainEvent,
  SupportWorkspaceState,
  TicketPriority,
  TicketStatus,
} from "./types";

type SupportDemoResult = {
  state: SupportWorkspaceState | null;
  health: DemoHealth | null;
  loading: boolean;
  error: Error | null;
  lastEvent: SupportDomainEvent | null;
  refresh: () => Promise<void>;
  reset: () => Promise<void>;
  updateTicket: (
    ticketId: string,
    changes: { priority?: TicketPriority; status?: TicketStatus },
  ) => Promise<void>;
  addNote: (ticketId: string, body: string) => Promise<void>;
  sendReply: (ticketId: string, body: string) => Promise<void>;
};

// Relative URLs work through Vite's local proxy and become same-origin in the
// production container. No deployment hostname is compiled into the browser.
const PRODUCT_API_ORIGIN = "";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PRODUCT_API_ORIGIN}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(
      String((body as { error?: unknown }).error ?? `Request failed (${response.status})`),
    );
  }
  return (await response.json()) as T;
}

export function useSupportDemo(): SupportDemoResult {
  const [state, setState] = useState<SupportWorkspaceState | null>(null);
  const [health, setHealth] = useState<DemoHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [lastEvent, setLastEvent] = useState<SupportDomainEvent | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextState, nextHealth] = await Promise.all([
        fetchJson<SupportWorkspaceState>("/api/demo/state"),
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
    const events = new EventSource(`${PRODUCT_API_ORIGIN}/api/demo/events`);
    const reconcile = window.setInterval(() => {
      void fetchJson<SupportWorkspaceState>("/api/demo/state")
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
    events.addEventListener("ticket.replied", onDomainEvent as EventListener);
    events.addEventListener("demo.reset", onDomainEvent as EventListener);
    events.onerror = () => setError(new Error("Product update stream disconnected."));
    return () => {
      window.clearInterval(reconcile);
      events.close();
    };
  }, [refresh]);

  const reset = useCallback(async () => {
    const next = await fetchJson<SupportWorkspaceState>("/api/demo/reset", {
      method: "POST",
    });
    setState(next);
    setLastEvent(null);
  }, []);

  const updateTicket = useCallback(
    async (ticketId: string, changes: { priority?: TicketPriority; status?: TicketStatus }) => {
      setState((current) =>
        current
          ? {
              ...current,
              cases: current.cases.map((supportCase) =>
                supportCase.ticket.id === ticketId
                  ? { ...supportCase, ticket: { ...supportCase.ticket, ...changes } }
                  : supportCase,
              ),
            }
          : current,
      );
      const request = fetchJson<SupportWorkspaceState>("/api/demo/ticket", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId, ...changes }),
      });
      void request
        .then((next) => setState(next))
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          void refresh();
        });
    },
    [refresh],
  );

  const addNote = useCallback(
    async (ticketId: string, body: string) => {
      const createdAt = new Date().toISOString();
      setState((current) =>
        current
          ? {
              ...current,
              cases: current.cases.map((supportCase) =>
                supportCase.ticket.id === ticketId
                  ? {
                      ...supportCase,
                      ticket: {
                        ...supportCase.ticket,
                        notes: [
                          {
                            id: `optimistic-note-${crypto.randomUUID()}`,
                            author: "Maya Chen",
                            authorKind: "human",
                            body,
                            createdAt,
                          },
                          ...supportCase.ticket.notes,
                        ],
                      },
                    }
                  : supportCase,
              ),
            }
          : current,
      );
      const request = fetchJson<SupportWorkspaceState>("/api/demo/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId, body }),
      });
      void request
        .then((next) => setState(next))
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          void refresh();
        });
    },
    [refresh],
  );

  const sendReply = useCallback(
    async (ticketId: string, body: string) => {
      const createdAt = new Date().toISOString();
      setState((current) =>
        current
          ? {
              ...current,
              cases: current.cases.map((supportCase) =>
                supportCase.ticket.id === ticketId
                  ? {
                      ...supportCase,
                      ticket: {
                        ...supportCase.ticket,
                        status: "waiting_on_customer",
                        unread: false,
                        replies: [
                          ...supportCase.ticket.replies,
                          {
                            id: `optimistic-reply-${crypto.randomUUID()}`,
                            author: "Maya Chen",
                            body,
                            createdAt,
                          },
                        ],
                      },
                    }
                  : supportCase,
              ),
            }
          : current,
      );
      const request = fetchJson<SupportWorkspaceState>("/api/demo/replies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId, body }),
      });
      void request
        .then((next) => setState(next))
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          void refresh();
        });
    },
    [refresh],
  );

  return {
    state,
    health,
    loading,
    error,
    lastEvent,
    refresh,
    reset,
    updateTicket,
    addNote,
    sendReply,
  };
}

export async function createDemoSession(ticketId: string, initialMessage: string) {
  return await fetchJson<{ id: string }>("/api/demo/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketId, initialMessage }),
  });
}
