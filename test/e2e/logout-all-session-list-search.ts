import { SESSION_GROUP_VISIBLE_STEP } from "../../apps/web/src/lib/session-group-window";

type ReadShape = Readonly<{
  /** Every key the read must carry, with its admissible values. */
  required: Readonly<Record<string, readonly string[]>>;
  /** Keys the read may carry, with their admissible values. */
  optional?: Readonly<Record<string, readonly string[]>>;
}>;

const SUMMARY = { projection: ["summary"] } as const;
// Project-grouped windows read one display step; ungrouped roots read 50.
const ROOT_LIMITS = [String(SESSION_GROUP_VISIBLE_STEP), "50"] as const;
const ACTIVE_ROOTS = {
  view: ["page"],
  parentSessionId: ["null"],
  sortBy: ["updatedAt"],
  archiveStatus: ["active"],
} as const;

/**
 * The first-page rail reads that may be in flight when logout-all is accepted.
 * Each shape is exact: no other key, no repeated key, and only the listed
 * values. Cursor and search reads are user-driven and never match.
 */
const LOGOUT_ALL_SESSION_LIST_READS: readonly ReadShape[] = [
  // Pre-page rail reads, kept for a rolling upgrade.
  { required: { view: ["page"], limit: ["50"], parentSessionId: ["null"] }, optional: SUMMARY },
  {
    required: { view: ["page"], limit: ["50"], parentSessionId: ["null"], archivedOnly: ["true"] },
    optional: SUMMARY,
  },
  { required: { view: ["page"], limit: ["50"], ...ACTIVE_ROOTS }, optional: SUMMARY },
  {
    required: { view: ["page"], limit: ["50"], ...ACTIVE_ROOTS, channelId: ["null"] },
    optional: SUMMARY,
  },
  // The global pin shortcut section.
  { required: { view: ["page"], limit: ["1"], pinsOnly: ["true"] }, optional: SUMMARY },
  // The current rail root page: totals for the hierarchy, pins read separately.
  {
    required: { ...ACTIVE_ROOTS, ...SUMMARY, limit: ROOT_LIMITS },
    optional: { includeTotals: ["true"], includePinned: ["false"] },
  },
  // The current Default project window.
  {
    required: {
      ...ACTIVE_ROOTS,
      ...SUMMARY,
      limit: ROOT_LIMITS,
      channelId: ["null"],
      includePinned: ["false"],
    },
  },
];

/** Only the finite rail reads that may straddle an accepted logout-all. */
export function exactLogoutAllSessionListSearch(search: string): boolean {
  if (search === "") return true; // Pre-page API during a rolling upgrade.
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return false;
  return LOGOUT_ALL_SESSION_LIST_READS.some((shape) => matchesShape(params, keys, shape));
}

function matchesShape(params: URLSearchParams, keys: readonly string[], shape: ReadShape): boolean {
  const optional = shape.optional ?? {};
  for (const [key, values] of Object.entries(shape.required)) {
    if (!values.includes(params.get(key) ?? "\u0000")) return false;
  }
  return keys.every((key) => {
    if (Object.hasOwn(shape.required, key)) return true;
    if (!Object.hasOwn(optional, key)) return false;
    const values = optional[key];
    return values !== undefined && values.includes(params.get(key)!);
  });
}
