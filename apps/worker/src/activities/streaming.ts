import type { SessionEventType } from "@infra-agents/contracts";
import type { AppendEventInput } from "@infra-agents/db";
import { Context } from "@temporalio/activity";

export function createRuntimeBatcher(flushEvents: (events: AppendEventInput[]) => Promise<void>) {
  let pending: AppendEventInput[] = [];
  let lastFlush = Date.now();
  const structural = new Set<SessionEventType>([
    "agent.message.delta",
    "agent.reasoning.delta",
    "sandbox.command.output.delta",
    "agent.toolCall.created",
    "agent.toolCall.output",
    "agent.message.completed",
    "session.requiresAction",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
  ]);
  return {
    push: async (event: { type: SessionEventType; payload: unknown }) => {
      pending.push({ type: event.type, payload: event.payload });
      const elapsed = Date.now() - lastFlush;
      if (pending.length >= 50 || elapsed >= 33 || structural.has(event.type)) {
        await flush();
      }
    },
    flush,
  };

  async function flush() {
    if (pending.length === 0) {
      return;
    }
    const events = pending;
    pending = [];
    lastFlush = Date.now();
    await flushEvents(events);
  }
}

export function currentActivityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

export function startActivityHeartbeat(context: Context | null, details: Record<string, unknown>): ReturnType<typeof setInterval> | null {
  if (!context) {
    return null;
  }
  const timer = setInterval(() => {
    context.heartbeat({ ...details, at: new Date().toISOString() });
  }, 10_000);
  if ("unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

export async function nextStreamEvent<T>(iterator: AsyncIterator<T>, context: Context | null): Promise<IteratorResult<T>> {
  if (!context) {
    return await iterator.next();
  }
  return await Promise.race([
    iterator.next(),
    context.cancelled,
  ]);
}
