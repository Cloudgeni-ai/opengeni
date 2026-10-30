/**
 * What each model provider route does with the data Opengeni sends it: whether
 * the provider trains on it, how long it keeps it, and where it processes it.
 *
 * This is the one reviewed table behind `privacy_facts`. Every statement comes
 * from the provider's own current documentation, listed in `sources` with the
 * date it was checked. Anything the documentation does not state says so
 * ("not stated"); never fill a gap from general knowledge. Changing a row is a
 * reviewed change: re-read the sources, update `checkedOn`, and record it in
 * docs/privacy-facts.md.
 */

export const PROVIDER_DATA_POLICY_FAMILIES = [
  "azure_openai",
  "azure_foundry_fireworks",
  "amazon_bedrock",
  "anthropic_api",
  "claude_subscription",
  "openai_api",
  "codex_subscription",
  "xai_api",
  "xai_subscription",
  "vercel_ai_gateway",
  "google_vertex",
  "openrouter",
  "opper",
  "unknown",
] as const;
export type ProviderDataPolicyFamily = (typeof PROVIDER_DATA_POLICY_FAMILIES)[number];

export type ProviderDataPolicy = {
  family: ProviderDataPolicyFamily;
  /** Who processes the data, in plain words. */
  provider: string;
  /** Whether the provider uses the data to train models. */
  training: string;
  /** How long the provider keeps prompts and outputs, including abuse monitoring. */
  retention: string;
  /** Where the provider processes the data, before this route's own declaration. */
  location: string;
  /** The provider's own documentation for the statements above. */
  sources: readonly string[];
  /** ISO date the sources were last read. Null only for the unknown row. */
  checkedOn: string | null;
};

export const NOT_STATED = "Not stated in the provider's documentation (unknown).";

const CHECKED_2026_10_30 = "2026-10-30";

export const PROVIDER_DATA_POLICIES: Readonly<
  Record<ProviderDataPolicyFamily, ProviderDataPolicy>
> = Object.freeze({
  azure_openai: {
    family: "azure_openai",
    provider: "Microsoft Azure OpenAI in Azure AI Foundry (models sold by Azure)",
    training:
      "No. Microsoft does not use prompts or outputs to train models without permission, and they are not available to OpenAI.",
    retention:
      "Abuse monitoring may store flagged prompts and outputs for human review in the resource's geography; the period is not stated (unknown). Responses API conversation state is kept for 30 days by default, and Opengeni does not turn that storage off on Azure.",
    location:
      "Data at rest stays in the Azure resource's geography. Global deployments may process prompts in any Azure geography; Data Zone EU deployments process only in EU member states.",
    sources: [
      "https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/data-privacy",
      "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring",
      "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  azure_foundry_fireworks: {
    family: "azure_foundry_fireworks",
    provider: "Fireworks AI, reached through Microsoft Azure AI Foundry",
    training: NOT_STATED,
    retention: NOT_STATED,
    location:
      "Processed by Fireworks outside Microsoft's systems and outside the EU Data Boundary; the region is not stated (unknown).",
    sources: [
      "https://learn.microsoft.com/en-us/azure/foundry/how-to/fireworks/privacy-compliance-faq",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  amazon_bedrock: {
    family: "amazon_bedrock",
    provider: "Amazon Bedrock (AWS)",
    training:
      "No. Neither AWS nor the model's maker uses prompts or outputs to train models, and the model's maker does not receive them.",
    retention:
      "Depends on the model. Most models keep nothing after the request. Models that require AWS abuse review keep prompts and outputs for up to 30 days inside AWS.",
    location:
      "A global.* inference profile can process in any commercial AWS region; an eu.* profile processes only in EU AWS regions.",
    sources: [
      "https://aws.amazon.com/bedrock/faqs/",
      "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html",
      "https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  anthropic_api: {
    family: "anthropic_api",
    provider: "Anthropic API",
    training: "No, not without express permission.",
    retention:
      "Deleted within 30 days of receipt by default; content flagged for usage-policy violations can be kept for up to 2 years. Zero data retention only by separate agreement.",
    location: "Processed globally; no region is pinned.",
    sources: [
      "https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention",
      "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  claude_subscription: {
    family: "claude_subscription",
    provider: "Anthropic, under the connected Claude subscription's own terms",
    training:
      "Personal Claude plans: only if the account's model-improvement setting is on. Team and Enterprise plans follow Anthropic's commercial terms (no training without permission).",
    retention:
      "Personal plans: with model improvement off, kept up to 30 days after deletion; with it on, up to 5 years in de-identified form; flagged content up to 2 years. Team and Enterprise plans follow the commercial terms.",
    location: "Processed globally; no region is pinned.",
    sources: [
      "https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data",
      "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  openai_api: {
    family: "openai_api",
    provider: "OpenAI API",
    training: "No, unless the organization opts in.",
    retention:
      "Abuse-monitoring logs are kept for up to 30 days. Opengeni asks OpenAI not to store responses. Zero data retention only with OpenAI's approval.",
    location: "Processed in the United States unless a regional endpoint is used.",
    sources: ["https://developers.openai.com/api/docs/guides/your-data"],
    checkedOn: CHECKED_2026_10_30,
  },
  codex_subscription: {
    family: "codex_subscription",
    provider: "OpenAI, under the connected ChatGPT subscription's own terms",
    training:
      'Personal ChatGPT plans: may be used for training unless the account turns off "Improve the model for everyone". Business, Enterprise and Edu plans: not used for training by default.',
    retention:
      "Set by the ChatGPT account's terms and settings. Opengeni asks OpenAI not to store responses.",
    location: "Processed in the United States unless the account has data residency.",
    sources: [
      "https://help.openai.com/en/articles/7730893-data-controls-faq",
      "https://developers.openai.com/api/docs/guides/your-data",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  xai_api: {
    family: "xai_api",
    provider: "xAI API",
    training: "No, not without permission.",
    retention:
      "Kept for 30 days for abuse auditing, then deleted. Zero data retention for enterprise customers by agreement.",
    location: "Processed in the United States.",
    sources: ["https://docs.x.ai/developers/faq/security"],
    checkedOn: CHECKED_2026_10_30,
  },
  xai_subscription: {
    family: "xai_subscription",
    provider: "xAI, under the connected SuperGrok subscription's consumer terms",
    training: "May be used to train models; the consumer privacy policy lists training as a use.",
    retention: NOT_STATED,
    location: "Processed in the United States.",
    sources: ["https://x.ai/legal/privacy-policy"],
    checkedOn: CHECKED_2026_10_30,
  },
  vercel_ai_gateway: {
    family: "vercel_ai_gateway",
    provider: "Vercel AI Gateway, which forwards to an upstream model provider",
    training:
      "Vercel does not train on it. The upstream provider's own default applies; Opengeni does not request Vercel's no-training or zero-retention routing.",
    retention:
      "Vercel keeps no prompts or outputs after the request. The upstream provider's own retention applies.",
    location: "Processed globally; the upstream region is not pinned.",
    sources: ["https://vercel.com/docs/ai-gateway/capabilities/zdr"],
    checkedOn: CHECKED_2026_10_30,
  },
  google_vertex: {
    family: "google_vertex",
    provider: "Google Cloud Vertex AI (Gemini)",
    training: "No, not without permission.",
    retention:
      "Google may log prompts for abuse monitoring and cache them briefly; the period is not stated (unknown).",
    location: "Processed globally unless a regional endpoint is used.",
    sources: [
      "https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  openrouter: {
    family: "openrouter",
    provider: "OpenRouter, which forwards to an upstream model provider",
    training:
      "OpenRouter uses prompts only if the account opts in. The upstream provider OpenRouter routes to applies its own policy; an account setting can exclude providers that train.",
    retention:
      "OpenRouter keeps prompts only if the account opts in, or when legally required. The upstream provider's own retention applies.",
    location: "Processed globally; the upstream region is not pinned.",
    sources: [
      "https://openrouter.ai/docs/guides/privacy/data-collection",
      "https://openrouter.ai/docs/guides/privacy/logging",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  opper: {
    family: "opper",
    provider: "Opper, an EU-hosted gateway that forwards to an upstream model provider",
    training: NOT_STATED,
    retention: "Configurable per Opper account; the default is not stated (unknown).",
    location:
      "Opper's gateway is hosted in the EU; the upstream model's region depends on the model.",
    sources: ["https://docs.opper.ai"],
    checkedOn: CHECKED_2026_10_30,
  },
  unknown: {
    family: "unknown",
    provider: "A provider this deployment does not describe (custom or self-hosted)",
    training: "Unknown.",
    retention: "Unknown.",
    location: "Unknown unless this route declares a region below.",
    sources: [],
    checkedOn: null,
  },
});
