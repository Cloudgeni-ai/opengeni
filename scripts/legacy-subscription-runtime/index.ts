import { LEGACY_CODEX_RUNTIME } from "./codex";
import type { LegacySubscriptionRuntime } from "./types";
import { LEGACY_XAI_RUNTIME } from "./xai";

export type { LegacyRuntimeException, LegacySubscriptionRuntime } from "./types";
export { LEGACY_CODEX_RUNTIME } from "./codex";
export { LEGACY_XAI_RUNTIME } from "./xai";

/**
 * Every retired provider runtime, in retirement order. Add an entry when a
 * provider's legacy runtime is deleted (Claude: C4) or when shared legacy
 * routines are dropped (R); the engine stays unchanged.
 */
export const LEGACY_SUBSCRIPTION_RUNTIMES: readonly LegacySubscriptionRuntime[] = [
  LEGACY_CODEX_RUNTIME,
  LEGACY_XAI_RUNTIME,
];
