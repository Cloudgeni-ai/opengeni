import {
  useSessionBackgroundCommands,
  type UseSessionBackgroundCommandsOptions,
} from "../hooks/use-session-background-commands";
import { SessionCommandsPanel } from "./session-commands-panel";

/** Mount in the open activity panel so closed chrome never polls commands. */
export function SessionCommands({
  sessionId,
  readOnly = false,
  ...options
}: UseSessionBackgroundCommandsOptions & { sessionId: string; readOnly?: boolean }) {
  const commands = useSessionBackgroundCommands(sessionId, {
    pollIntervalMs: 3_000,
    ...options,
  });
  return <SessionCommandsPanel commands={commands} readOnly={readOnly} />;
}
