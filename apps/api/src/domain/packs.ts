import type {
  CapabilityPack,
  ScheduledTaskAgentConfig,
  SocialConnection,
} from "@opengeni/contracts";

export const MARKETING_SOCIAL_PACK_ID = "marketing-social-daily-analysis";

const marketingSocialPack: CapabilityPack = {
  id: MARKETING_SOCIAL_PACK_ID,
  name: "Marketing social daily analysis",
  description: "Connect social accounts, attach marketing knowledge, and schedule agents to produce daily media performance analysis.",
  role: "marketing",
  category: "social-media",
  version: "0.1.0",
  tools: [
    { kind: "mcp", id: "opengeni" },
    { kind: "mcp", id: "docs" },
  ],
  connectors: [
    {
      id: "x",
      name: "X",
      category: "social-media",
      authModel: "oauth2_authorization_code_pkce",
      providers: ["x"],
      scopes: ["tweet.read", "users.read", "offline.access"],
      required: false,
      metadata: {
        docs: "https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code",
      },
    },
    {
      id: "linkedin",
      name: "LinkedIn",
      category: "social-media",
      authModel: "oauth2_authorization_code",
      providers: ["linkedin"],
      scopes: ["r_organization_social", "rw_organization_admin"],
      required: false,
      metadata: {
        docs: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview",
      },
    },
    {
      id: "instagram",
      name: "Instagram",
      category: "social-media",
      authModel: "oauth2_authorization_code",
      providers: ["instagram", "facebook"],
      scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement", "pages_show_list"],
      required: false,
      metadata: {
        docs: "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/",
      },
    },
    {
      id: "tiktok",
      name: "TikTok",
      category: "social-media",
      authModel: "oauth2_authorization_code",
      providers: ["tiktok"],
      scopes: ["user.info.basic", "video.list"],
      required: false,
      metadata: {
        docs: "https://developers.tiktok.com/doc/tiktok-api-v2-introduction/",
      },
    },
    {
      id: "youtube",
      name: "YouTube",
      category: "social-media",
      authModel: "oauth2_authorization_code",
      providers: ["youtube"],
      scopes: ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"],
      required: false,
      metadata: {
        docs: "https://developers.google.com/youtube/v3",
      },
    },
  ],
  knowledge: [
    {
      type: "document_base",
      id: "marketing-playbook",
      name: "Marketing playbook",
      description: "Optional workspace document base with brand voice, campaign calendars, audience research, and reporting rules.",
      required: false,
    },
  ],
  scheduledTaskTemplates: [
    {
      id: "daily-social-analysis",
      name: "Daily social analysis",
      description: "Review the latest social posts and account signals every day.",
      defaultSchedule: {
        type: "calendar",
        timeZone: "UTC",
        hour: 9,
        minute: 0,
      },
      defaultRunMode: "new_session_per_run",
      defaultOverlapPolicy: "skip",
    },
  ],
  metadata: {
    skill: "social-media-marketing",
    firstPartyMcpTools: [
      "social_connections_list",
      "social_posts_recent",
      "social_daily_analysis_context",
    ],
  },
};

const packs = [marketingSocialPack] satisfies CapabilityPack[];

export function listCapabilityPacks(): CapabilityPack[] {
  return packs;
}

export function getCapabilityPack(packId: string): CapabilityPack | null {
  return packs.find((pack) => pack.id === packId) ?? null;
}

export function buildMarketingDailyAnalysisAgentConfig(input: {
  connections: SocialConnection[];
  documentBaseIds: string[];
  promptInstructions?: string;
}): ScheduledTaskAgentConfig {
  const connectionIds = input.connections.map((connection) => connection.id);
  return {
    prompt: marketingDailyAnalysisPrompt({
      connections: input.connections,
      documentBaseIds: input.documentBaseIds,
      ...(input.promptInstructions ? { promptInstructions: input.promptInstructions } : {}),
    }),
    resources: [],
    tools: marketingSocialPack.tools,
    metadata: {
      packId: MARKETING_SOCIAL_PACK_ID,
      packTemplateId: "daily-social-analysis",
      socialConnectionIds: connectionIds,
      documentBaseIds: input.documentBaseIds,
      analysisWindowHours: 24,
    },
  };
}

function marketingDailyAnalysisPrompt(input: {
  connections: SocialConnection[];
  documentBaseIds: string[];
  promptInstructions?: string;
}): string {
  const connectionLines = input.connections.map((connection) => {
    return `- ${connection.provider}: ${connection.accountHandle} (${connection.id})`;
  }).join("\n");
  const knowledgeLine = input.documentBaseIds.length > 0
    ? `Use these document base IDs for brand/campaign knowledge through the docs MCP: ${input.documentBaseIds.join(", ")}.`
    : "No document base IDs were selected; rely only on social context returned by tools.";
  const extra = input.promptInstructions ? `\nAdditional operator instructions:\n${input.promptInstructions.trim()}\n` : "";

  return [
    "Run the daily social media analysis for the selected accounts.",
    "",
    "First call the OpenGeni MCP tool social_daily_analysis_context with the selected connection IDs and a 24 hour analysis window. Use social_posts_recent only if you need a narrower follow-up query.",
    knowledgeLine,
    "",
    "Selected accounts:",
    connectionLines,
    extra,
    "Produce a concise report with these sections: executive summary, notable account changes, winning posts, underperforming posts, audience and content signals, recommended actions for the next 24 hours, and data gaps.",
    "Use only metrics and posts returned by tools or document search. Do not invent metrics, posts, or account capabilities.",
  ].filter(Boolean).join("\n");
}
