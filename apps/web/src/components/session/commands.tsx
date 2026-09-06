import { useSessionBackgroundCommands } from "@opengeni/react";
import { SessionCommandsPanel } from "@opengeni/react/session-ui";

/** Mounted only while the Commands segment is open; never loads command history. */
export function SessionCommands({ sessionId, readOnly }: { sessionId: string; readOnly: boolean }) {
  const commands = useSessionBackgroundCommands(sessionId, { pollIntervalMs: 3_000 });
  return <SessionCommandsPanel commands={commands} readOnly={readOnly} />;
}
