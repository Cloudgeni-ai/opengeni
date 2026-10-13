/**
 * Site Data access rules (OPE-800), kept pure so every backend enforces the
 * same matrix. A manager may manage the Site (its owner, a workspace admin, or
 * an agent acting for them); everyone else who can see the Site is a viewer.
 */

export const SITE_DATA_ACCESS_MODES = ["shared", "shared_read", "per_viewer", "append_only"] as const;
export type SiteDataAccessMode = (typeof SITE_DATA_ACCESS_MODES)[number];
export type SiteDataRole = "manager" | "viewer";
export type SiteDataReach = "all" | "own" | "none";

export type SiteDataModeRules = {
  accessMode: SiteDataAccessMode;
  privateRecords: boolean;
};

/** Which records a caller may read. */
export function siteDataReadReach(rules: SiteDataModeRules, role: SiteDataRole): SiteDataReach {
  switch (rules.accessMode) {
    case "shared":
    case "shared_read":
      return "all";
    case "per_viewer":
      return role === "manager" && !rules.privateRecords ? "all" : "own";
    case "append_only":
      return role === "manager" ? "all" : "own";
  }
}

/** Whether a caller may create records. */
export function siteDataMayCreate(rules: SiteDataModeRules, role: SiteDataRole): boolean {
  return rules.accessMode !== "shared_read" || role === "manager";
}

/** Which records a caller may update or delete. */
export function siteDataModifyReach(rules: SiteDataModeRules, role: SiteDataRole): SiteDataReach {
  switch (rules.accessMode) {
    case "shared":
      return "all";
    case "shared_read":
      return role === "manager" ? "all" : "none";
    case "per_viewer":
      return role === "manager" && !rules.privateRecords ? "all" : "own";
    case "append_only":
      return role === "manager" ? "all" : "none";
  }
}

/** Per-viewer collections give each viewer their own key and unique-value space. */
export function siteDataScopedPerViewer(mode: SiteDataAccessMode): boolean {
  return mode === "per_viewer" || mode === "append_only";
}

export const SITE_DATA_COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
export const SITE_DATA_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/u;
export const SITE_DATA_MAX_PATH_DEPTH = 4;
export const SITE_DATA_MAX_PAGE = 200;
export const SITE_DATA_DEFAULT_PAGE = 50;
export const SITE_DATA_MAX_BATCH = 100;
export const SITE_DATA_MAX_SORT_KEYS = 2;
export const SITE_DATA_MAX_FILTERS = 20;
export const SITE_DATA_MAX_IN_VALUES = 100;
export const SITE_DATA_MAX_INDEXED_FIELDS = 10;
export const SITE_DATA_MAX_UNIQUE_SETS = 5;
export const SITE_DATA_MAX_UNIQUE_SET_FIELDS = 4;
export const SITE_DATA_MAX_KEY_LENGTH = 256;
export const SITE_DATA_MAX_JSON_SCHEMA_BYTES = 64 * 1024;

/** A dotted data path with a small depth cap, or null when invalid. */
export function parseSiteDataPath(path: string): string[] | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 300) return null;
  const segments = path.split(".");
  if (segments.length > SITE_DATA_MAX_PATH_DEPTH) return null;
  return segments.every((segment) => SITE_DATA_PATH_SEGMENT.test(segment)) ? segments : null;
}

/** Read a dotted path from a JSON object; undefined when absent. */
export function readSiteDataPath(data: unknown, segments: readonly string[]): unknown {
  let current: unknown = data;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Return a copy with a dotted path set, creating intermediate objects. */
export function writeSiteDataPath(
  data: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const root: Record<string, unknown> = { ...data };
  let current = root;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const next = current[segment];
    const copy =
      typeof next === "object" && next !== null && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    current[segment] = copy;
    current = copy;
  });
  return root;
}

/** Deterministic JSON (sorted object keys) for unique-value hashing. */
export function canonicalSiteDataJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSiteDataJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSiteDataJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
