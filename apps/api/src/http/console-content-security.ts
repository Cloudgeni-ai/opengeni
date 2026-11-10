import { configuredModels, sandboxBackendServed, type Settings } from "@opengeni/config";
import { sitesHtmlFrameHostOrigin } from "@opengeni/contracts/html-frame-host";
import { normalizeSitesDomain } from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";

/**
 * The console's Content-Security-Policy is built by the web server
 * (apps/web/src/csp.ts), but most of the external origins the console talks
 * to are API configuration the web server cannot see: the object storage
 * account behind signed upload and download URLs, the relay and sandbox
 * tunnels behind terminal and desktop sockets, analytics, sign-in avatars,
 * model logos and the Sites frame host. This route publishes exactly those
 * origins (they are public: they appear in the policy header anyway), and
 * the web server merges them into its policy. Nothing here is a scheme-only
 * source or `*`.
 */
export const CONSOLE_CONTENT_SECURITY_PATH = "/v1/config/content-security";
/** The image proxy for images from origins the policy does not list. */
export const IMAGE_PROXY_PATH = "/v1/image-proxy";

export type ConsoleContentSecurityDirective =
  | "connect-src"
  | "img-src"
  | "media-src"
  | "script-src"
  | "frame-src"
  | "form-action";

export type ConsoleContentSecuritySources = {
  version: 1;
  /** Extra sources per directive, on top of the web server's own base policy. */
  directives: Record<ConsoleContentSecurityDirective, string[]>;
  /** Origin of the HTML frame host on the Sites domain; null without one. */
  htmlFrameHost: string | null;
  /** Root-relative path of the API's image proxy. */
  imageProxyPath: string;
};

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
/** Profile pictures of people who sign in with Google or GitHub. */
const GOOGLE_AVATAR_ORIGIN = "https://lh3.googleusercontent.com";
const GITHUB_AVATAR_ORIGIN = "https://avatars.githubusercontent.com";
const GITHUB_ORIGIN = "https://github.com";
/**
 * Modal sandbox tunnels (terminal and desktop sockets). Each sandbox gets its
 * own generated host under this domain, so only a host wildcard can name them.
 */
const MODAL_TUNNEL_HOSTS = ["https://*.modal.host", "wss://*.modal.host"];

type Sources = Record<ConsoleContentSecurityDirective, Set<string>>;

export type ConsoleContentSecurityInput = {
  settings: Settings;
  /** The deployment model catalog (resolved from the database when configured). */
  catalogSettings?: Settings;
  objectStorage: Pick<ObjectStorage, "createGetUrl"> | null;
};

export async function consoleContentSecuritySources(
  input: ConsoleContentSecurityInput,
): Promise<ConsoleContentSecuritySources> {
  const { settings } = input;
  const sources: Sources = {
    "connect-src": new Set(),
    "img-src": new Set(),
    "media-src": new Set(),
    "script-src": new Set(),
    "frame-src": new Set(),
    "form-action": new Set(),
  };
  const add = (directives: ConsoleContentSecurityDirective[], ...values: (string | null)[]) => {
    for (const directive of directives)
      for (const value of values) if (value) sources[directive].add(value);
  };

  // The API itself, when the console is served from another origin.
  const apiOrigin = httpsOrHttpOrigin(settings.publicBaseUrl);
  const webOrigin = httpsOrHttpOrigin(settings.webBaseUrl);
  if (apiOrigin && webOrigin && apiOrigin !== webOrigin) {
    add(["connect-src", "img-src", "media-src"], apiOrigin);
    add(["connect-src"], webSocketOrigin(apiOrigin));
  }

  // Object storage: signed upload and download URLs point at the storage
  // account. Signing a URL is local, so the origin is exactly what the
  // browser will be handed, whatever the provider and endpoint settings.
  for (const origin of await objectStorageBrowserOrigins(input.objectStorage)) {
    add(["connect-src", "img-src", "media-src"], origin);
  }

  // Terminal, desktop and port sockets.
  const relay = httpsOrHttpOrigin(settings.selfhostedRelayUrl, ["https:", "http:", "wss:", "ws:"]);
  if (relay) add(["connect-src"], httpOriginOf(relay), webSocketOrigin(relay));
  // Any served backend counts, not only the default: a session may pick one.
  if (sandboxBackendServed(settings, "modal")) add(["connect-src"], ...MODAL_TUNNEL_HOSTS);

  // Sign-up challenge (Cloudflare Turnstile): its script and its frame.
  if (settings.signupChallengeEnabled && settings.signupChallengeSiteKey) {
    add(["script-src", "frame-src"], TURNSTILE_ORIGIN);
  }

  // Analytics, only when configured (and then only after consent).
  if (settings.analyticsEnabled) {
    const posthog = settings.analyticsPosthogProjectKey
      ? httpsOrHttpOrigin(settings.analyticsPosthogHost)
      : null;
    if (posthog) {
      const assets = posthogAssetOrigin(posthog);
      add(["connect-src"], posthog, assets);
      add(["script-src"], assets);
    }
    if (settings.analyticsReoClientId) {
      // The hosts Reo documents for a site with a Content-Security-Policy.
      add(["script-src"], "https://static.reo.dev");
      add(["connect-src"], "https://api.reo.dev");
    }
    if (settings.analyticsGa4MeasurementId) {
      // Google Analytics collects on regional subdomains it chooses per
      // visitor; Google's own CSP guidance lists them as host wildcards.
      add(["script-src"], "https://www.googletagmanager.com");
      add(
        ["connect-src", "img-src"],
        "https://*.google-analytics.com",
        "https://*.analytics.google.com",
        "https://*.googletagmanager.com",
      );
    }
  }

  // Profile pictures from the social sign-in providers.
  if (settings.managedAuthGoogleClientId) add(["img-src"], GOOGLE_AVATAR_ORIGIN);
  if (settings.managedAuthGithubClientId) add(["img-src"], GITHUB_AVATAR_ORIGIN);

  // Maker logos named by the deployment model catalog. Workspace custom
  // models with their own logos go through the image proxy instead.
  try {
    for (const model of configuredModels(input.catalogSettings ?? settings)) {
      const origin = model.logoUrl ? httpsOrHttpOrigin(model.logoUrl, ["https:"]) : null;
      if (origin) add(["img-src"], origin);
    }
  } catch {
    // An invalid catalog fails elsewhere; logos then go through the proxy.
  }

  // Self-hosted operators create their GitHub App by posting its manifest
  // form to GitHub (submitGitHubManifest in @opengeni/react); platform-managed
  // deployments do not offer that flow.
  if (settings.productAccessMode !== "managed") add(["form-action"], GITHUB_ORIGIN);

  const sitesDomain = configuredSitesDomain(settings);
  const htmlFrameHost = sitesDomain ? sitesHtmlFrameHostOrigin(sitesDomain) : null;
  if (htmlFrameHost) add(["frame-src"], htmlFrameHost);

  return {
    version: 1,
    directives: {
      "connect-src": [...sources["connect-src"]].sort(),
      "img-src": [...sources["img-src"]].sort(),
      "media-src": [...sources["media-src"]].sort(),
      "script-src": [...sources["script-src"]].sort(),
      "frame-src": [...sources["frame-src"]].sort(),
      "form-action": [...sources["form-action"]].sort(),
    },
    htmlFrameHost,
    imageProxyPath: IMAGE_PROXY_PATH,
  };
}

/** A Sites domain served over HTTPS; local `*.localhost` development keeps the same-origin host. */
function configuredSitesDomain(settings: Settings): string | null {
  if (!settings.sitesDomain) return null;
  try {
    const domain = normalizeSitesDomain(settings.sitesDomain);
    return domain === "localhost" || domain.endsWith(".localhost") ? null : domain;
  } catch {
    return null;
  }
}

const STORAGE_PROBE_KEY = "opengeni-content-security-probe";

async function objectStorageBrowserOrigins(
  storage: Pick<ObjectStorage, "createGetUrl"> | null,
): Promise<string[]> {
  if (!storage) return [];
  try {
    const { url } = await storage.createGetUrl({ key: STORAGE_PROBE_KEY, audience: "public" });
    const origin = httpsOrHttpOrigin(url);
    return origin ? [origin] : [];
  } catch {
    return [];
  }
}

function httpsOrHttpOrigin(
  value: string | undefined | null,
  protocols: readonly string[] = ["https:", "http:"],
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !url.host) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function httpOriginOf(origin: string): string {
  return origin.replace(/^ws(s?):/u, "http$1:");
}

function webSocketOrigin(origin: string): string {
  return origin.replace(/^http(s?):/u, "ws$1:");
}

/** PostHog Cloud serves its scripts from `<region>-assets.i.posthog.com`; a proxy serves both. */
function posthogAssetOrigin(apiOrigin: string): string {
  const url = new URL(apiOrigin);
  const match = /^([a-z0-9-]+)\.i\.posthog\.com$/u.exec(url.hostname);
  return match ? `${url.protocol}//${match[1]}-assets.i.posthog.com` : apiOrigin;
}
