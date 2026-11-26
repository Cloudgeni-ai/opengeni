import type { SiteBridgeToolHandlers, SiteHttpRequest } from "@opengeni/sdk/site-bridge-host";

/**
 * Site Data for a ready-made app's preview (docs/app-packages.md "Preview"):
 * the template's sample records, read-only and in memory. Reads list, count
 * and get them; every write is refused, so nothing a preview does is saved.
 */
type Sample = Record<string, ReadonlyArray<Record<string, unknown>>>;

const PREFIX = "/v1/workspaces/site-host/published-artifacts/current";
const PREVIEW_ONLY = "This is a preview. Install the app to add your own.";

type PreviewRecord = {
  id: string;
  key: null;
  data: Record<string, unknown>;
  owner: string;
  createdBy: string;
  updatedBy: string;
  version: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

function day(offset: number, now: Date): string {
  return new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

function resolveValue(value: unknown, now: Date): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{today(?:-(\d{1,3}))?\}\}/g, (_, offset?: string) =>
    day(Number(offset ?? 0), now),
  );
}

/** The sample as Site Data records, newest first in the order given. */
export function previewRecords(sample: Sample, now = new Date()): Map<string, PreviewRecord[]> {
  const out = new Map<string, PreviewRecord[]>();
  for (const [collection, rows] of Object.entries(sample)) {
    out.set(
      collection,
      rows.map((row, index) => {
        const at = new Date(now.getTime() - (index + 1) * 3_600_000).toISOString();
        return {
          id: `preview-${collection}-${index + 1}`,
          key: null,
          data: Object.fromEntries(
            Object.entries(row).map(([field, value]) => [field, resolveValue(value, now)]),
          ),
          owner: "user:preview",
          createdBy: "user:preview",
          updatedBy: "user:preview",
          version: 1,
          sizeBytes: 0,
          createdAt: at,
          updatedAt: at,
        };
      }),
    );
  }
  return out;
}

function fieldValue(record: PreviewRecord, field: string): unknown {
  if (field === "$createdAt" || field === "$updatedAt") return record.createdAt;
  if (field === "$id") return record.id;
  return record.data[field];
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(request: SiteHttpRequest): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(typeof request.body === "string" ? request.body : "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A Site HTTP handler serving the sample read-only (`toolBridge.fetch`). */
export function templatePreviewFetch(
  sample: Sample,
  now = new Date(),
): (request: SiteHttpRequest) => Promise<Response> {
  const records = previewRecords(sample, now);
  return async (request) => {
    const path = request.path.startsWith(PREFIX) ? request.path.slice(PREFIX.length) : "";
    const input = requestBody(request);
    const list = records.get(String(input.collection ?? "")) ?? [];
    if (path === "/data/query") {
      // Nothing in a preview is the viewer's own.
      let found = input.scope === "own" ? [] : [...list];
      const sort = Array.isArray(input.sort) ? (input.sort as Array<Record<string, unknown>>) : [];
      if (sort.length > 0)
        found.sort((a, b) => {
          for (const { field, direction } of sort) {
            const order = compare(fieldValue(a, String(field)), fieldValue(b, String(field)));
            if (order !== 0) return direction === "desc" ? -order : order;
          }
          return 0;
        });
      const limit = typeof input.limit === "number" ? input.limit : 50;
      const count = found.length;
      found = found.slice(0, Math.max(1, Math.min(200, limit)));
      return json(200, {
        records: found,
        // A sample is a handful of records: one page, no cursor.
        nextCursor: null,
        ...(input.count ? { count } : {}),
      });
    }
    if (path === "/data/get") {
      const record = list.find((each) => each.id === input.id);
      return record
        ? json(200, { record })
        : json(404, { error: { message: "Not found", details: { code: "not_found" } } });
    }
    if (path === "/data/syncs") return json(200, { syncs: [] });
    return json(403, { error: { message: PREVIEW_ONLY } });
  };
}

/** The preview's bridge: the sample as Site Data, and no tools. */
export function templatePreviewBridge(sample: Sample): SiteBridgeToolHandlers {
  const refuse = async (): Promise<never> => {
    throw new Error(PREVIEW_ONLY);
  };
  return { siteData: true, fetch: templatePreviewFetch(sample), catalog: refuse, call: refuse };
}
