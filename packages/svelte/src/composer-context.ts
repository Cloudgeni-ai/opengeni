import type { FileAttachmentStore, SessionComposerRuntimeStore } from "@opengeni/sdk/session";
import { getContext, setContext } from "svelte";

const COMPOSER_CONTEXT = Symbol("@opengeni/svelte/composer");

export type OpenGeniComposerContext = Readonly<{
  controller: SessionComposerRuntimeStore;
  attachments?: FileAttachmentStore | undefined;
}>;

export function setComposerContext(value: OpenGeniComposerContext): OpenGeniComposerContext {
  setContext(COMPOSER_CONTEXT, value);
  return value;
}

export function getComposerContext(): OpenGeniComposerContext {
  const value = getContext<OpenGeniComposerContext | undefined>(COMPOSER_CONTEXT);
  if (!value) throw new Error("OpenGeni composer primitives require a ComposerRoot ancestor");
  return value;
}
