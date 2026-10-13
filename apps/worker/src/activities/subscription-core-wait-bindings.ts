import { subscriptionCoreProviderIds } from "@opengeni/db";
import { CODEX_CORE_WAIT_BINDING, type CoreWaitBinding } from "./subscription-core-codex-waits";
import { CLAUDE_CORE_WAIT_BINDING } from "./subscription-core-claude-waits";
import { XAI_CORE_WAIT_BINDING } from "./subscription-core-xai-waits";

/** Control-worker adapters only; never import the turn runtime to wake work. */
export function subscriptionCoreWaitBindings(): CoreWaitBinding[] {
  const registered = new Set(subscriptionCoreProviderIds());
  return [CODEX_CORE_WAIT_BINDING, CLAUDE_CORE_WAIT_BINDING, XAI_CORE_WAIT_BINDING].filter(
    (binding) => registered.has(binding.provider),
  );
}
