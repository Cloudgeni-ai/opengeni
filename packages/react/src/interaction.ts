// @opengeni/react/interaction — standalone Browser/Computer resource UI.
// Framework hosts may pass a narrow structural client instead of the full provider.
export type {
  EmbeddedBrowserInteractionClientLike,
  EmbeddedComputerInteractionClientLike,
  EmbeddedInteractionClientLike,
} from "./client";
export {
  useEmbeddedBrowserInteraction,
  useEmbeddedComputerInteraction,
  useEmbeddedInteraction,
} from "./session-context";
export type {
  EmbeddedBrowserInteractionClientOverride,
  EmbeddedComputerInteractionClientOverride,
  EmbeddedInteractionClientOverride,
} from "./session-context";
export { useAttachedBrowsers } from "./hooks/use-attached-browsers";
export type {
  AttachedBrowsersClient,
  UseAttachedBrowsersOptions,
  UseAttachedBrowsersResult,
} from "./hooks/use-attached-browsers";
export { useBrowserSessions } from "./hooks/use-browser-sessions";
export type {
  BrowserSessionsClient,
  UseBrowserSessionsOptions,
  UseBrowserSessionsResult,
} from "./hooks/use-browser-sessions";
export { useBrowserIdentities } from "./hooks/use-browser-identities";
export type {
  BrowserIdentitiesClient,
  UseBrowserIdentitiesOptions,
  UseBrowserIdentitiesResult,
} from "./hooks/use-browser-identities";
export { useBrowserSession } from "./hooks/use-browser-session";
export type {
  UseBrowserSessionOptions,
  UseBrowserSessionResult,
} from "./hooks/use-browser-session";
export { useBrowserFrameStream } from "./hooks/use-browser-frame-stream";
export type {
  BrowserFrameConnectionState,
  BrowserFrameWebSocket,
  BrowserFrameWebSocketFactory,
  UseBrowserFrameStreamOptions,
  UseBrowserFrameStreamResult,
} from "./hooks/use-browser-frame-stream";
export { BrowserViewer } from "./components/browser-viewer";
export type { BrowserViewerNotification, BrowserViewerProps } from "./components/browser-viewer";
export { useComputerSessions } from "./hooks/use-computer-sessions";
export type {
  ComputerSessionsClient,
  UseComputerSessionsOptions,
  UseComputerSessionsResult,
} from "./hooks/use-computer-sessions";
export { useComputerSession } from "./hooks/use-computer-session";
export type {
  UseComputerSessionOptions,
  UseComputerSessionResult,
} from "./hooks/use-computer-session";
export { useComputerFrameStream } from "./hooks/use-computer-frame-stream";
export type {
  ComputerFrameConnectionState,
  ComputerFrameWebSocket,
  ComputerFrameWebSocketFactory,
  UseComputerFrameStreamOptions,
  UseComputerFrameStreamResult,
} from "./hooks/use-computer-frame-stream";
export { ComputerViewer } from "./components/computer-viewer";
export type { ComputerViewerNotification, ComputerViewerProps } from "./components/computer-viewer";
