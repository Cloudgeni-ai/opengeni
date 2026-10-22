import { LEGACY_CLAUDE_RUNTIME } from "./claude";
import { LEGACY_CODEX_RUNTIME } from "./codex";
import { LEGACY_POOL_RUNTIME } from "./pool";
import type { LegacySubscriptionRetirement } from "./types";
import { LEGACY_XAI_RUNTIME } from "./xai";

export type { LegacyRuntimeException, LegacySubscriptionRetirement } from "./types";
export { LEGACY_CLAUDE_RUNTIME } from "./claude";
export { LEGACY_CODEX_RUNTIME } from "./codex";
export { LEGACY_POOL_RUNTIME } from "./pool";
export { LEGACY_XAI_RUNTIME } from "./xai";

/**
 * Every retired provider runtime, in retirement order. Add an entry when a
 * provider's legacy runtime is deleted (Claude: C4) or when shared legacy
 * routines are dropped (R); the engine stays unchanged.
 */
export const LEGACY_SUBSCRIPTION_RETIREMENTS: readonly LegacySubscriptionRetirement[] = [
  LEGACY_CODEX_RUNTIME,
  LEGACY_XAI_RUNTIME,
  LEGACY_CLAUDE_RUNTIME,
  LEGACY_POOL_RUNTIME,
];
