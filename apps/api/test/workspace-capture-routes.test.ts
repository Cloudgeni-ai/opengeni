import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceCaptureRow } from "@opengeni/db";
import type { WorkspaceCaptureManifest } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import {
  CAPTURE_INLINE_FILE_MAX_BYTES,
  CAPTURE_INLINE_MANIFEST_MAX_BYTES,
  serveWorkspaceCapture,
  serveWorkspaceCaptureFile,
  type CaptureStoragePort,
} from "../src/routes/workspace-capture";

// M2 capture-read routes (dossier §10.3). Two layers of coverage, both hermetic:
//
//   (1) ROUTE DISCIPLINE (static): grant-first (files:read) BEFORE any query read
//       or DB call — the same auth-before-anything invariant the channel-a and
//       viewer route tests assert by source inspection (a real 403 needs a live
//       DB; requireAccessGrant's deny path is already covered by its own tests —
//       here we prove ORDERING). Also: served from DB + storage, never a box.
//   (2) RESPONSE SHAPING (behavioral): the pure serve functions the handlers
//       delegate to, driven with an in-memory storage + fabricated rows — every
//       branch ({available:false}, inline vs signed, file resolve / marker / 404).

const here = dirname(fileURLToPath(import.meta.url));
const sessionsRoute = readFileSync(resolve(here, "..", "src", "routes", "sessions.ts"), "utf8");

function handlerBody(source: string, method: string, path: string): string {
  const needle = `app.${method}("${path}"`;
  const start = source.indexOf(needle);
  expect(start, `route not found: ${method.toUpperCase()} ${path}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced handler braces for ${method} ${path}`);
}

const CAPTURE_ROUTE = "/v1/workspaces/:workspaceId/sessions/:sessionId/workspace/capture";
const FILE_ROUTE = "/v1/workspaces/:workspaceId/sessions/:sessionId/workspace/capture/file";

describe("M2 capture-read route discipline (static)", () => {
  test("both routes are registered as GET", () => {
    expect(sessionsRoute.includes(`app.get("${CAPTURE_ROUTE}"`)).toBe(true);
    expect(sessionsRoute.includes(`app.get("${FILE_ROUTE}"`)).toBe(true);
  });

  for (const path of [CAPTURE_ROUTE, FILE_ROUTE]) {
    test(`${path}: requireAccessGrant(files:read) precedes any query/DB read`, () => {
      const body = handlerBody(sessionsRoute, "get", path);
      const grantAt = body.indexOf("requireAccessGrant");
      expect(grantAt, "handler must call requireAccessGrant").toBeGreaterThanOrEqual(0);
      expect(body).toContain('"files:read"');
      // No query read or capture load precedes the grant (auth-before-anything).
      for (const needle of ["c.req.query", "latestWorkspaceCapture", "workspaceCaptureAtRevision", "getSession("]) {
        const at = body.indexOf(needle);
        if (at >= 0) expect(at, `${needle} must not precede the grant`).toBeGreaterThan(grantAt);
      }
    });
  }

  test("capture reads never resume a box (no channelAPreamble / withChannelA)", () => {
    const body = handlerBody(sessionsRoute, "get", CAPTURE_ROUTE);
    expect(body).not.toContain("channelAPreamble");
    expect(body).not.toContain("withChannelA");
    // Served from the DB helper + object storage.
    expect(body).toContain("latestWorkspaceCapture");
    expect(body).toContain("serveWorkspaceCapture");
  });

  test("the file route requires ?path and validates ?revision", () => {
    const body = handlerBody(sessionsRoute, "get", FILE_ROUTE);
    expect(body).toContain("path query parameter is required");
    expect(body).toContain("HTTPException(400");
    expect(body).toContain("workspaceCaptureAtRevision");
  });

  test("missing session is a 404 on both routes", () => {
    for (const path of [CAPTURE_ROUTE, FILE_ROUTE]) {
      const body = handlerBody(sessionsRoute, "get", path);
      expect(body).toContain("session not found");
      expect(body).toContain("HTTPException(404");
    }
  });
});

// ── behavioral fixtures ──────────────────────────────────────────────────────

const MANIFEST_KEY = "workspace-captures/ws/sess/manifests/turn-1.json";
const TEXT_REF = "workspace-captures/ws/sess/blobs/aaa";
const BIN_REF = "workspace-captures/ws/sess/blobs/bbb";
const BIG_REF = "workspace-captures/ws/sess/blobs/ccc";

function baseStats(): WorkspaceCaptureManifest["stats"] {
  return {
    repoCount: 1, fileCount: 1, additions: 1, deletions: 0, totalBytes: 12,
    tooLargeCount: 0, binaryCount: 0, treeEntryCount: 1, treeTruncated: false,
    durationMs: 42, fingerprint: "fp-1",
  };
}

function makeManifest(files: WorkspaceCaptureManifest["files"]): WorkspaceCaptureManifest {
  return {
    version: 1,
    revision: 3,
    capturedAt: "2026-07-08T00:00:00.000Z",
    turnId: "turn-1",
    leaseEpoch: 5,
    treeIndex: { name: "", path: "", type: "dir", sizeBytes: null, mtimeMs: null, mode: null, truncated: false },
    treeTruncated: false,
    repos: [],
    files,
    stats: baseStats(),
  };
}

function makeRow(overrides: Partial<WorkspaceCaptureRow> = {}): WorkspaceCaptureRow {
  return {
    id: "row-1",
    sessionId: "sess",
    turnId: "turn-1",
    revision: 3,
    leaseEpoch: 5,
    state: "available",
    manifestKey: MANIFEST_KEY,
    treeIndexKey: "workspace-captures/ws/sess/trees/turn-1.json",
    blobKeys: [TEXT_REF],
    sizeBytes: 12,
    stats: baseStats() as unknown as Record<string, unknown>,
    capturedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

// In-memory storage: byte map for reads, a stub signer that records the key.
function fakeStorage(objects: Record<string, Uint8Array>): CaptureStoragePort & { signed: string[] } {
  const signed: string[] = [];
  return {
    signed,
    async getObjectBytes(key) {
      const bytes = objects[key];
      return bytes ? { bytes } : null;
    },
    async createGetUrl({ key }) {
      signed.push(key);
      return { url: `https://signed.example/${key}`, expiresAt: new Date("2026-07-08T00:05:00.000Z") };
    },
  };
}

function fileEntry(over: Partial<WorkspaceCaptureManifest["files"][number]>): WorkspaceCaptureManifest["files"][number] {
  return {
    path: "src/app.ts", status: "modified", hash: "aaa", baseHash: null,
    contentRef: TEXT_REF, sizeBytes: 12, isBinary: false, tooLarge: false, deleted: false,
    ...over,
  };
}

describe("serveWorkspaceCapture (manifest response)", () => {
  test("no row → {available:false}", async () => {
    const res = await serveWorkspaceCapture(null, fakeStorage({}));
    expect(res).toEqual({ available: false });
  });

  test("row not in the available state → {available:false}", async () => {
    const res = await serveWorkspaceCapture(makeRow({ state: "capturing" }), fakeStorage({}));
    expect(res).toEqual({ available: false });
  });

  test("manifest blob GC'd out from under the row → {available:false}", async () => {
    const res = await serveWorkspaceCapture(makeRow(), fakeStorage({})); // no MANIFEST_KEY
    expect(res).toEqual({ available: false });
  });

  test("small manifest → inline (metadata + manifest, no signed URL)", async () => {
    const manifest = makeManifest([fileEntry({})]);
    const storage = fakeStorage({ [MANIFEST_KEY]: new TextEncoder().encode(JSON.stringify(manifest)) });
    const res = await serveWorkspaceCapture(makeRow(), storage);
    expect(res.available).toBe(true);
    if (!res.available) throw new Error("unreachable");
    expect(res.revision).toBe(3);
    expect(res.leaseEpoch).toBe(5);
    expect(res.turnId).toBe("turn-1");
    expect(res.sizeBytes).toBe(12);
    expect(res.stats.fingerprint).toBe("fp-1");
    expect(res.manifestUrl).toBeNull();
    expect(res.manifest?.files[0]?.path).toBe("src/app.ts");
    expect(storage.signed).toEqual([]); // one round-trip; no second blob hop
  });

  test("manifest above the inline cap → signed URL, manifest omitted", async () => {
    // Bytes bigger than the inline cap; deliberately NOT valid JSON — the large
    // path must mint a URL WITHOUT parsing the blob.
    const big = new Uint8Array(CAPTURE_INLINE_MANIFEST_MAX_BYTES + 1);
    const storage = fakeStorage({ [MANIFEST_KEY]: big });
    const res = await serveWorkspaceCapture(makeRow(), storage);
    expect(res.available).toBe(true);
    if (!res.available) throw new Error("unreachable");
    expect(res.manifest).toBeNull();
    expect(res.manifestUrl?.url).toContain(MANIFEST_KEY);
    expect(res.manifestUrl?.expiresAt).toBe("2026-07-08T00:05:00.000Z");
    expect(storage.signed).toEqual([MANIFEST_KEY]);
  });
});

describe("serveWorkspaceCaptureFile (single after-image)", () => {
  function storageWith(files: WorkspaceCaptureManifest["files"], blobs: Record<string, Uint8Array> = {}) {
    const manifest = makeManifest(files);
    return fakeStorage({ [MANIFEST_KEY]: new TextEncoder().encode(JSON.stringify(manifest)), ...blobs });
  }

  async function expect404(promise: Promise<unknown>): Promise<number> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof HTTPException) return err.status;
      throw err;
    }
    throw new Error("expected an HTTPException, got a resolved value");
  }

  test("no capture row → 404", async () => {
    expect(await expect404(serveWorkspaceCaptureFile(null, "src/app.ts", fakeStorage({})))).toBe(404);
  });

  test("path not in the manifest → 404", async () => {
    const storage = storageWith([fileEntry({ path: "src/app.ts" })]);
    expect(await expect404(serveWorkspaceCaptureFile(makeRow(), "nope.ts", storage))).toBe(404);
  });

  test("deleted file → 404", async () => {
    const storage = storageWith([fileEntry({ path: "gone.ts", status: "deleted", deleted: true, contentRef: null, hash: null })]);
    expect(await expect404(serveWorkspaceCaptureFile(makeRow(), "gone.ts", storage))).toBe(404);
  });

  test("tooLarge file → marker (metadata only, no content/URL)", async () => {
    const storage = storageWith([fileEntry({ path: "big.bin", tooLarge: true, contentRef: null, hash: null, sizeBytes: 9_000_000 })]);
    const res = await serveWorkspaceCaptureFile(makeRow(), "big.bin", storage);
    expect(res.tooLarge).toBe(true);
    expect(res.content).toBeNull();
    expect(res.contentUrl).toBeNull();
    expect(res.encoding).toBeNull();
    expect(res.sizeBytes).toBe(9_000_000);
  });

  test("small text file → inline utf8 content (bytes resolved from contentRef)", async () => {
    const bytes = new TextEncoder().encode("hello world\n");
    const storage = storageWith([fileEntry({ path: "src/app.ts", contentRef: TEXT_REF, sizeBytes: bytes.byteLength })], { [TEXT_REF]: bytes });
    const res = await serveWorkspaceCaptureFile(makeRow(), "src/app.ts", storage);
    expect(res.encoding).toBe("utf8");
    expect(res.content).toBe("hello world\n");
    expect(res.contentUrl).toBeNull();
    expect(storage.signed).toEqual([]);
  });

  test("small binary file → inline base64 content", async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
    const storage = storageWith([fileEntry({ path: "logo.png", isBinary: true, contentRef: BIN_REF, sizeBytes: bytes.byteLength })], { [BIN_REF]: bytes });
    const res = await serveWorkspaceCaptureFile(makeRow(), "logo.png", storage);
    expect(res.encoding).toBe("base64");
    expect(res.content).toBe(Buffer.from(bytes).toString("base64"));
  });

  test("file above the inline cap → signed URL, no inline content", async () => {
    const storage = storageWith(
      [fileEntry({ path: "big.txt", contentRef: BIG_REF, sizeBytes: CAPTURE_INLINE_FILE_MAX_BYTES + 1 })],
      { [BIG_REF]: new Uint8Array(1) },
    );
    const res = await serveWorkspaceCaptureFile(makeRow(), "big.txt", storage);
    expect(res.content).toBeNull();
    expect(res.contentUrl?.url).toContain(BIG_REF);
    expect(storage.signed).toEqual([BIG_REF]);
  });

  test("after-image blob missing (GC race) → marker, no throw", async () => {
    const storage = storageWith([fileEntry({ path: "src/app.ts", contentRef: TEXT_REF, sizeBytes: 12 })]); // no TEXT_REF blob
    const res = await serveWorkspaceCaptureFile(makeRow(), "src/app.ts", storage);
    expect(res.content).toBeNull();
    expect(res.contentUrl).toBeNull();
  });
});
