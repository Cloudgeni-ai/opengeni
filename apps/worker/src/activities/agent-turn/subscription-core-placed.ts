/**
 * The turn's shared-core placement with the provider that placed it (at most
 * one provider places a turn). Provider-neutral callers (checkpoints, the
 * between-calls revalidation) use this instead of a provider's field.
 */
import type { Database } from "@opengeni/db";
import { CODEX_CORE_TURN_PROVIDER } from "./codex-core-capacity";
import {
  assertCoreSourceConnected,
  type CoreTurnPlacementProvider,
} from "./subscription-core-capacity";
import type { SubscriptionCorePlacedFields, SubscriptionCoreTurn } from "./turn-context";
import { XAI_CORE_TURN_PROVIDER } from "./xai-core";
import { CLAUDE_CORE_TURN_PROVIDER } from "./claude-core";

export function placedSubscriptionCore(
  providerTurn: SubscriptionCorePlacedFields,
): { core: SubscriptionCoreTurn; provider: CoreTurnPlacementProvider } | null {
  if (providerTurn.codexSubscriptionCore)
    return { core: providerTurn.codexSubscriptionCore, provider: CODEX_CORE_TURN_PROVIDER };
  if (providerTurn.xaiSubscriptionCore)
    return { core: providerTurn.xaiSubscriptionCore, provider: XAI_CORE_TURN_PROVIDER };
  if (providerTurn.claudeSubscriptionCore)
    return { core: providerTurn.claudeSubscriptionCore, provider: CLAUDE_CORE_TURN_PROVIDER };
  return null;
}

/** Between model calls: settle committed responses, then recheck the source. */
export async function revalidatePlacedSubscriptionCore(
  db: Database,
  providerTurn: SubscriptionCorePlacedFields,
): Promise<void> {
  const placed = placedSubscriptionCore(providerTurn);
  if (!placed) return;
  await placed.core.requests?.checkpoint();
  await assertCoreSourceConnected(db, placed.provider, placed.core);
}
