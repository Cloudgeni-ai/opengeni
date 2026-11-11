import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelContextSnapshot } from "@opengeni/contracts";
import {
  encodeModelContextSnapshotContent,
  hydrateModelContextSnapshotFromValues,
  jsonObjectMembers,
  listSessionsForSecretRedaction,
  modelContextSnapshotRefDigests,
  readSessionArchiveManifestForRedaction,
  redactJsonRowText,
  redactJsonText,
  redactJsonValue,
  replaceJsonMembers,
  sessionSecretRedactionTextColumns,
  type JsonObjectMember,
  replaceSessionArchiveManifestForRedaction,
  scrubSessionSecretHistory,
  sessionArchiveObjectKeys,
  sessionSecretRedactionRoutinesGranted,
  type Database,
  type SecretRedactionCounts,
  type SecretRedactionMatcher,
  type SessionSecretRedactionReport,
  type SessionSecretRedactionScope,
} from "@opengeni/db";
import {
  downloadWorkspaceArchiveSpool,
  readCompressedJsonLines,
  uploadWorkspaceArchiveSpool,
  writeCompressedJsonLines,
  type ObjectStorage,
  type WorkspaceArchiveSpool,
} from "@opengeni/storage";

/**
 * The secret history scrub with the session archive (docs/secrets.md,
 * "Removing secrets from stored history"): the database pass, then, for each
 * archived session, its bundle and transcript in object storage.
 *
 * An archive object is rewritten line by line into a new object under a fresh
 * archive id (published keys are never overwritten), and the session's
 * manifest is swapped to it with its new size and digest only while it is
 * still the manifest that was read. The replaced objects are queued for the
 * archive's ordinary object deletion. Errors are reported by table and code.
 */

export const ARCHIVE_BUNDLE_TABLE = "archive_bundle";
export const ARCHIVE_TRANSCRIPT_TABLE = "archive_transcript";

type ArchiveObject = { key: string; bytes: number; sha256: string };

export type SessionSecretRedactionRunInput = {
  sessionIds: readonly string[];
  matchers: readonly SecretRedactionMatcher[];
  dryRun: boolean;
  /** Null when the deployment has no object storage; archives are then reported as failures. */
  storage: ObjectStorage | null;
  pageRows?: number;
  /** See `SessionSecretRedactionOptions`; only for an operator's one-off run. */
  rewriteReferencedSnapshotsWhilePending?: boolean;
};

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(code)) return code;
  return error instanceof Error ? error.name.slice(0, 80) : "unknown";
}

function archiveObject(value: unknown): ArchiveObject | null {
  if (typeof value !== "object" || value === null) return null;
  const { key, bytes, sha256 } = value as Record<string, unknown>;
  if (typeof key !== "string" || typeof sha256 !== "string") return null;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  return { key, bytes, sha256 };
}

type RewrittenObject = {
  counts: SecretRedactionCounts;
  /** Rows the rewrite changed or dropped; applied to `counts` once the swap lands. */
  changed: number;
  /** The rewritten object, written to a private file; null when nothing matched or dry run. */
  spool: WorkspaceArchiveSpool | null;
  /** The bundle's content-blob row count after the rewrite, when it changed. */
  blobRows?: number;
  /** Matched blob rows kept because something still refers to them. */
  keptMatchedBlobs?: number;
};

const BUNDLE_BLOB_TABLE = "session_content_blobs";
const BUNDLE_SNAPSHOT_TABLE = "session_attempt_model_context_snapshots";
const BUNDLE_CATALOG_TABLE = "session_attempt_tool_catalogs";
const DIGEST = /^[0-9a-f]{64}$/u;

function emptyCounts(): SecretRedactionCounts {
  return { rowsMatched: 0, rowsChanged: 0, matches: 0 };
}

/** Write every line, or (dry run) only count. */
async function produceObject(
  directory: string,
  name: string,
  dryRun: boolean,
  produce: (write: ((line: string) => Promise<void>) | null) => Promise<number>,
): Promise<{ spool: WorkspaceArchiveSpool | null; changed: number }> {
  if (dryRun) {
    await produce(null);
    return { spool: null, changed: 0 };
  }
  let changed = 0;
  const spool = await writeCompressedJsonLines(join(directory, name), async (write) => {
    changed = await produce(write);
  });
  if (changed === 0) {
    await spool.dispose();
    return { spool: null, changed: 0 };
  }
  return { spool, changed };
}

/** The transcript holds public events, one JSON document per line. */
async function rewriteArchiveTranscript(
  source: string,
  matchers: readonly SecretRedactionMatcher[],
  dryRun: boolean,
  directory: string,
): Promise<RewrittenObject> {
  const counts = emptyCounts();
  const { spool, changed } = await produceObject(
    directory,
    "transcript.jsonl.zst",
    dryRun,
    async (write) => {
      let changedLines = 0;
      for await (const line of readCompressedJsonLines(source)) {
        const result = redactJsonText(line, null, matchers);
        if (result.matches > 0) {
          counts.rowsMatched += 1;
          counts.matches += result.matches;
          changedLines += 1;
        }
        if (write) await write(result.text);
      }
      return changedLines;
    },
  );
  return { counts, changed, spool };
}

function bundleLineTable(line: string): string | null {
  // The archive writes `{"table":<name>,"row":<row>}` exactly.
  if (!line.startsWith('{"table":"')) return null;
  const end = line.indexOf('"', 10);
  return end === -1 ? null : line.slice(10, end);
}

function memberText(json: string, member: JsonObjectMember | undefined): string | null {
  return member ? json.slice(member.start, member.end) : null;
}

function members(json: string): Map<string, JsonObjectMember> {
  return new Map(jsonObjectMembers(json).map((member) => [member.key, member]));
}

/** A bundle row line with its row redacted column by column. */
function redactBundleLine(
  line: string,
  matchers: readonly SecretRedactionMatcher[],
): { text: string; matches: number } {
  const outer = members(line);
  const table = outer.get("table");
  const row = outer.get("row") ?? outer.get("session");
  if (!row) return redactJsonText(line, null, matchers);
  const tableName = table ? (JSON.parse(line.slice(table.start, table.end)) as string) : "sessions";
  const replacements: { member: JsonObjectMember; text: string }[] = [];
  let matches = 0;
  for (const member of outer.values()) {
    const text = line.slice(member.start, member.end);
    const result =
      member === row
        ? redactJsonRowText(text, sessionSecretRedactionTextColumns(tableName), matchers)
        : redactJsonText(text, null, matchers);
    if (result.matches === 0) continue;
    matches += result.matches;
    replacements.push({ member, text: result.text });
  }
  if (matches === 0) return { text: line, matches: 0 };
  return { text: replaceJsonMembers(line, replacements), matches };
}

/**
 * The bundle: every exported row as a line, model-request snapshots before
 * the content blobs they refer to. A snapshot is redacted whole (hydrated from
 * the bundle's blobs, as a secret can straddle two body chunks) and
 * re-encoded; its new blobs are added in digest order and the blobs nothing
 * refers to any more are dropped, so content addressing stays exact.
 */
async function rewriteArchiveBundle(
  source: string,
  matchers: readonly SecretRedactionMatcher[],
  dryRun: boolean,
  directory: string,
): Promise<RewrittenObject> {
  const counts = emptyCounts();
  let keptMatchedBlobs = 0;
  const blobDirectory = join(directory, "blobs");
  await mkdir(blobDirectory, { mode: 0o700 });
  // Pass 1: spool every blob value, by digest, to private files.
  const oldDigests = new Set<string>();
  let template: string | null = null;
  for await (const line of readCompressedJsonLines(source)) {
    if (bundleLineTable(line) !== BUNDLE_BLOB_TABLE) continue;
    const rowText = memberText(line, members(line).get("row"));
    if (rowText === null) {
      throw Object.assign(new Error("blob row"), { code: "archive_blob_invalid" });
    }
    const row = members(rowText);
    const digestText = memberText(rowText, row.get("digest"));
    const valueText = memberText(rowText, row.get("value"));
    if (digestText === null || valueText === null) {
      throw Object.assign(new Error("blob row"), { code: "archive_blob_invalid" });
    }
    const digest = JSON.parse(digestText) as unknown;
    if (typeof digest !== "string" || !DIGEST.test(digest)) {
      throw Object.assign(new Error("blob digest"), { code: "archive_blob_invalid" });
    }
    oldDigests.add(digest);
    template ??= rowText;
    await writeFile(join(blobDirectory, digest), valueText, { mode: 0o600 });
  }
  const readBlobs = async (digests: readonly string[]) => {
    const values = new Map<string, unknown>();
    for (const digest of digests) {
      if (values.has(digest)) continue;
      if (!DIGEST.test(digest) || !oldDigests.has(digest)) {
        throw Object.assign(new Error("blob missing"), { code: "archive_blob_missing" });
      }
      values.set(digest, JSON.parse(await readFile(join(blobDirectory, digest), "utf8")));
    }
    return values;
  };

  let blobRows = oldDigests.size;
  const { spool, changed } = await produceObject(
    directory,
    "bundle.jsonl.zst",
    dryRun,
    async (write) => {
      let changedLines = 0;
      let tableOrder: string[] = [];
      const referenced = new Set<string>();
      const replaced = new Set<string>();
      /** Blobs the rewritten snapshots add, by digest, as their JSON text. */
      const added = new Map<string, string>();
      let pendingAdded: string[] | null = null;
      let flushed = false;
      const blobRow = (digest: string, valueText: string) => {
        const row = members(template!);
        return `{"table":${JSON.stringify(BUNDLE_BLOB_TABLE)},"row":${replaceJsonMembers(
          template!,
          [
            { member: row.get("digest")!, text: JSON.stringify(digest) },
            { member: row.get("value")!, text: valueText },
          ],
        )}}`;
      };
      const flushUntil = async (digest: string | null) => {
        pendingAdded ??= [...added.keys()].sort();
        for (;;) {
          const next = pendingAdded[0];
          if (next === undefined || (digest !== null && next >= digest)) break;
          pendingAdded.shift();
          if (write) await write(blobRow(next, added.get(next)!));
          blobRows += 1;
          changedLines += 1;
        }
        if (digest === null) flushed = true;
      };
      const afterBlobs = (table: string | null) => {
        if (table === null) return true;
        const at = tableOrder.indexOf(table);
        const blobs = tableOrder.indexOf(BUNDLE_BLOB_TABLE);
        return at !== -1 && blobs !== -1 && at > blobs;
      };

      for await (const line of readCompressedJsonLines(source)) {
        const table = bundleLineTable(line);
        if (table === null && line.startsWith('{"format":')) {
          const header = JSON.parse(line) as { tables?: unknown };
          if (Array.isArray(header.tables)) tableOrder = header.tables.map(String);
          const result = redactBundleLine(line, matchers);
          if (result.matches > 0) {
            counts.rowsMatched += 1;
            counts.matches += result.matches;
            changedLines += 1;
          }
          if (write) await write(result.text);
          continue;
        }
        if (table !== BUNDLE_BLOB_TABLE && !flushed && afterBlobs(table)) await flushUntil(null);

        if (table === null && line.startsWith('{"end":')) {
          // The footer's row counts follow the blobs added and dropped.
          const footer = JSON.parse(line) as { rowCounts?: Record<string, number> };
          if (blobRows !== oldDigests.size && footer.rowCounts) {
            footer.rowCounts[BUNDLE_BLOB_TABLE] = blobRows;
            if (write) await write(JSON.stringify(footer));
          } else if (write) {
            await write(line);
          }
          continue;
        }

        if (table === BUNDLE_CATALOG_TABLE) {
          const rowText = memberText(line, members(line).get("row"))!;
          const refsText = memberText(rowText, members(rowText).get("content_refs"));
          const refs = refsText === null ? null : (JSON.parse(refsText) as { entries?: unknown });
          if (refs && Array.isArray(refs.entries)) {
            for (const digest of refs.entries)
              if (typeof digest === "string") referenced.add(digest);
          }
          const result = redactBundleLine(line, matchers);
          if (result.matches > 0) {
            counts.rowsMatched += 1;
            counts.matches += result.matches;
            changedLines += 1;
          }
          if (write) await write(result.text);
          continue;
        }

        if (table === BUNDLE_SNAPSHOT_TABLE) {
          const outer = members(line);
          const rowMember = outer.get("row")!;
          const rowText = line.slice(rowMember.start, rowMember.end);
          const row = members(rowText);
          const refsText = memberText(rowText, row.get("content_refs"));
          const refs = refsText === null ? null : (JSON.parse(refsText) as unknown);
          const digests = modelContextSnapshotRefDigests(refs);
          if (digests === null) {
            const result = redactBundleLine(line, matchers);
            if (result.matches > 0) {
              counts.rowsMatched += 1;
              counts.matches += result.matches;
              changedLines += 1;
            }
            if (write) await write(result.text);
            continue;
          }
          const snapshotMember = row.get("snapshot")!;
          const hydrated = hydrateModelContextSnapshotFromValues(
            JSON.parse(rowText.slice(snapshotMember.start, snapshotMember.end)),
            refs,
            await readBlobs(digests),
          );
          const result = redactJsonValue(hydrated, matchers);
          if (result.matches === 0) {
            for (const digest of digests) referenced.add(digest);
            if (write) await write(line);
            continue;
          }
          counts.rowsMatched += 1;
          counts.matches += result.matches;
          changedLines += 1;
          const encoded = encodeModelContextSnapshotContent(result.value as ModelContextSnapshot);
          const nextDigests = modelContextSnapshotRefDigests(encoded.refs) ?? [];
          for (const digest of nextDigests) referenced.add(digest);
          for (const digest of digests) replaced.add(digest);
          for (const [digest, value] of encoded.blobs) {
            if (!oldDigests.has(digest)) added.set(digest, JSON.stringify(value));
          }
          const nextRow = replaceJsonMembers(rowText, [
            { member: snapshotMember, text: JSON.stringify(encoded.stored) },
            { member: row.get("content_refs")!, text: JSON.stringify(encoded.refs) },
          ]);
          if (write) await write(replaceJsonMembers(line, [{ member: rowMember, text: nextRow }]));
          continue;
        }

        if (table === BUNDLE_BLOB_TABLE) {
          const rowText = memberText(line, members(line).get("row"))!;
          const row = members(rowText);
          const digest = JSON.parse(memberText(rowText, row.get("digest"))!) as string;
          await flushUntil(digest);
          const own = redactJsonText(memberText(rowText, row.get("value"))!, null, matchers);
          if (own.matches > 0) {
            counts.rowsMatched += 1;
            counts.matches += own.matches;
          }
          // Content-addressed: a blob is never rewritten in place. One that
          // nothing refers to is dropped: it was replaced, holds a match of
          // its own, or is a chunk an earlier failed run left behind (which
          // may hold part of a split secret). Only a replaced or matching one
          // makes the bundle worth rewriting; one still referred to stays.
          if (!referenced.has(digest)) {
            blobRows -= 1;
            if (replaced.has(digest) || own.matches > 0) changedLines += 1;
            continue;
          }
          // Still referred to (a tool catalog): its copy stays; say so.
          if (own.matches > 0) keptMatchedBlobs += 1;
          if (write) await write(line);
          continue;
        }

        const result = redactBundleLine(line, matchers);
        if (result.matches > 0) {
          counts.rowsMatched += 1;
          counts.matches += result.matches;
          changedLines += 1;
        }
        if (write) await write(result.text);
      }
      if (!flushed) await flushUntil(null);
      return changedLines;
    },
  );
  return {
    counts,
    changed,
    spool,
    keptMatchedBlobs,
    ...(blobRows === oldDigests.size ? {} : { blobRows }),
  };
}

async function scrubSessionArchive(
  db: Database,
  storage: ObjectStorage,
  scope: SessionSecretRedactionScope,
  sessionId: string,
  input: { matchers: readonly SecretRedactionMatcher[]; dryRun: boolean; privateGranted: boolean },
  /** The counts read so far, so a failed rewrite or swap still reports what matched. */
  progress: { tables?: Record<string, SecretRedactionCounts> } = {},
): Promise<{ tables: Record<string, SecretRedactionCounts>; keptMatchedBlobs: number }> {
  const found = await readSessionArchiveManifestForRedaction(db, scope, sessionId);
  if (!found) return { tables: {}, keptMatchedBlobs: 0 };
  const bundle = archiveObject(found.manifest.bundle);
  const transcript = archiveObject(found.manifest.transcript);
  if (!bundle || !transcript)
    throw Object.assign(new Error("manifest"), { code: "archive_manifest_invalid" });
  const directory = await mkdtemp(join(tmpdir(), "opengeni-secret-redaction-"));
  const uploaded: string[] = [];
  const sources: WorkspaceArchiveSpool[] = [];
  try {
    const download = async (object: ArchiveObject) => {
      const source = await downloadWorkspaceArchiveSpool(storage, object.key, {
        bytes: object.bytes,
        sha256: object.sha256,
      });
      sources.push(source);
      return source.path;
    };
    const rewrittenBundle = await rewriteArchiveBundle(
      await download(bundle),
      input.matchers,
      input.dryRun,
      directory,
    );
    const rewrittenTranscript = await rewriteArchiveTranscript(
      await download(transcript),
      input.matchers,
      input.dryRun,
      directory,
    );
    const tables = {
      [ARCHIVE_BUNDLE_TABLE]: rewrittenBundle.counts,
      [ARCHIVE_TRANSCRIPT_TABLE]: rewrittenTranscript.counts,
    };
    progress.tables = tables;
    const kept = input.dryRun ? 0 : (rewrittenBundle.keptMatchedBlobs ?? 0);
    if (input.dryRun || !input.privateGranted) return { tables, keptMatchedBlobs: 0 };
    if (!rewrittenBundle.spool && !rewrittenTranscript.spool) {
      return { tables, keptMatchedBlobs: kept };
    }

    const keys = sessionArchiveObjectKeys({ ...scope, sessionId }, randomUUID());
    const nextBundle = { ...bundle };
    const nextTranscript = { ...transcript };
    if (rewrittenBundle.spool) {
      await uploadWorkspaceArchiveSpool(storage, keys.bundle, rewrittenBundle.spool);
      uploaded.push(keys.bundle);
      Object.assign(nextBundle, {
        key: keys.bundle,
        bytes: rewrittenBundle.spool.byteSize,
        sha256: rewrittenBundle.spool.sha256,
      });
    }
    if (rewrittenTranscript.spool) {
      await uploadWorkspaceArchiveSpool(storage, keys.transcript, rewrittenTranscript.spool);
      uploaded.push(keys.transcript);
      Object.assign(nextTranscript, {
        key: keys.transcript,
        bytes: rewrittenTranscript.spool.byteSize,
        sha256: rewrittenTranscript.spool.sha256,
      });
    }
    const rowCounts = found.manifest.rowCounts;
    const manifest = {
      ...found.manifest,
      ...(rewrittenBundle.spool &&
      rewrittenBundle.blobRows !== undefined &&
      typeof rowCounts === "object" &&
      rowCounts !== null
        ? { rowCounts: { ...rowCounts, session_content_blobs: rewrittenBundle.blobRows } }
        : {}),
      objectKeys: [nextBundle.key, nextTranscript.key],
      bundle: { ...(found.manifest.bundle as object), ...nextBundle },
      transcript: { ...(found.manifest.transcript as object), ...nextTranscript },
      sha256: nextBundle.sha256,
    };
    let swapped: boolean;
    try {
      swapped = await replaceSessionArchiveManifestForRedaction(db, scope, {
        sessionId,
        before: found.before,
        manifest,
      });
    } catch (error) {
      // The swap may still commit, or have committed with its
      // acknowledgement lost, so an unchanged manifest proves nothing. Keep
      // the uploaded (already redacted) objects: an orphaned object only
      // costs storage, a manifest naming deleted ones loses the archive.
      // Only a session that is no longer archived cannot come to name them.
      const stored = await readSessionArchiveManifestForRedaction(db, scope, sessionId).catch(
        () => undefined,
      );
      if (stored !== null) uploaded.length = 0;
      throw error;
    }
    if (!swapped) {
      throw Object.assign(new Error("manifest changed"), { code: "archive_manifest_changed" });
    }
    uploaded.length = 0;
    if (rewrittenBundle.spool) rewrittenBundle.counts.rowsChanged = rewrittenBundle.changed;
    if (rewrittenTranscript.spool) {
      rewrittenTranscript.counts.rowsChanged = rewrittenTranscript.changed;
    }
    return { tables, keptMatchedBlobs: kept };
  } finally {
    // Objects uploaded for a swap that did not happen are not referenced.
    for (const key of uploaded) await storage.deleteObject(key).catch(() => undefined);
    for (const source of sources) await source.dispose().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A session listed as live may have been moved to long-term storage while its
 * rows were being scrubbed; the archive then holds rows the scrub had not yet
 * reached. Read every live session's state again so a newly archived session's
 * archive is scrubbed too, and one still being moved is reported, not passed.
 */
async function refreshArchiveStates(
  db: Database,
  scope: SessionSecretRedactionScope,
  report: SessionSecretRedactionReport,
  dryRun: boolean,
): Promise<void> {
  const live = report.sessions.filter((session) => !session.archived);
  if (live.length === 0) return;
  const current = new Map(
    (
      await listSessionsForSecretRedaction(db, scope, {
        sessionIds: live.map((session) => session.sessionId),
        includeDescendants: false,
      })
    ).map((row) => [row.id, row]),
  );
  for (const session of live) {
    const state = current.get(session.sessionId);
    if (state?.archived) {
      session.archived = true;
    } else if (
      state?.archiving &&
      !dryRun &&
      !report.failures.some(
        (failure) =>
          failure.sessionId === session.sessionId && failure.code === "session_archiving",
      )
    ) {
      report.failures.push({
        sessionId: session.sessionId,
        table: "sessions",
        code: "session_archiving",
      });
    }
  }
}

/**
 * Scrub (or count, with `dryRun`) the given sessions' stored history and their
 * archives. The caller authorizes every session; this never widens them.
 */
export async function runSessionSecretRedaction(
  db: Database,
  scope: SessionSecretRedactionScope,
  input: SessionSecretRedactionRunInput,
): Promise<SessionSecretRedactionReport> {
  const report = await scrubSessionSecretHistory(db, scope, {
    sessionIds: input.sessionIds,
    matchers: input.matchers,
    dryRun: input.dryRun,
    ...(input.pageRows === undefined ? {} : { pageRows: input.pageRows }),
    ...(input.rewriteReferencedSnapshotsWhilePending === undefined
      ? {}
      : { rewriteReferencedSnapshotsWhilePending: input.rewriteReferencedSnapshotsWhilePending }),
  });
  report.tables[ARCHIVE_BUNDLE_TABLE] ??= { rowsMatched: 0, rowsChanged: 0, matches: 0 };
  report.tables[ARCHIVE_TRANSCRIPT_TABLE] ??= { rowsMatched: 0, rowsChanged: 0, matches: 0 };
  if (input.matchers.length === 0) return report;
  await refreshArchiveStates(db, scope, report, input.dryRun);
  const archived = report.sessions.filter((session) => session.archived);
  if (archived.length === 0) return report;
  const privateGranted = await sessionSecretRedactionRoutinesGranted(db);
  if (!privateGranted && !input.dryRun) {
    report.pending.push(ARCHIVE_BUNDLE_TABLE, ARCHIVE_TRANSCRIPT_TABLE);
  }
  for (const session of archived) {
    if (!input.storage) {
      report.failures.push({
        sessionId: session.sessionId,
        table: ARCHIVE_BUNDLE_TABLE,
        code: "object_storage_unavailable",
      });
      continue;
    }
    const addCounts = (tables: Record<string, SecretRedactionCounts>) => {
      for (const [table, counts] of Object.entries(tables)) {
        if (counts.rowsMatched === 0 && counts.rowsChanged === 0) continue;
        session.tables[table] = counts;
        const total = report.tables[table]!;
        total.rowsMatched += counts.rowsMatched;
        total.rowsChanged += counts.rowsChanged;
        total.matches += counts.matches;
      }
    };
    const progress: { tables?: Record<string, SecretRedactionCounts> } = {};
    try {
      const { tables, keptMatchedBlobs } = await scrubSessionArchive(
        db,
        input.storage,
        scope,
        session.sessionId,
        { matchers: input.matchers, dryRun: input.dryRun, privateGranted },
        progress,
      );
      for (let kept = 0; kept < Math.min(keptMatchedBlobs, 20); kept += 1) {
        report.failures.push({
          sessionId: session.sessionId,
          table: ARCHIVE_BUNDLE_TABLE,
          code: "cell_not_rewritten",
        });
      }
      addCounts(tables);
    } catch (error) {
      // What matched is still reported. The replacement may or may not have
      // taken effect; a rerun shows which.
      if (progress.tables) addCounts(progress.tables);
      report.failures.push({
        sessionId: session.sessionId,
        table: ARCHIVE_BUNDLE_TABLE,
        code: errorCode(error),
      });
    }
  }
  return report;
}
