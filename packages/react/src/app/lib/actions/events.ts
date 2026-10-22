/** Page events that reach the action system from outside React's tree. */

/** Opens the ⌘K menu (older desktop menu commands, buttons). Sent on the window target. */
export const OPEN_COMMAND_MENU_EVENT = "opengeni:open-command-menu";
/** Asks the chat header to start renaming the chat on screen. Sent on the document target. */
export const RENAME_CURRENT_CHAT_EVENT = "opengeni:rename-current-chat";
/** Asks the chat on screen to fork from its latest message. Sent on the document target. */
export const FORK_CURRENT_CHAT_EVENT = "opengeni:fork-current-chat";

export function requestCommandMenu(target: EventTarget): void {
  target.dispatchEvent(new Event(OPEN_COMMAND_MENU_EVENT));
}
