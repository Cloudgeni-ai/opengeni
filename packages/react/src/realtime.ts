/**
 * Batteries-included realtime voice controls and hooks.
 *
 * Import this subpath lazily when the composer action slot is rendered. The
 * base `@opengeni/react` entry remains SSR/browser safe and does not eagerly
 * load microphone, WebRTC, Gateway, or realtime UI code.
 */
export {
  CodexRealtimeControl,
  NewSessionRealtimeControl,
  RealtimeModelPickerMenu,
  RealtimeVoiceControl,
  SessionCodexRealtimeControl,
  SessionRealtimeControl,
  codexRealtimeAdmissionAllowed,
  codexRealtimeAdmissionBlocker,
  useRealtimeModelSelection,
  useSessionCodexRealtime,
  useSessionRealtime,
  useWorkspaceRealtimeModelSelection,
} from "./realtime/realtime-control";
export type {
  RealtimeModelOption,
  SessionRealtimeControllerFactory,
} from "./realtime/realtime-control";
export type { EmbeddedRealtimeSessionClientLike } from "./client";
export type { EmbeddedRealtimeSessionClientOverride } from "./session-context";
