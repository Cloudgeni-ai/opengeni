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
  return {
    $schema: "https://developer.microsoft.com/json-schemas/teams/v1.25/MicrosoftTeams.schema.json",
    manifestVersion: "1.25",
    version,
    id: guid(options.appId, "appId"),
    developer: {
      name: "Cloudgeni",
      websiteUrl: httpsUrl(options.websiteUrl, "websiteUrl").href,
      privacyUrl: httpsUrl(options.privacyUrl, "privacyUrl").href,
      termsOfUseUrl: httpsUrl(options.termsOfUseUrl, "termsOfUseUrl").href,
    },
    name: { short: appName, full: appName },
    description: {
      short: "Work with Opengeni agents in Teams.",
      full: "Ask Opengeni agents for help in a personal chat or mention Opengeni in a connected team channel. An Opengeni administrator must connect the Teams conversation to an authorized workspace before agent work can begin.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#111111",
    bots: [
      {
        botId: guid(options.botId, "botId"),
        scopes: ["personal", "team"],
        isNotificationOnly: false,
        supportsFiles: false,
      },
    ],
    validDomains: [publicUrl.hostname],
    // No Graph, RSC, tabs, SSO, group chat, or private/shared-channel claim.
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
  return {
    appId: required("OPENGENI_TEAMS_APP_ID"),
    botId: required("OPENGENI_TEAMS_BOT_CLIENT_ID"),
    publicBaseUrl: required("OPENGENI_PUBLIC_BASE_URL"),
    websiteUrl: required("OPENGENI_TEAMS_WEBSITE_URL"),
    privacyUrl: required("OPENGENI_TEAMS_PRIVACY_URL"),
    termsOfUseUrl: required("OPENGENI_TEAMS_TERMS_URL"),
    version: env.OPENGENI_TEAMS_APP_VERSION,
    appName: env.OPENGENI_TEAMS_APP_NAME,
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
