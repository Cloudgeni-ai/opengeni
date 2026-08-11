import { createHash } from "node:crypto";

import {
  CapabilityPack,
  stableJson,
  type CapabilityPackSkill,
  type PackComponentResolution,
  type PackInstallationPreview,
  type PackRigResolution,
  type ScheduledTaskAgentConfig,
  type SocialConnection,
} from "@opengeni/contracts";
import {
  getPackInstallation,
  getRig,
  getVariableSet,
  getWorkspacePack,
  listPackInstallations,
  listWorkspacePacks,
  resolvePackComponentReferences,
  resolvePackInlineSkillReferences,
  type Database,
} from "@opengeni/db";
import { buildPortableSkillArtifact } from "@opengeni/runtime/skill-library";
import { HTTPException } from "hono/http-exception";

export const MARKETING_SOCIAL_PACK_ID = "marketing-social-daily-analysis";

const marketingSocialPack: CapabilityPack = {
  id: MARKETING_SOCIAL_PACK_ID,
  name: "Marketing social daily analysis",
  description:
    "Connect social accounts, attach marketing knowledge, and schedule agents to produce daily media performance analysis.",
  role: "marketing",
  category: "social-media",
  version: "0.1.0",
  // Built-in packs deliberately declare no sandboxImage and no skills: the
  // worker's pack-runtime resolution only reads manifest-registered packs
  // (see apps/worker/src/activities/packs.ts), and a test enforces this.
  skills: [],
  components: [],
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
      scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
      required: false,
      metadata: {
        docs: "https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code",
        firstParty: true,
        oauthStartPath: "/social/oauth/start",
      },
    },
    {
      id: "reddit",
      name: "Reddit",
      category: "social-media",
      authModel: "oauth2_authorization_code",
      providers: ["reddit"],
      scopes: ["identity", "read", "submit", "privatemessages", "history"],
      required: false,
      metadata: {
        docs: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
        firstParty: true,
        oauthStartPath: "/social/oauth/start",
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
      scopes: [
        "instagram_basic",
        "instagram_manage_insights",
        "pages_read_engagement",
        "pages_show_list",
      ],
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
      scopes: [
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/yt-analytics.readonly",
      ],
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
      description:
        "Optional workspace document base with brand voice, campaign calendars, audience research, and reporting rules.",
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
      "x_accounts_list",
      "x_search_live",
      "x_mentions_live",
      "x_thread_fetch",
      "x_posts_sync",
      "x_post_reply",
      "reddit_accounts_list",
      "reddit_search_live",
      "reddit_mentions_live",
      "reddit_thread_fetch",
      "reddit_posts_sync",
      "reddit_post_reply",
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

export function isBuiltInCapabilityPack(packId: string): boolean {
  return getCapabilityPack(packId) !== null;
}

/**
 * Built-in packs plus the manifests registered for this workspace. Stored
 * manifests were validated at registration time; rows that no longer parse
 * (for example after a contract tightening) are skipped instead of breaking
 * the whole catalog.
 */
export async function listWorkspaceCapabilityPacks(
  db: Database,
  workspaceId: string,
): Promise<CapabilityPack[]> {
  const registered = await listWorkspacePacks(db, workspaceId);
  const builtInIds = new Set(packs.map((pack) => pack.id));
  const registeredPacks = registered
    .filter((registration) => !builtInIds.has(registration.pack.id))
    .flatMap((registration) => {
      const parsed = CapabilityPack.safeParse(registration.pack);
      return parsed.success ? [parsed.data] : [];
    });
  return [...packs, ...registeredPacks];
}

export async function resolveCapabilityPack(
  db: Database,
  workspaceId: string,
  packId: string,
): Promise<CapabilityPack | null> {
  const builtIn = getCapabilityPack(packId);
  if (builtIn) {
    return builtIn;
  }
  const registration = await getWorkspacePack(db, workspaceId, packId);
  if (!registration) {
    return null;
  }
  const parsed = CapabilityPack.safeParse(registration.pack);
  return parsed.success ? parsed.data : null;
}

export function capabilityPackManifestDigest(pack: CapabilityPack): string {
  return createHash("sha256").update(stableJson(pack)).digest("hex");
}

/** True when the Pack must use the owner-aware V2 preview/install lifecycle. */
export function capabilityPackRequiresInstallationPlan(pack: CapabilityPack): boolean {
  return (
    pack.components.length > 0 ||
    pack.skills.length > 0 ||
    pack.rig !== undefined ||
    pack.sandboxImage !== undefined ||
    pack.sandboxProviderImages !== undefined
  );
}

export type InlinePackSkillInstall = {
  componentKey: string;
  capabilityId: string;
  pluginKey: string;
  sourceUrl: string;
  repositoryUrl: string;
  sourceCommit: string;
  sourcePath: string;
  name: string;
  description: string;
  contentSha256: string;
  totalBytes: number;
  files: Array<{ path: string; content: string; byteSize: number; contentSha256: string }>;
};

/** Convert a legacy inline Pack Skill into the ordinary immutable Skill model. */
export function inlinePackSkillInstall(
  pack: CapabilityPack,
  skill: CapabilityPackSkill,
): InlinePackSkillInstall {
  const artifact = buildPortableSkillArtifact(skill.files);
  if (artifact.name.toLowerCase() !== skill.name.toLowerCase()) {
    throw new HTTPException(422, {
      message: `Pack Skill ${skill.name} has SKILL.md name ${artifact.name}; the names must match`,
    });
  }
  const normalizedName = skill.name.toLowerCase();
  const encodedSkill = encodeURIComponent(normalizedName);
  const sourceUrl = `https://opengeni.invalid/pack-inline-skills/${encodedSkill}/${artifact.contentSha256}`;
  const capabilityId = `skill:pack-inline/${normalizedName}@${artifact.contentSha256}`;
  return {
    componentKey: `inline-skill/${normalizedName}`,
    capabilityId,
    pluginKey: `pack-skill/${normalizedName}/${artifact.contentSha256}`,
    sourceUrl,
    repositoryUrl: "https://opengeni.invalid/pack-inline-skills",
    sourceCommit: artifact.contentSha256,
    sourcePath: normalizedName,
    name: artifact.name,
    description: artifact.description,
    contentSha256: artifact.contentSha256,
    totalBytes: artifact.totalBytes,
    files: artifact.files.map((file) => ({
      path: file.path,
      content: file.content,
      byteSize: new TextEncoder().encode(file.content).byteLength,
      contentSha256: createHash("sha256").update(file.content).digest("hex"),
    })),
  };
}

export async function previewCapabilityPackInstallation(
  db: Database,
  workspaceId: string,
  pack: CapabilityPack,
  options: { rigId?: string; variableSetId?: string } = {},
): Promise<PackInstallationPreview> {
  const installation = await getPackInstallation(db, workspaceId, pack.id);
  const inlineInstalls = pack.skills.map((skill) => inlinePackSkillInstall(pack, skill));
  const [referencedComponents, inlineComponents] = await Promise.all([
    resolvePackComponentReferences(db, workspaceId, pack.components),
    resolvePackInlineSkillReferences(
      db,
      workspaceId,
      inlineInstalls.map((inline) => ({
        key: inline.componentKey,
        capabilityId: inline.capabilityId,
        name: inline.name,
        contentSha256: inline.contentSha256,
      })),
      installation?.id,
    ),
  ]);
  const manifestDigest = capabilityPackManifestDigest(pack);
  const components: PackComponentResolution[] = [...referencedComponents, ...inlineComponents];
  const blockers = components
    .filter((component) => component.required && component.status !== "ready")
    .map((component) =>
      component.status === "missing"
        ? `${component.label} is not installed in this workspace`
        : `${component.label} does not match the Pack's pinned version`,
    );
  const rig = await resolvePackRig(
    db,
    workspaceId,
    pack,
    options.rigId,
    installation?.selectedRigId,
  );
  if (
    rig.status !== "ready" &&
    rig.status !== "not_required" &&
    (rig.required || rig.requestedRigId !== null || rig.rigId !== null)
  ) {
    blockers.push(packRigBlocker(rig, pack.sandboxImage ?? null));
  }
  const variableSetId =
    options.variableSetId ?? storedVariableSetId(installation?.metadata) ?? null;
  if (pack.variableSet?.required && !variableSetId) {
    blockers.push("Choose saved configuration before installing this Pack");
  } else if (variableSetId) {
    const variableSet = await getVariableSet(db, workspaceId, variableSetId);
    if (!variableSet) {
      blockers.push("The selected configuration no longer exists in this workspace");
    } else {
      const missing = (pack.variableSet?.requiredVariables ?? []).filter(
        (name) => !variableSet.variables.some((variable) => variable.name === name),
      );
      if (missing.length > 0) {
        blockers.push(`Configuration is missing required value(s): ${missing.join(", ")}`);
      }
    }
  }
  const action =
    !installation || installation.status === "disabled"
      ? "install"
      : installation.manifestDigest === manifestDigest
        ? "repair"
        : "update";
  return {
    packId: pack.id,
    packVersion: pack.version,
    manifestDigest,
    installationVersion: installation?.version ?? null,
    action,
    ready: blockers.length === 0,
    blockers,
    components,
    rig,
    variableSetId,
    legacyInlineSkillCount: pack.skills.length,
    legacySandboxImage: pack.sandboxImage ?? null,
  };
}

async function resolvePackRig(
  db: Database,
  workspaceId: string,
  pack: CapabilityPack,
  requestedRigId: string | undefined,
  storedRigId: string | null | undefined,
): Promise<PackRigResolution> {
  const required = pack.rig?.required === true || Boolean(pack.sandboxImage);
  const selectedRigId = pack.rig?.rigId ?? requestedRigId ?? storedRigId ?? null;
  if (!required && !selectedRigId) {
    return {
      required: false,
      status: "not_required",
      requestedRigId: requestedRigId ?? null,
      rigId: null,
      rigVersionId: null,
      name: null,
      image: null,
    };
  }
  if (pack.rig?.rigId && requestedRigId && pack.rig.rigId !== requestedRigId) {
    return {
      required,
      status: "mismatch",
      requestedRigId,
      rigId: pack.rig.rigId,
      rigVersionId: null,
      name: null,
      image: null,
    };
  }
  if (!selectedRigId) {
    return {
      required,
      status: "missing",
      requestedRigId: requestedRigId ?? null,
      rigId: null,
      rigVersionId: null,
      name: null,
      image: null,
    };
  }
  const rig = await getRig(db, workspaceId, selectedRigId);
  if (!rig?.activeVersion) {
    return {
      required,
      status: "missing",
      requestedRigId: requestedRigId ?? null,
      rigId: selectedRigId,
      rigVersionId: null,
      name: rig?.name ?? null,
      image: null,
    };
  }
  const image = rig.activeVersion.image ?? null;
  const status =
    pack.sandboxImage && image !== pack.sandboxImage
      ? "mismatch"
      : pack.rig?.requireVerified && rig.activeVersionHealth?.checkHealth !== "passing"
        ? "unverified"
        : "ready";
  return {
    required,
    status,
    requestedRigId: requestedRigId ?? null,
    rigId: rig.id,
    rigVersionId: rig.activeVersion.id,
    name: rig.name,
    image,
  };
}

function packRigBlocker(rig: PackRigResolution, legacyImage: string | null): string {
  if (rig.status === "missing") {
    return "Choose an available compute environment before installing this Pack";
  }
  if (rig.status === "unverified") {
    return "Verify the selected compute environment before installing this Pack";
  }
  if (legacyImage) {
    return `The selected compute environment must use the Pack's previous image ${legacyImage}; the Pack will not replace workspace compute`;
  }
  return "The selected compute environment does not satisfy this Pack's requirement";
}

function storedVariableSetId(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.variableSetId ?? metadata?.environmentId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * v1 pack-scoped runtime rule: at most one enabled pack per workspace may
 * declare a `sandboxImage` — there is deliberately no image composition or
 * layering. Enforced when a pack is enabled (both the packs endpoint and the
 * generic capability enable path) and re-checked at session start by the
 * worker, which also covers manifests re-registered after enablement.
 */
export async function assertPackSandboxImageCompatible(
  db: Database,
  workspaceId: string,
  pack: CapabilityPack,
): Promise<void> {
  if (!pack.sandboxImage) {
    return;
  }
  const installations = await listPackInstallations(db, workspaceId);
  for (const installation of installations) {
    if (installation.status !== "active" || installation.packId === pack.id) {
      continue;
    }
    const other = await resolveCapabilityPack(db, workspaceId, installation.packId);
    if (other?.sandboxImage) {
      throw new HTTPException(409, {
        message: `pack ${pack.id} declares a sandbox image, but enabled pack ${other.id} already declares one; only one enabled pack per workspace may declare sandboxImage — disable ${other.id} first`,
      });
    }
  }
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
  const connectionLines = input.connections
    .map((connection) => {
      return `- ${connection.provider}: ${connection.accountHandle} (${connection.id})`;
    })
    .join("\n");
  const knowledgeLine =
    input.documentBaseIds.length > 0
      ? `Use these document base IDs for brand/campaign knowledge through the docs MCP: ${input.documentBaseIds.join(", ")}.`
      : "No document base IDs were selected; rely only on social context returned by tools.";
  const extra = input.promptInstructions
    ? `\nAdditional operator instructions:\n${input.promptInstructions.trim()}\n`
    : "";

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
  ]
    .filter(Boolean)
    .join("\n");
}
