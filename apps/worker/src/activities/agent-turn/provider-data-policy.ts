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
  /**
   * What Opengeni's own requests on this route do, when that changes the
   * provider's default. Shown only when Opengeni calls the provider directly,
   * never for a gateway's upstream provider.
   */
  opengeni?: string;
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
      "Abuse monitoring may store flagged prompts and outputs for human review in the resource's geography; the period is not stated (unknown). Responses API response data is kept for 30 days by default.",
    location:
      "Data at rest stays in the Azure resource's geography. Global deployments may process prompts in any geography where the model is deployed; Data Zone EU deployments process only in EU member states.",
    sources: [
      "https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/data-privacy",
      "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring",
      "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses",
    ],
    opengeni: "Opengeni does not turn off Responses API storage on Azure chat turns.",
    checkedOn: CHECKED_2026_10_30,
  },
  azure_foundry_fireworks: {
    family: "azure_foundry_fireworks",
    provider: "Fireworks AI, reached through Microsoft Azure AI Foundry",
    training: NOT_STATED,
    retention: NOT_STATED,
    location:
      "Processed by Fireworks on its own GPUs outside Microsoft facilities, as a Microsoft subprocessor. Microsoft excludes Fireworks on Foundry from its EU Data Boundary commitments. Pay-per-token Data Zone deployments run in US regions; for other deployments the region is not stated (unknown).",
    sources: [
      "https://learn.microsoft.com/en-us/azure/foundry/how-to/fireworks/privacy-compliance-faq",
      "https://learn.microsoft.com/en-us/azure/foundry/how-to/fireworks/enable-fireworks-models",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  amazon_bedrock: {
    family: "amazon_bedrock",
    provider: "Amazon Bedrock (AWS)",
    training:
      "No. Neither AWS nor the model's maker uses prompts or outputs to train models, and the model's maker does not receive them.",
    retention:
      "Depends on the model. AWS stores prompts and outputs for models on its abuse-detection list, for up to 30 days inside AWS in the region that processed the request, and does not share them with the model's maker. AWS may also keep content for child sexual abuse material detection. When checked, Claude Opus 5.5 and Sonnet 5.5 were not on that list.",
    location:
      "A global.* inference profile can process in any commercial AWS region; an eu.* profile processes only in EU AWS regions.",
    sources: [
      "https://aws.amazon.com/bedrock/faqs/",
      "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html",
      "https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html",
      "https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  anthropic_api: {
    family: "anthropic_api",
    provider: "Anthropic API",
    training: "No, not without express permission.",
    retention:
      "Deleted within 30 days of receipt by default; content flagged by Anthropic's trust and safety systems can be kept for up to 2 years. Zero data retention only by separate agreement.",
    location: "Inference may run in any geography by default.",
    sources: [
      "https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention",
      "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
      "https://platform.claude.com/docs/en/build-with-claude/data-residency",
    ],
    opengeni:
      "Opengeni does not set an inference region, so the Anthropic workspace's own default applies.",
    checkedOn: CHECKED_2026_10_30,
  },
  claude_subscription: {
    family: "claude_subscription",
    provider: "Anthropic, under the connected Claude subscription's own terms",
    training:
      "Personal plans (Free, Pro, Max): used for training when the account's model-improvement setting is on, and also for chats flagged for safety review and feedback the user submits. Team and Enterprise plans: not used for training unless the organization opts in or users submit feedback.",
    retention:
      "Personal plans: up to 30 days after deletion with model improvement off, up to 5 years with it on; flagged content up to 2 years; feedback 5 years. Team and Enterprise plans: 30 days by default under the commercial terms.",
    location: NOT_STATED,
    sources: [
      "https://code.claude.com/docs/en/data-usage",
      "https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training",
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
      "Abuse-monitoring logs are kept for up to 30 days, unless the law requires longer. Responses API data is kept for 30 days by default. Zero data retention only with OpenAI's approval.",
    location:
      "Not stated for default projects (unknown). Data residency projects and the regional endpoints pin processing to that region.",
    sources: ["https://developers.openai.com/api/docs/guides/your-data"],
    opengeni: "Opengeni does not turn off Responses API storage for chat turns.",
    checkedOn: CHECKED_2026_10_30,
  },
  codex_subscription: {
    family: "codex_subscription",
    provider: "OpenAI, under the connected ChatGPT subscription's own terms",
    training:
      'Personal ChatGPT plans: may be used for training unless the account turns off "Improve the model for everyone". Business, Enterprise and Edu plans: not used for training by default.',
    retention: "Set by the ChatGPT account's terms and settings.",
    location:
      "Not stated (unknown); ChatGPT Enterprise and Edu workspaces can have data residency.",
    sources: [
      "https://help.openai.com/en/articles/7730893-data-controls-faq",
      "https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance",
    ],
    opengeni: "Opengeni asks OpenAI not to store responses on this route.",
    checkedOn: CHECKED_2026_10_30,
  },
  xai_api: {
    family: "xai_api",
    provider: "xAI API",
    training: "No, not without permission.",
    retention:
      "Kept for 30 days for abuse auditing, then deleted. A team admin can turn on zero data retention (self-serve where available, or under an enterprise agreement).",
    location:
      "The default endpoint does not guarantee a processing region (unknown); only the US endpoint keeps processing in the US.",
    sources: ["https://docs.x.ai/developers/faq/security"],
    checkedOn: CHECKED_2026_10_30,
  },
  xai_subscription: {
    family: "xai_subscription",
    provider: "xAI, under the connected SuperGrok subscription's consumer terms",
    training: "May be used to train models; the consumer privacy policy lists training as a use.",
    retention:
      "No fixed period is stated; xAI keeps personal data while it has an ongoing legitimate business need.",
    location: "Not stated (unknown).",
    sources: ["https://x.ai/legal/privacy-policy"],
    checkedOn: CHECKED_2026_10_30,
  },
  vercel_ai_gateway: {
    family: "vercel_ai_gateway",
    provider: "Vercel AI Gateway, which forwards to an upstream model provider",
    training:
      "Vercel does not train on it. The upstream provider's policy applies; it can be that provider's default or a stricter agreement Vercel has with it. Opengeni's requests do not ask for Vercel's no-training or zero-retention routing; Vercel team or virtual-model settings could still apply it (not checked).",
    retention:
      "Vercel keeps no prompts or outputs after the request. The upstream provider's retention applies.",
    location:
      "Vercel may handle the request in any of its regions, and no inference region is pinned (a virtual model's own setting is not checked).",
    sources: [
      "https://vercel.com/docs/ai-gateway/capabilities/zdr",
      "https://vercel.com/docs/ai-gateway/capabilities/disallow-prompt-training",
      "https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  google_vertex: {
    family: "google_vertex",
    provider: "Google Cloud Vertex AI (Gemini)",
    training: "No, not without permission.",
    retention:
      "Google caches data for up to 24 hours by default. Under the online Google Cloud terms, prompts its abuse checks flag may be kept for up to 90 days with possible human review; Google Frontier Models also log prompts and responses for up to 30 days. Customers with a Google Cloud Master Agreement are exempt from the flagged-prompt logging by default.",
    location: "Processed in any region unless a regional endpoint is used.",
    sources: [
      "https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention",
      "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/abuse-monitoring",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  openrouter: {
    family: "openrouter",
    provider: "OpenRouter, which forwards to an upstream model provider",
    training:
      "OpenRouter uses prompts only if the account opts in, apart from anonymously sampling a small number of prompts to categorize them. The upstream provider OpenRouter routes to applies its own policy; an account setting can exclude providers that train.",
    retention:
      "OpenRouter stores prompts if the account opts in, or when content is flagged as potential child sexual abuse material; it may also sample a small number of prompts anonymously for categorization, and it keeps request metadata. The upstream provider's own retention applies.",
    location:
      "Not pinned to a region (OpenRouter's in-region routing is not used); the upstream region is not stated (unknown).",
    sources: [
      "https://openrouter.ai/docs/guides/privacy/data-collection",
      "https://openrouter.ai/docs/guides/privacy/logging",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  opper: {
    family: "opper",
    provider: "Opper, an EU-hosted gateway that forwards to an upstream model provider",
    training: "Opper does not train on it. The upstream provider's policy applies.",
    retention:
      "By default Opper stores usage metadata only, not prompts or responses; an account can turn on tracing for 1 to 30 days. Upstream retention depends on the route.",
    location:
      "Opper's gateway is hosted in the EU (Stockholm); the upstream model's region depends on the model.",
    sources: [
      "https://docs.opper.ai",
      "https://opper.ai/pricing",
      "https://opper.ai/ai-compliance",
      "https://docs.opper.ai/control-plane/zero-data-retention",
    ],
    checkedOn: CHECKED_2026_10_30,
  },
  unknown: {
    family: "unknown",
    provider: "A provider this deployment does not describe (custom or self-hosted)",
    training: "Unknown.",
    retention: "Unknown.",
    location: "Unknown unless this route declares a region above.",
    sources: [],
    checkedOn: null,
  },
});
