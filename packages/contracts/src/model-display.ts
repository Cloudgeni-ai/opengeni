/**
 * One display identity for a model everywhere outside the Models settings page.
 *
 * Catalog ids carry routing facts (`codex/`, `organization-claude-subscription/`,
 * `workspace-openrouter/anthropic/...`) and custom models may have no curated
 * label. People should only ever see the model itself: `GPT-6.1 Sol`,
 * `Claude Opus 5.5`. The same upstream model therefore renders identically
 * whether an organization or a workspace connection serves it.
 *
 * Pure and dependency-free so the API, SDK, React package and web app share it.
 */

export type ModelVendor =
  | "openai"
  | "anthropic"
  | "xai"
  | "google"
  | "meta"
  | "mistral"
  | "deepseek"
  | "moonshot"
  | "qwen"
  | "zhipu"
  | "nvidia";

export type ModelDisplayInput =
  | string
  | {
      id: string;
      label?: string | null | undefined;
      upstreamModelId?: string | null | undefined;
      deployment?: { upstreamModelId?: string | null | undefined } | null | undefined;
    };

const WORDS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
  gemini: "Gemini",
  gemma: "Gemma",
  llama: "Llama",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  glm: "GLM",
  kimi: "Kimi",
  mistral: "Mistral",
  codestral: "Codestral",
  devstral: "Devstral",
  magistral: "Magistral",
  nemotron: "Nemotron",
  oss: "OSS",
};

/** The upstream model slug without routing prefixes or `:variant` suffixes. */
export function modelSlug(value: string): string {
  const last = value.split("/").filter(Boolean).at(-1) ?? value;
  return last.replace(/:[^:]*$/, "") || last;
}

function upstreamOf(input: Exclude<ModelDisplayInput, string>): string | null {
  return input.upstreamModelId?.trim() || input.deployment?.upstreamModelId?.trim() || null;
}

function titleToken(token: string, index: number): string {
  const lower = token.toLowerCase();
  const word = WORDS[lower];
  if (word) return word;
  // OpenAI reasoning series stay lowercase: o3, o4 Mini.
  if (index === 0 && /^o\d+$/.test(lower)) return lower;
  // Sizes and lettered versions read as identifiers: 120B, V4, K3, A12B.
  if (/^\d+(?:\.\d+)?[bkmt]$/.test(lower) || /^[a-z]\d+[a-z\d]*$/.test(lower)) {
    return lower.toUpperCase();
  }
  if (/^\d/.test(token)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `claude-opus-5-5` → `Claude Opus 5.5`, `codex/gpt-6.1-sol` → `GPT-6.1 Sol`. */
export function humanizeModelSlug(value: string): string {
  const slug = modelSlug(value.trim())
    // Snapshot dates are release detail, not a different model name.
    .replace(/[-_](?:\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/[-_]latest$/i, "");
  const raw = slug.split(/[-_\s]+/).filter(Boolean);
  if (raw.length === 0) return value.trim() || value;
  // Consecutive short numbers are one version: 5-5 → 5.5, 3-5 → 3.5. Longer
  // numbers are snapshots (gpt-4-1106-preview), never a minor version.
  const tokens: string[] = [];
  for (const token of raw) {
    const previous = tokens.at(-1);
    if (previous !== undefined && /^\d{1,2}$/.test(token) && /^\d{1,2}$/.test(previous)) {
      tokens[tokens.length - 1] = `${previous}.${token}`;
      continue;
    }
    tokens.push(token);
  }
  const words = tokens.map(titleToken);
  // OpenAI's own spelling joins family and version: GPT-6.1, GPT-4o.
  if (words[0] === "GPT" && words.length > 1 && /^\d/.test(words[1]!)) {
    return [`GPT-${words[1]}`, ...words.slice(2)].join(" ");
  }
  return words.join(" ");
}

/**
 * True when a catalog label is only the model's identifier: empty, or exactly
 * its id, upstream id, or any trailing path of them (`claude-opus-4-8`,
 * `anthropic/claude-sonnet-4.6`). Any other label is a curated name and wins.
 */
export function isRawModelLabel(
  label: string,
  ids: readonly (string | null | undefined)[] = [],
): boolean {
  const text = label.trim();
  if (!text) return true;
  return ids.some((id) => {
    if (!id) return false;
    const segments = id.trim().split("/").filter(Boolean);
    return segments.some((_, index) => {
      const tail = segments.slice(index).join("/");
      return tail === text || modelSlug(tail) === text;
    });
  });
}

/**
 * The clean name to show for a model: its curated catalog label when it has
 * one, otherwise a readable form of the upstream model id. Never a routing
 * prefix, connection id or connection scope.
 */
export function modelDisplayName(input: ModelDisplayInput): string {
  if (typeof input === "string") {
    // A bare id is humanized; text with spaces is already a name ("Workspace default").
    return input.trim() && !/\s/.test(input.trim()) ? humanizeModelSlug(input) : input;
  }
  const upstream = upstreamOf(input);
  const label = input.label?.trim();
  if (label && !isRawModelLabel(label, [input.id, upstream])) return label;
  return humanizeModelSlug(upstream ?? label ?? input.id);
}

const VENDOR_PATTERNS: ReadonlyArray<readonly [ModelVendor, RegExp]> = [
  ["anthropic", /^claude\b/],
  ["openai", /^(?:gpt|chatgpt|o\d+|codex|dall-e|sora|text-embedding|whisper)\b/],
  ["xai", /^grok\b/],
  ["google", /^(?:gemini|gemma)\b/],
  ["meta", /^llama\b/],
  ["mistral", /^(?:mistral|codestral|devstral|magistral|ministral|pixtral)\b/],
  ["deepseek", /^deepseek\b/],
  ["moonshot", /^(?:kimi|moonshot)\b/],
  ["qwen", /^(?:qwen|qwq)\b/],
  ["zhipu", /^glm\b/],
  ["nvidia", /^nemotron\b/],
];

/** OpenRouter / Gateway vendor path segments (`anthropic/claude-…`). */
const VENDOR_SEGMENTS: Readonly<Record<string, ModelVendor>> = {
  anthropic: "anthropic",
  openai: "openai",
  "x-ai": "xai",
  xai: "xai",
  google: "google",
  "meta-llama": "meta",
  mistralai: "mistral",
  deepseek: "deepseek",
  moonshotai: "moonshot",
  qwen: "qwen",
  "z-ai": "zhipu",
  nvidia: "nvidia",
};

function vendorFromSlug(slug: string): ModelVendor | null {
  for (const [vendor, pattern] of VENDOR_PATTERNS) if (pattern.test(slug)) return vendor;
  return null;
}

/** Who makes the model, for its logo. Null when it cannot be told. */
export function modelVendor(input: ModelDisplayInput): ModelVendor | null {
  const ids = typeof input === "string" ? [input] : [upstreamOf(input), input.id];
  for (const id of ids) {
    if (!id) continue;
    const lower = id.trim().toLowerCase();
    if (lower.startsWith("codex/")) return "openai";
    if (lower.startsWith("supergrok/")) return "xai";
    const vendor = vendorFromSlug(modelSlug(lower));
    if (vendor) return vendor;
    const segment = lower.split("/").filter(Boolean).at(-2);
    if (segment && Object.hasOwn(VENDOR_SEGMENTS, segment)) return VENDOR_SEGMENTS[segment]!;
  }
  if (typeof input !== "string" && input.label) {
    return vendorFromSlug(input.label.trim().toLowerCase().replace(/\s+/g, "-"));
  }
  return null;
}
