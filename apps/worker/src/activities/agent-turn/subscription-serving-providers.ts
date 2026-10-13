/** Worker hook registry. Database registry/readiness is an independent gate;
 * listing a hook here never admits a provider or enables a cutover.
 */
import { subscriptionCoreProviderIds } from "@opengeni/db";
import { CODEX_CORE_TURN_PROVIDER } from "./codex-core-capacity";
import { XAI_CORE_TURN_PROVIDER } from "./xai-core";
import { CLAUDE_CORE_TURN_PROVIDER } from "./claude-core";
import type { CoreTurnPlacementProvider } from "./subscription-core-capacity";

export function servingTurnProviders(): CoreTurnPlacementProvider[] {
  const registered = new Set(subscriptionCoreProviderIds());
  return [CODEX_CORE_TURN_PROVIDER, XAI_CORE_TURN_PROVIDER, CLAUDE_CORE_TURN_PROVIDER].filter(
    (provider) => registered.has(provider.id),
  );
}
