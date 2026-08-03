/** Ask the sessions-index create composer to take focus (same-route new session). */
export const FOCUS_CREATE_COMPOSER_EVENT = "opengeni:focus-create-composer";

export function requestCreateComposerFocus(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(FOCUS_CREATE_COMPOSER_EVENT));
}
