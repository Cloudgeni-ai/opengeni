import { normalizeWorkspaceAppSlug } from "@opengeni/contracts/apps";

export const OG_APP_SOURCE_MANIFEST_PATH = "og-app.json" as const;
export const OG_APP_SOURCE_MANIFEST_VERSION = "opengeni.app-source.v1" as const;

export type OgAppSourceManifest = {
  version: typeof OG_APP_SOURCE_MANIFEST_VERSION;
  name: string;
  slug: string;
  appVersion: string;
  entryPath: string;
  description?: string;
};

const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePortableAppPath(value: string): string {
  if (typeof value !== "string") throw new TypeError("App paths must be strings.");
  const normalized = value.normalize("NFC");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    normalized !== value ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    /^[A-Za-z]:/u.test(normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(
      `Unsafe app path ${JSON.stringify(value)}; use a normalized relative POSIX file path.`,
    );
  }
  return normalized;
}

export function parseOgAppSourceManifest(value: unknown): OgAppSourceManifest {
  if (!isRecord(value)) throw new Error("og-app.json must contain a JSON object.");
  const allowed = new Set(["version", "name", "slug", "appVersion", "entryPath", "description"]);
  const unknownFields = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownFields.length > 0) {
    throw new Error(`og-app.json contains unknown fields: ${unknownFields.sort().join(", ")}.`);
  }
  if (value.version !== OG_APP_SOURCE_MANIFEST_VERSION) {
    throw new Error(`og-app.json version must be ${OG_APP_SOURCE_MANIFEST_VERSION}.`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.length > 120) {
    throw new Error("og-app.json name must be 1-120 characters.");
  }
  const normalizedSlug =
    typeof value.slug === "string" ? normalizeWorkspaceAppSlug(value.slug) : "";
  if (!normalizedSlug || normalizedSlug !== value.slug) {
    throw new Error("og-app.json slug must be a normalized lowercase workspace app slug.");
  }
  if (typeof value.appVersion !== "string" || !APP_VERSION_PATTERN.test(value.appVersion)) {
    throw new Error("og-app.json appVersion must be a semantic version such as 1.0.0.");
  }
  const entryPath = normalizePortableAppPath(
    typeof value.entryPath === "string" ? value.entryPath : "",
  );
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" || value.description.length > 2_000)
  ) {
    throw new Error("og-app.json description must be at most 2,000 characters.");
  }
  return {
    version: OG_APP_SOURCE_MANIFEST_VERSION,
    name: value.name.trim(),
    slug: normalizedSlug,
    appVersion: value.appVersion,
    entryPath,
    ...(value.description === undefined ? {} : { description: value.description }),
  };
}

export function encodeOgAppSourceManifest(manifest: OgAppSourceManifest): Uint8Array {
  const parsed = parseOgAppSourceManifest(manifest);
  return new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}\n`);
}

export function createOgAppSourceManifest(input: {
  name: string;
  slug?: string;
  appVersion?: string;
  entryPath?: string;
  description?: string;
}): OgAppSourceManifest {
  const slug = input.slug ?? normalizeWorkspaceAppSlug(input.name);
  return parseOgAppSourceManifest({
    version: OG_APP_SOURCE_MANIFEST_VERSION,
    name: input.name,
    slug,
    appVersion: input.appVersion ?? "1.0.0",
    entryPath: input.entryPath ?? "index.html",
    ...(input.description === undefined ? {} : { description: input.description }),
  });
}
