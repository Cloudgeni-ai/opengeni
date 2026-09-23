import { useEffect, useRef, useState } from "react";
import type { Session } from "@opengeni/sdk";

export type SessionVariableSetPickerSharedState = {
  saving: boolean;
  committedSelection: { sessionId: string; key: string } | null;
};

/** Own refresh reconciliation outside the transient picker/menu lifetime. */
export function useSessionVariableSetPickerState(
  session: Pick<Session, "id" | "variableSetIds" | "variableSetId">,
) {
  const [state, setState] = useState<SessionVariableSetPickerSharedState>({
    saving: false,
    committedSelection: null,
  });
  const sessionId = useRef(session.id);
  const currentKey = (
    session.variableSetIds ?? (session.variableSetId ? [session.variableSetId] : [])
  ).join("\u0000");
  useEffect(() => {
    if (sessionId.current !== session.id) {
      sessionId.current = session.id;
      setState({ saving: false, committedSelection: null });
      return;
    }
    setState((current) => {
      const committed = current.committedSelection;
      if (
        committed === null ||
        (committed.sessionId === session.id && committed.key !== currentKey)
      ) {
        return current;
      }
      return { ...current, committedSelection: null };
    });
  }, [currentKey, session.id, state.committedSelection]);
  return [state, setState] as const;
}
