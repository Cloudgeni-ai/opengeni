import type { OpenGeniClient } from "@opengeni/sdk";

/**
 * The slice of `OpenGeniClient` the hooks depend on. Structural, so apps can
 * pass the real SDK client, a proxy-backed client that routes through their
 * own API, or a scripted client in tests/demos.
 */
export type SessionClientLike = Pick<
  OpenGeniClient,
  | "getSession"
  | "listSessions"
  | "listScheduledTasks"
  | "sendMessage"
  | "interrupt"
  | "streamEvents"
>;
