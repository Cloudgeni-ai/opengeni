import type { Session, SessionAgentProfile } from "@opengeni/sdk";
import {
  agentProfilesClientFor,
  useAgentProfiles,
  type UseAgentProfilesResult,
} from "../../hooks/use-agent-profiles";

export { agentProfilesClientFor };
import { useAppContext } from "../app-context";

/** Whether the deployment has agent profiles on (`OPENGENI_AGENT_PROFILES_ENABLED`). */
export function useAgentProfilesEnabled(): boolean {
  // Optional chaining: embedded hosts and test contexts may omit the client config.
  return useAppContext().clientConfig?.agentProfiles?.enabled === true;
}

/** The identity a chat's agent wears, shown only while the feature is on. */
export function visibleAgentProfile(
  session: Pick<Session, "agentProfile"> | null | undefined,
  enabled: boolean,
): SessionAgentProfile | null {
  return enabled ? (session?.agentProfile ?? null) : null;
}

/** The workspace's saved agents, read once and shared, when the feature is on. */
export function useAppAgentProfiles(): UseAgentProfilesResult & { enabled: boolean } {
  const enabled = useAgentProfilesEnabled();
  const result = useAgentProfiles({ enabled });
  return { ...result, enabled: enabled && result.available };
}
