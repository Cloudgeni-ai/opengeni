// The replay-status list lives with the shared replay normalization, so the
// Codex normalizer and the Responses WebSocket continuation check cannot
// disagree about what replay strips.
export {
  REPLAY_STATUS_ITEM_TYPES,
  preservesReplayStatus,
  type ReplayStatusItemType,
} from "@opengeni/network/responses-replay";
