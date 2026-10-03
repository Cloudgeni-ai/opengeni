/**
 * How Insights names models and providers. Models use the app-wide clean name
 * and maker logo (`components/model-identity`): "codex/gpt-6.1-sol" reads
 * "GPT-6.1 Sol" with the OpenAI mark. Providers read as the Models page names
 * the connection, with no workspace/organization difference.
 */
import { modelDisplayName as sharedModelDisplayName } from "@opengeni/sdk/model-display";

import type { ModelProviderId } from "@/components/models/provider-mark";

/** A connection's raw provider id as model_call_facts records it. */
export type RawProvider = string;

/** What served the call, in the words of the Models page. Workspace vs organization never shows. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "codex-subscription": "ChatGPT plan",
  codex: "ChatGPT plan",
  "workspace-claude-subscription": "Claude plan",
  "organization-claude-subscription": "Claude plan",
  "claude-subscription": "Claude plan",
  "supergrok-subscription": "SuperGrok plan",
  "opengeni-gateway": "Opengeni credits",
  opengeni: "Opengeni credits",
  "workspace-gateway": "Vercel AI Gateway",
  "organization-gateway": "Vercel AI Gateway",
  "vercel-gateway": "Vercel AI Gateway",
  "workspace-openrouter": "OpenRouter",
  "organization-openrouter": "OpenRouter",
  openrouter: "OpenRouter",
  openai: "OpenAI API",
  "azure-openai": "Azure OpenAI",
  anthropic: "Anthropic API",
  "workspace-anthropic": "Anthropic API",
  "organization-anthropic": "Anthropic API",
  xai: "xAI API",
  google: "Google",
};

const PROVIDER_MARKS: Readonly<Record<string, ModelProviderId | "opengeni">> = {
  "codex-subscription": "codex",
  codex: "codex",
  "workspace-claude-subscription": "claude_subscription",
  "organization-claude-subscription": "claude_subscription",
  "claude-subscription": "claude_subscription",
  "supergrok-subscription": "supergrok",
  xai: "supergrok",
  "opengeni-gateway": "opengeni",
  opengeni: "opengeni",
  "workspace-gateway": "vercel",
  "organization-gateway": "vercel",
  "vercel-gateway": "vercel",
  "workspace-openrouter": "openrouter",
  "organization-openrouter": "openrouter",
  openrouter: "openrouter",
  openai: "openai",
  "azure-openai": "azure_openai",
  anthropic: "anthropic",
  "workspace-anthropic": "anthropic",
  "organization-anthropic": "anthropic",
};

export type MarkId = ModelProviderId | "opengeni" | null;

function titleWord(word: string): string {
  if (/^\d/.test(word)) return word;
  if (/^[a-z]\d/i.test(word)) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function providerDisplayName(provider: RawProvider): string {
  const known = PROVIDER_NAMES[provider];
  if (known) return known;
  return provider
    .replace(/^(workspace|organization)-/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map(titleWord)
    .join(" ");
}

export function providerMark(provider: RawProvider): MarkId {
  return PROVIDER_MARKS[provider] ?? null;
}

/**
 * The model's display name: the app-wide clean name (`@opengeni/sdk/model-display`
 * via `components/model-identity`), preferring a curated catalog label.
 */
export function modelDisplayName(
  _provider: RawProvider,
  model: string,
  catalog?: ModelLabelSource,
): string {
  return sharedModelDisplayName({ id: model, label: catalog?.get(model) ?? null });
}

export type ModelLabelSource = ReadonlyMap<string, string>;

/** Catalog labels keyed by full id and bare slug. */
export function catalogLabels(
  models: ReadonlyArray<{ id: string; label: string }>,
): ModelLabelSource {
  const map = new Map<string, string>();
  for (const model of models) {
    if (!model.label || model.label === model.id) continue;
    map.set(model.id, model.label);
    const slash = model.id.lastIndexOf("/");
    if (slash >= 0 && !map.has(model.id.slice(slash + 1))) {
      map.set(model.id.slice(slash + 1), model.label);
    }
  }
  return map;
}
