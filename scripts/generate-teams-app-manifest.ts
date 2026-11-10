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
  /** Teams' display name (`name.short`), shown in chat. */
  appName?: string;
  /**
   * The full app name (`name.full`), for example the Store listing name.
   * Defaults to `appName`.
   */
  appFullName?: string | undefined;
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
  /** The publisher name shown in Teams; it must match the Partner Center publisher. */
  developerName?: string | undefined;
  /**
   * Microsoft AI Cloud Partner Program ID (formerly MPN ID) of the publisher.
   * Undefined uses Opengeni's; null leaves it out.
   */
  mpnId?: string | null | undefined;
};

/** Opengeni's publisher name and Microsoft partner ID, the package defaults. */
const DEFAULT_DEVELOPER_NAME = "Opengeni";
const DEFAULT_MPN_ID = "7181379";

/**
 * Personal-scope commands: account and help commands, then a few prompt
 * starters. The app name is the bot; "Opengeni" is the service and accounts.
 */
const personalCommands = (appName: string) => [
  { title: "help", description: `See what ${appName} can do, its commands and its limits` },
  { title: "link", description: "Link your Teams account to your Opengeni account" },
  { title: "unlink", description: "Disconnect your Teams account from Opengeni" },
  {
    title: "Research a topic",
    description: `Ask ${appName} to research something and report back`,
  },
  { title: "Draft a message", description: `Ask ${appName} to write or improve a message` },
  { title: "Plan a project", description: `Ask ${appName} to break work into steps` },
];

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
  // Trimmed, as the API trims the same OPENGENI_TEAMS_APP_NAME for the bot.
  const appName = (options.appName ?? "Opengeni").trim();
  if (!appName.trim() || appName.length > 30)
    throw new Error("appName must contain 1–30 characters");
  // An explicit full name is trimmed; the default is the short name unchanged.
  const appFullName = options.appFullName?.trim() ?? appName;
  if (!appFullName.trim() || appFullName.length > 100)
    throw new Error("appFullName must contain 1–100 characters");
  const version = options.version ?? "1.0.0";
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("version must be three numeric components");
  }
  const publicUrl = httpsUrl(options.publicBaseUrl, "publicBaseUrl");
  if (publicUrl.pathname !== "/") throw new Error("publicBaseUrl must be an origin");
  const websiteUrl = httpsUrl(options.websiteUrl, "websiteUrl").href;
  const developerName = (options.developerName ?? DEFAULT_DEVELOPER_NAME).trim();
  if (!developerName || developerName.length > 32)
    throw new Error("developerName must contain 1–32 characters");
  const mpnId = options.mpnId === undefined ? DEFAULT_MPN_ID : options.mpnId;
  if (mpnId !== null && !/^\d{1,10}$/.test(mpnId))
    throw new Error("mpnId must be a numeric Microsoft partner ID");
  const botId = guid(options.botId, "botId");
  const sharedScopes = [
    ...(options.channels ? ["team"] : []),
    ...(options.groupChats ? ["groupChat"] : []),
  ];
  if (options.conversationContext && sharedScopes.length === 0)
    throw new Error("conversationContext needs channels or groupChats");
  const contextPermissions = options.conversationContext
    ? [
        ...(options.channels ? [{ name: "ChannelMessage.Read.Group", type: "Application" }] : []),
        ...(options.groupChats ? [{ name: "ChatMessage.Read.Chat", type: "Application" }] : []),
      ]
    : [];
  // Where Opengeni answers a mention: "a channel", "a group chat" or both.
  const shared =
    options.channels && options.groupChats
      ? "a channel or group chat"
      : options.channels
        ? "a channel"
        : options.groupChats
          ? "a group chat"
          : null;
  const description = {
    // One sentence that says what it is, without the app name or the word "app".
    short: "An AI agent for Microsoft Teams that researches, writes and plans work.",
    // The app name is the bot; "Opengeni" is the service, accounts and workspace.
    full: [
      `${appName} is an AI agent that works with Microsoft Teams.`,
      shared
        ? `Chat with ${appName} one-on-one, or mention ${appName} in ${shared} where it is enabled for your organization, to ask questions, research topics, draft and improve writing, plan work and use the tools your organization has connected to Opengeni.`
        : `Chat with ${appName} one-on-one to ask questions, research topics, draft and improve writing, plan work and use the tools your organization has connected to Opengeni.`,
      shared
        ? `${appName} replies in the same conversation when a task is done. Send "help" (in ${shared}, mention ${appName} with it) to see its commands.`
        : `${appName} replies in the same conversation when a task is done. Send "help" at any time to see its commands.`,
      `Requirements: an administrator must first connect your organization's Microsoft Teams to an Opengeni workspace, and you need an Opengeni account with access to that workspace. Visit ${websiteUrl.replace(/\/$/, "")} to sign up or get access. The first time you message ${appName}, it asks you to link your Teams account to your Opengeni account.`,
      ...(options.groupChats
        ? [
            "In a group chat, every participant must have linked an Opengeni account with access to that workspace.",
          ]
        : []),
      ...(contextPermissions.length
        ? [
            `In ${shared}, ${appName} also reads recent messages, only to answer the next mention there.`,
          ]
        : []),
      `Limitations: replies are generated by AI and can be wrong, so check important details. ${appName} reads text messages only; files and images sent in Teams aren't supported. Approvals and requests for private information open Opengeni in your web browser. Use thumbs down on a reply to report a problem.`,
    ].join(" "),
  };
  const commandLists = [
    { scopes: ["personal"], commands: personalCommands(appName) },
    ...(sharedScopes.length
      ? [
          {
            scopes: sharedScopes,
            commands: [
              { title: "help", description: `See what ${appName} can do in this conversation` },
            ],
          },
        ]
      : []),
  ];
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
      name: developerName,
      ...(mpnId === null ? {} : { mpnId }),
      websiteUrl,
      privacyUrl: httpsUrl(options.privacyUrl, "privacyUrl").href,
      termsOfUseUrl: httpsUrl(options.termsOfUseUrl, "termsOfUseUrl").href,
    },
    name: { short: appName, full: appFullName },
    description,
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#111111",
    bots: [
      {
        botId,
        scopes: ["personal", ...sharedScopes],
        isNotificationOnly: false,
        supportsFiles: false,
        commandLists,
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
    // Unset or empty uses the short name.
    appFullName: env.OPENGENI_TEAMS_APP_FULL_NAME?.trim() || undefined,
    developerName: env.OPENGENI_TEAMS_DEVELOPER_NAME?.trim() || undefined,
    // Unset or empty uses Opengeni's partner ID; only "none" leaves it out.
    mpnId: (() => {
      const value = env.OPENGENI_TEAMS_MPN_ID?.trim();
      if (!value) return undefined;
      return value.toLowerCase() === "none" ? null : value;
    })(),
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
