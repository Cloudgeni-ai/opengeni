import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

export type TeamsManifestOptions = {
  appId: string;
  botId: string;
  publicBaseUrl: string;
  websiteUrl: string;
  privacyUrl: string;
  termsOfUseUrl: string;
  version?: string;
  appName?: string;
  groupChats?: boolean;
  /** Team scope: mention Opengeni in an approved channel. */
  channels?: boolean;
  /**
   * Resource-specific consent so Teams also delivers the messages that do not
   * mention Opengeni in the installed team or group chat. Opengeni keeps a
   * bounded recent window of them as context for the next mention; they
   * never start work.
   */
  conversationContext?: boolean;
};

function guid(value: string, name: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
  ) {
    throw new Error(`${name} must be a nonzero GUID`);
  }
  return value;
}

function httpsUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url;
}

/** Packaging metadata only: never enables the bot or grants workspace access. */
export function buildTeamsAppManifest(options: TeamsManifestOptions) {
  const appName = options.appName ?? "Opengeni";
  if (!appName.trim() || appName.length > 30)
    throw new Error("appName must contain 1–30 characters");
  const version = options.version ?? "1.0.0";
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("version must be three numeric components");
  }
  const publicUrl = httpsUrl(options.publicBaseUrl, "publicBaseUrl");
  if (publicUrl.pathname !== "/") throw new Error("publicBaseUrl must be an origin");
  const botId = guid(options.botId, "botId");
  const scopes = [
    "personal",
    ...(options.channels ? ["team"] : []),
    ...(options.groupChats ? ["groupChat"] : []),
  ];
  if (options.conversationContext && !options.channels && !options.groupChats)
    throw new Error("conversationContext needs channels or groupChats");
  const contextPermissions = options.conversationContext
    ? [
        ...(options.channels ? [{ name: "ChannelMessage.Read.Group", type: "Application" }] : []),
        ...(options.groupChats ? [{ name: "ChatMessage.Read.Chat", type: "Application" }] : []),
      ]
    : [];
  const shared = [
    ...(options.channels ? ["an approved channel"] : []),
    ...(options.groupChats ? ["an approved group chat"] : []),
  ].join(" or ");
  return {
    $schema: "https://developer.microsoft.com/json-schemas/teams/v1.25/MicrosoftTeams.schema.json",
    manifestVersion: "1.25",
    version,
    id: guid(options.appId, "appId"),
    // Teams admin center rejects 1.25 team-scope packages without it. It only
    // lets the app be added to shared/private channels; the channel allowlist
    // still decides which channels are served.
    ...(options.channels ? { supportsChannelFeatures: "tier1" } : {}),
    developer: {
      name: "Cloudgeni",
      websiteUrl: httpsUrl(options.websiteUrl, "websiteUrl").href,
      privacyUrl: httpsUrl(options.privacyUrl, "privacyUrl").href,
      termsOfUseUrl: httpsUrl(options.termsOfUseUrl, "termsOfUseUrl").href,
    },
    name: { short: appName, full: appName },
    description: {
      short: "Work with Opengeni agents in Teams.",
      full: shared
        ? `Ask Opengeni agents for help in personal chats or mention Opengeni in ${shared}. ${
            options.groupChats
              ? "Every group participant must link their account and have access to the connected Opengeni workspace."
              : "Link your Opengeni account to get started."
          }${
            contextPermissions.length
              ? " Opengeni reads recent messages there only to answer the next mention."
              : ""
          }`
        : "Ask Opengeni agents for help in personal chats. Connect your Opengeni account to get started.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#111111",
    bots: [
      {
        botId,
        scopes,
        isNotificationOnly: false,
        supportsFiles: false,
      },
    ],
    validDomains: [publicUrl.hostname],
    // RSC is the only permission claim, and only with conversationContext: no
    // Graph, tabs or SSO. The resource value is unused by RSC but required.
    ...(contextPermissions.length
      ? {
          webApplicationInfo: { id: botId, resource: "https://RscBasedStoreApp" },
          authorization: { permissions: { resourceSpecific: contextPermissions } },
        }
      : {}),
  };
}

export function teamsManifestOptionsFromEnv(
  env: Record<string, string | undefined>,
): TeamsManifestOptions {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  // Unset, "false" or "0" is off; "true" or "1" is on; anything else is a typo.
  const flag = (key: string) => {
    const value = env[key]?.trim().toLowerCase();
    if (!value || value === "false" || value === "0") return false;
    if (value === "true" || value === "1") return true;
    throw new Error(`${key} must be true or false`);
  };
  return {
    appId: required("OPENGENI_TEAMS_APP_ID"),
    botId: required("OPENGENI_TEAMS_BOT_CLIENT_ID"),
    publicBaseUrl: required("OPENGENI_PUBLIC_BASE_URL"),
    websiteUrl: required("OPENGENI_TEAMS_WEBSITE_URL"),
    privacyUrl: required("OPENGENI_TEAMS_PRIVACY_URL"),
    termsOfUseUrl: required("OPENGENI_TEAMS_TERMS_URL"),
    version: env.OPENGENI_TEAMS_APP_VERSION,
    appName: env.OPENGENI_TEAMS_APP_NAME,
    groupChats: flag("OPENGENI_TEAMS_APP_GROUP_CHATS"),
    channels: flag("OPENGENI_TEAMS_APP_CHANNELS"),
    conversationContext: flag("OPENGENI_TEAMS_APP_CONVERSATION_CONTEXT"),
  };
}

/** Creates a fresh package directory. Existing output is never overwritten. */
export async function writeTeamsAppPackage(options: TeamsManifestOptions, directory: string) {
  const manifest = buildTeamsAppManifest(options);
  const favicon = await readFile(
    resolve(import.meta.dir, "../apps/web/public/favicon.svg"),
    "utf8",
  );
  const path = favicon.match(/<path d="([^"]+)"/)?.[1];
  if (!path) throw new Error("The shared favicon must contain the Opengeni brand path");
  const icon = (size: number, markWidth: number, outline: boolean) => {
    const scale = markWidth / 176;
    const x = (size - markWidth) / 2;
    const y = (size - 138.73 * scale) / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${outline ? "" : `<rect width="${size}" height="${size}" fill="#ffffff"/>`}<g transform="translate(${x} ${y}) scale(${scale})" fill="${outline ? "#ffffff" : "#111111"}"><path transform="translate(-75 -39.5966)" d="${path}"/></g></svg>`;
  };
  const color = await sharp(Buffer.from(icon(192, 120, false)))
    .png()
    .toBuffer();
  const outline = await sharp(Buffer.from(icon(32, 32, true)))
    .png()
    .toBuffer();
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await Promise.all([
    writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(resolve(directory, "color.png"), color),
    writeFile(resolve(directory, "outline.png"), outline),
  ]);
  return manifest;
}

if (import.meta.main) {
  const options = teamsManifestOptionsFromEnv(process.env);
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stdout.write(`${JSON.stringify(buildTeamsAppManifest(options), null, 2)}\n`);
  } else if (args.length === 2 && args[0] === "--package-dir" && args[1]) {
    await writeTeamsAppPackage(options, resolve(args[1]));
    process.stdout.write(
      "Created manifest.json, color.png and outline.png. Validate in Teams Developer Portal before upload.\n",
    );
  } else {
    throw new Error(
      "Usage: bun scripts/generate-teams-app-manifest.ts [--package-dir NEW_DIRECTORY]",
    );
  }
}
