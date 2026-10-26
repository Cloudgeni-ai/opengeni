import type { AgentAvatar } from "@opengeni/sdk";

/**
 * A prefilled agent draft handed from one page to the next (an agent's
 * suggestion card to "Save as agent"). Drafted instructions can be long, so
 * they travel in session storage under a one-time key instead of the URL.
 */
export type AgentProfileDraftHandoff = {
  name?: string | undefined;
  role?: string | undefined;
  avatar?: AgentAvatar | undefined;
  instructions?: string | undefined;
};

const PREFIX = "opengeni.agentProfileDraft:";

export function writeAgentProfileDraftHandoff(draft: AgentProfileDraftHandoff): string {
  const key = crypto.randomUUID();
  try {
    sessionStorage.setItem(`${PREFIX}${key}`, JSON.stringify(draft));
  } catch {
    // Storage can be unavailable (private mode); the form then opens empty.
  }
  return key;
}

export function readAgentProfileDraftHandoff(key: string): AgentProfileDraftHandoff | null {
  try {
    const raw = sessionStorage.getItem(`${PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentProfileDraftHandoff;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
