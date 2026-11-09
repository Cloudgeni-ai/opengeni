/* "Not now" on an agent suggestion card, and a suggestion whose agent was made,
   hide that card in this browser. Kept apart from the card's other code so the
   agent form can hide it without loading the chat's code. */

const DISMISSED_PREFIX = "opengeni.agentSuggestion.dismissed:";

export function agentSuggestionDismissed(sessionId: string, suggestionId: string): boolean {
  try {
    return localStorage.getItem(`${DISMISSED_PREFIX}${sessionId}`) === suggestionId;
  } catch {
    return false;
  }
}

export function dismissAgentSuggestion(sessionId: string, suggestionId: string): void {
  try {
    localStorage.setItem(`${DISMISSED_PREFIX}${sessionId}`, suggestionId);
  } catch {
    // Without storage the card returns after a reload; nothing else depends on it.
  }
}
