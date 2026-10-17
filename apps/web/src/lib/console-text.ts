import { createOpenGeniText } from "@opengeni/react/messages";

/**
 * The console's own copy is English, so the @opengeni/react helpers it calls use the
 * default English catalog. Hosts that localize pass `messages` and `locale` to
 * `OpenGeniProvider` and read the translator with `useOpenGeniText()` instead.
 */
export const t = createOpenGeniText();
