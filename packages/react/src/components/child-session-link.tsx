import { isSessionId } from "../timeline/agent-identity";
import type { MachineInputMember } from "../timeline/types";

/**
 * Source IDs are routing coordinates only for typed agent updates (child
 * lifecycle notices, agent messages, and agent directions), never parsed from
 * prose.
 */
export function ChildSessionLink({
  kind,
  sourceId,
  onOpenSession,
}: Pick<MachineInputMember, "kind" | "sourceId"> & {
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  if (
    !onOpenSession ||
    !(
      kind.startsWith("child_") ||
      kind === "agent_message" ||
      kind === "agent_steer_instruction"
    ) ||
    !isSessionId(sourceId)
  ) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => onOpenSession(sourceId)}
      className="mt-1 rounded-og-sm text-og-xs font-medium text-og-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent"
    >
      View session
    </button>
  );
}
