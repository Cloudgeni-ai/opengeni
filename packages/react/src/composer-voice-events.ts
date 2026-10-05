/**
 * Internal DOM signal between the composer's two voice controls: dictation
 * starting supersedes a stale live-voice start failure in the same composer.
 * Not part of the public package surface.
 */
export const COMPOSER_VOICE_INPUT_START_EVENT = "opengeni:composer-voice-input-start";

/** Closest composer root shared by both voice controls (falls back to the document). */
export function composerVoiceEventScope(element: Element | null): EventTarget | null {
  if (!element) return null;
  return element.closest(".og-composer") ?? element.ownerDocument;
}
