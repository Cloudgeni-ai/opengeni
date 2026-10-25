import type { CreateFeedbackRequest } from "@opengeni/sdk";

// A report is written to the device before it is sent, so pressing Send never
// loses it: without a connection it waits and goes out on the next launch,
// return to the app or retry. Reports belong to the account that wrote them and
// are only sent with that account's credentials, to the workspace they were
// written in. Order is kept; a report the server refuses for good (invalid,
// forbidden) is dropped so it cannot block the rest.

export interface QueuedFeedback {
  workspaceId: string;
  request: CreateFeedbackRequest;
  queuedAt: string;
}

export interface FeedbackOutboxStorage {
  list(accountId: string): Promise<readonly string[]>;
  read(accountId: string, id: string): Promise<string | null>;
  write(accountId: string, id: string, value: string): Promise<void>;
  remove(accountId: string, id: string): Promise<void>;
}

export type FeedbackSendFailure = "retry" | "rejected";

export interface FeedbackOutboxDependencies {
  storage: FeedbackOutboxStorage;
  /** Sends with the account's own client; throws when it is not signed in right now. */
  send(accountId: string, report: QueuedFeedback): Promise<void>;
  /** Whether a failed send can succeed later (network, server) or never will. */
  classify(error: unknown): FeedbackSendFailure;
  now?: () => Date;
}

export type FeedbackFlushResult = Readonly<{ sent: number; pending: number }>;

function parse(value: string | null): QueuedFeedback | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as Partial<QueuedFeedback>;
    if (typeof entry.workspaceId !== "string" || typeof entry.queuedAt !== "string") return null;
    if (typeof entry.request?.idempotencyKey !== "string") return null;
    return entry as QueuedFeedback;
  } catch {
    return null;
  }
}

export function createFeedbackOutbox(dependencies: FeedbackOutboxDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const flights = new Map<string, Promise<FeedbackFlushResult>>();
  const pendingCounts = new Map<string, number>();
  const listeners = new Set<() => void>();

  const setPending = (accountId: string, count: number) => {
    if (pendingCounts.get(accountId) === count) return;
    pendingCounts.set(accountId, count);
    for (const listener of listeners) listener();
  };

  async function drain(accountId: string): Promise<FeedbackFlushResult> {
    const queued: QueuedFeedback[] = [];
    for (const id of await dependencies.storage.list(accountId)) {
      const entry = parse(await dependencies.storage.read(accountId, id));
      // Unreadable leftovers (a partial write, an older format) can never be sent.
      if (!entry || entry.request.idempotencyKey !== id)
        await dependencies.storage.remove(accountId, id);
      else queued.push(entry);
    }
    queued.sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));
    setPending(accountId, queued.length);
    let sent = 0;
    for (const [index, entry] of queued.entries()) {
      try {
        await dependencies.send(accountId, entry);
        sent++;
      } catch (error) {
        if (dependencies.classify(error) === "retry") {
          const pending = queued.length - index;
          setPending(accountId, pending);
          return { sent, pending };
        }
      }
      await dependencies.storage.remove(accountId, entry.request.idempotencyKey);
      setPending(accountId, queued.length - index - 1);
    }
    return { sent, pending: 0 };
  }

  /** One drain per account at a time; a request during a drain joins the next pass. */
  function flush(accountId: string): Promise<FeedbackFlushResult> {
    const previous = flights.get(accountId) ?? Promise.resolve({ sent: 0, pending: 0 });
    const next = previous
      .catch(() => ({ sent: 0, pending: 0 }))
      .then(() => drain(accountId))
      .finally(() => {
        if (flights.get(accountId) === next) flights.delete(accountId);
      });
    flights.set(accountId, next);
    return next;
  }

  return {
    /** Saves the report on the device, then tries to send everything waiting. */
    async submit(
      accountId: string,
      workspaceId: string,
      request: CreateFeedbackRequest,
    ): Promise<FeedbackFlushResult> {
      const entry: QueuedFeedback = { workspaceId, request, queuedAt: now().toISOString() };
      await dependencies.storage.write(accountId, request.idempotencyKey, JSON.stringify(entry));
      setPending(accountId, (pendingCounts.get(accountId) ?? 0) + 1);
      return flush(accountId);
    },
    flush,
    pending(accountId: string | null): number {
      return accountId ? (pendingCounts.get(accountId) ?? 0) : 0;
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
