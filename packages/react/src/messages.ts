// Host-localizable UI copy. DOM-free so React Native and other renderers can
// share the same catalog, runtime and overrides as the web components.
export {
  createOpenGeniText,
  OpenGeniMessagesProvider,
  useOpenGeniLocale,
  useOpenGeniText,
} from "./messages/runtime";
export type {
  MessageParamValue,
  OpenGeniMessageCatalog,
  OpenGeniMessageKey,
  OpenGeniMessageParams,
  OpenGeniMessages,
  OpenGeniMessagesProviderProps,
  OpenGeniText,
  PluralCategory,
} from "./messages/runtime";
export { englishMessages } from "./messages/en";
export { SINGLE_SEND_WORDING, singleSendText } from "./messages/single-send";
export { SingleSendWording } from "./messages/runtime";
