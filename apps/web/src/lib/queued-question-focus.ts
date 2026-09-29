import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionTurn } from "@opengeni/sdk";
import type { UseTurnQueueResult } from "@opengeni/react";

/** A read-only focus request; queue rows still come only from the controller. */
export function useQueuedQuestionFocus({
  client,
  subjectId,
  workspaceId,
  sessionId,
  queue,
}: {
  client: object;
  subjectId: string;
  workspaceId: string;
  sessionId: string;
  queue: Pick<UseTurnQueueResult, "refresh" | "queue" | "error">;
}) {
  const scope = useMemo(
    () => ({ client, subjectId, workspaceId, sessionId }),
    [client, subjectId, workspaceId, sessionId],
  );
  const refresh = queue.refresh;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(false);
  const sequence = useRef(0);
  const pending = useRef<{
    scope: object;
    requestId: number;
    turnId: string;
    isCurrent: () => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const [settledRead, setSettledRead] = useState(0);
  const [target, setTarget] = useState<{
    scope: object;
    turnId: string;
    requestId: number;
  } | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
      pending.current?.resolve();
      pending.current = null;
    };
  }, [scope]);

  useLayoutEffect(() => {
    const request = pending.current;
    if (!request || request.requestId !== settledRead) return;
    pending.current = null;
    if (request.scope !== scope || request.requestId !== sequence.current || !request.isCurrent()) {
      request.resolve();
    } else if (queue.error) {
      request.reject(queue.error);
    } else if (!queue.queue.some((turn) => turn.id === request.turnId)) {
      // The hook re-reads durable lifecycle after this callback. A claimed or
      // withdrawn prompt must resolve there, without focusing a vanished row.
      request.resolve();
    } else {
      setTarget({ scope, turnId: request.turnId, requestId: request.requestId });
      request.resolve();
    }
  }, [scope, settledRead, queue.error, queue.queue]);

  const onQueuedQuestion = useCallback(
    async (turn: SessionTurn, navigation: { isCurrent: () => boolean }) => {
      const { isCurrent } = navigation;
      if (!mounted.current || currentScope.current !== scope || !isCurrent()) return;
      const requestId = ++sequence.current;
      pending.current?.resolve();
      pending.current = null;
      setTarget(null);
      await refresh();
      if (
        !mounted.current ||
        currentScope.current !== scope ||
        sequence.current !== requestId ||
        !isCurrent()
      )
        return;
      // refresh() deliberately swallows read failures. Settle against the next
      // committed controller render, rather than its pre-await closure or merely
      // treating Promise fulfillment as proof that the row loaded successfully.
      await new Promise<void>((resolve, reject) => {
        pending.current = { scope, requestId, turnId: turn.id, isCurrent, resolve, reject };
        setSettledRead(requestId);
      });
    },
    [refresh, scope],
  );

  return {
    onQueuedQuestion,
    queueFocusTarget:
      target?.scope === scope ? { turnId: target.turnId, requestId: target.requestId } : undefined,
  };
}
