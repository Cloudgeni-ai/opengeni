/**
 * Platform-neutral session realtime for any React host (web or React Native):
 * the controller hook, admission rules and the workspace voice-model catalog.
 * Native hosts inject their WebRTC through `controllerFactory`.
 */
export {
  CODEX_LIVE_MODEL,
  codexRealtimeAdmissionAllowed,
  codexRealtimeAdmissionBlocker,
  sessionRealtimeLifecycleIsActive,
  useRealtimeModelSelection,
  useSessionRealtime,
} from "./realtime/session-realtime";
export type {
  RealtimeControllerClient,
  RealtimeModelOption,
  SessionRealtimeControllerFactory,
} from "./realtime/session-realtime";
