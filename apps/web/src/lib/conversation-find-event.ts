/**
 * The session header opens Find in conversation without owning its state: the
 * session route listens for this event and opens its find bar.
 */
export const OPEN_CONVERSATION_FIND_EVENT = "opengeni:open-conversation-find";

export function requestConversationFind(): void {
  document.dispatchEvent(new Event(OPEN_CONVERSATION_FIND_EVENT));
}
