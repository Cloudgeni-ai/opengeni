/**
 * How Insights names models and providers: product names and provider marks,
 * never raw ids ("codex/gpt-6.1-sol" reads "GPT 6.1 Sol" with the ChatGPT mark).
 *
 * Swap point: when the app-wide model display helper lands, route
 * `modelDisplayName` and `modelMark` through it and keep these signatures.
 * The catalog labels (when loaded) win over the heuristics.
 */
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

/** The model's own slug: without the connection prefix and without a gateway vendor. */
export function modelSlug(provider: RawProvider, model: string): string {
  let slug = model;
  if (slug.startsWith(`${provider}/`)) slug = slug.slice(provider.length + 1);
  if (slug.startsWith("codex/")) slug = slug.slice("codex/".length);
  const slash = slug.lastIndexOf("/");
  return slash >= 0 ? slug.slice(slash + 1) : slug;
}

/** "5-5" → "5.5" inside a slug, so versions read as versions. */
function joinVersion(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    if (previous !== undefined && /^\d+(\.\d+)*$/.test(previous) && /^\d+$/.test(part)) {
      if (part.length <= 2 && !/\.\d+$/.test(previous)) {
        out[out.length - 1] = `${previous}.${part}`;
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

const SPECIAL_WORDS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  oss: "OSS",
  ai: "AI",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  xai: "xAI",
};

/** A product name from a model slug. Exported for tests. */
export function humanizeModelSlug(slug: string): string {
  const lower = slug.toLowerCase();
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(lower);
  if (gpt) {
    const rest = gpt[2] ? ` ${gpt[2].split("-").filter(Boolean).map(titleWord).join(" ")}` : "";
    return `GPT ${gpt[1]}${rest}`;
  }
  const grok = /^grok-(.+)$/.exec(lower);
  if (grok) return `Grok ${joinVersion(grok[1]!.split("-")).map(titleWord).join(" ")}`;
  const parts = joinVersion(lower.split(/[-_]+/).filter(Boolean));
  return parts.map((part) => SPECIAL_WORDS[part] ?? titleWord(part)).join(" ");
}

export type ModelLabelSource = ReadonlyMap<string, string>;

/**
 * The model's display name. `catalog` maps catalog model ids (and their bare
 * slugs) to the label the model picker shows.
 */
export function modelDisplayName(
  provider: RawProvider,
  model: string,
  catalog?: ModelLabelSource,
): string {
  const slug = modelSlug(provider, model);
  const fromCatalog = catalog?.get(model) ?? catalog?.get(slug);
  if (fromCatalog) return fromCatalog;
  return humanizeModelSlug(slug);
}

/** The model family's mark when it's recognizable, else what served it. */
export function modelMark(provider: RawProvider, model: string): MarkId {
  const slug = modelSlug(provider, model).toLowerCase();
  if (slug.startsWith("claude")) {
    return provider.includes("claude-subscription") ? "claude_subscription" : "anthropic";
  }
  if (slug.startsWith("gpt") || /^o\d/.test(slug)) {
    return provider === "azure-openai"
      ? "azure_openai"
      : provider === "openai"
        ? "openai"
        : "codex";
  }
  if (slug.startsWith("grok")) return "supergrok";
  return providerMark(provider);
}

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
