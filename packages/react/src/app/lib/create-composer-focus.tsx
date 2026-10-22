/** Ask the sessions-index create composer to take focus (same-route new session). */
export const FOCUS_CREATE_COMPOSER_EVENT = "opengeni:focus-create-composer";

export type CreateComposerFocusIntent = {
  /** Undefined restores Recents; null explicitly selects the Default folder. */
  channelId?: string | null | undefined;
};

export function requestCreateComposerFocus(target: EventTarget, channelId?: string | null): void {
  target.dispatchEvent(
    new CustomEvent<CreateComposerFocusIntent>(FOCUS_CREATE_COMPOSER_EVENT, {
      detail: { channelId },
    }),
  );
}
