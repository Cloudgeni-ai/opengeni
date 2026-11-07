import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/**
 * Reading a `git-receive-pack` request well enough to tell an ordinary push
 * from a branch deletion or a force push, and to answer with Git's own
 * per-ref rejection when a push must wait for approval.
 */

export const ZERO_OID = "0000000000000000000000000000000000000000";

export type ReceivePackCommand = {
  oldOid: string;
  newOid: string;
  ref: string;
};

export type ReceivePackRequest = {
  commands: ReceivePackCommand[];
  capabilities: string[];
  /** Offset of the pack (or end of input when the push sends none). */
  packOffset: number;
};

const OID_PATTERN = /^[0-9a-f]{40}$/u;

function readPktLine(
  body: Uint8Array,
  offset: number,
): { payload: Uint8Array | null; next: number } | null {
  if (offset + 4 > body.length) return null;
  const header = Buffer.from(body.subarray(offset, offset + 4)).toString("latin1");
  if (!/^[0-9a-f]{4}$/iu.test(header)) return null;
  const length = Number.parseInt(header, 16);
  if (length === 0) return { payload: null, next: offset + 4 };
  if (length < 4 || offset + length > body.length) return null;
  return { payload: body.subarray(offset + 4, offset + length), next: offset + length };
}

/** Parse the command list at the start of a receive-pack request. Null when it is not one. */
export function parseReceivePackRequest(body: Uint8Array): ReceivePackRequest | null {
  const commands: ReceivePackCommand[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  let first = true;
  for (;;) {
    const line = readPktLine(body, offset);
    if (!line) return null;
    offset = line.next;
    if (line.payload === null) break;
    let text = Buffer.from(line.payload).toString("utf8");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (first) {
      const nul = text.indexOf("\0");
      if (nul >= 0) {
        capabilities = text
          .slice(nul + 1)
          .split(" ")
          .filter((value) => value.length > 0);
        text = text.slice(0, nul);
      }
      first = false;
    }
    if (text.startsWith("shallow ")) continue;
    if (text === "push-cert") return null;
    const [oldOid, newOid, ref, ...extra] = text.split(" ");
    if (!oldOid || !newOid || !ref || extra.length > 0) return null;
    if (!OID_PATTERN.test(oldOid) || !OID_PATTERN.test(newOid)) return null;
    commands.push({ oldOid, newOid, ref });
  }
  if (capabilities.includes("push-options")) {
    for (;;) {
      const line = readPktLine(body, offset);
      if (!line) break;
      offset = line.next;
      if (line.payload === null) break;
    }
  }
  return { commands, capabilities, packOffset: offset };
}

function pktLine(text: string | Uint8Array): Buffer {
  const payload = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
  return Buffer.concat([
    Buffer.from((payload.length + 4).toString(16).padStart(4, "0"), "latin1"),
    payload,
  ]);
}

function sanitizeReason(reason: string): string {
  return reason.replace(/[\r\n\0]+/gu, " ").slice(0, 400);
}

/**
 * Git's own answer refusing every ref of a push, so `git push` prints
 * `! [remote rejected] <ref> (<reason>)` and `remote: <message>` lines.
 */
export function receivePackRejection(
  request: ReceivePackRequest,
  reasons: Map<string, string>,
  fallbackReason: string,
  messages: string[] = [],
): Buffer {
  const report = Buffer.concat([
    pktLine("unpack ok\n"),
    ...request.commands.map((command) =>
      pktLine(`ng ${command.ref} ${sanitizeReason(reasons.get(command.ref) ?? fallbackReason)}\n`),
    ),
    Buffer.from("0000", "latin1"),
  ]);
  const sideBand =
    request.capabilities.includes("side-band-64k") || request.capabilities.includes("side-band");
  if (!sideBand) return report;
  const chunkSize = request.capabilities.includes("side-band-64k") ? 65515 : 995;
  const parts: Buffer[] = [];
  for (const message of messages) {
    parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(`${message}\n`, "utf8")])));
  }
  for (let start = 0; start < report.length; start += chunkSize) {
    parts.push(
      pktLine(Buffer.concat([Buffer.from([1]), report.subarray(start, start + chunkSize)])),
    );
  }
  parts.push(Buffer.from("0000", "latin1"));
  return Buffer.concat(parts);
}

/**
 * Commit objects in a pack and their parents. Deltified commits are
 * resolved when their base is in the pack; a commit whose base is not (a
 * thin pack) is reported in `unresolvedDeltas`. Null when the data is not a
 * readable version 2 or 3 pack.
 */
export function readPackCommits(
  pack: Uint8Array,
): { commits: Map<string, string[]>; unresolvedDeltas: number } | null {
  const data = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (data.length < 12 || data.toString("latin1", 0, 4) !== "PACK") return null;
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = data.readUInt32BE(8);
  type Entry = {
    offset: number;
    type: number;
    dataOffset: number;
    baseOffset?: number;
    baseOid?: string;
  };
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let cursor = 12;
  try {
    for (let index = 0; index < count; index += 1) {
      const start = cursor;
      let byte = data[cursor++]!;
      const type = (byte >> 4) & 7;
      while (byte & 0x80) byte = data[cursor++]!;
      const entry: Entry = { offset: start, type, dataOffset: 0 };
      if (type === 6) {
        byte = data[cursor++]!;
        let relative = byte & 0x7f;
        while (byte & 0x80) {
          byte = data[cursor++]!;
          relative = (relative + 1) * 128 + (byte & 0x7f);
        }
        entry.baseOffset = start - relative;
      } else if (type === 7) {
        entry.baseOid = data.toString("hex", cursor, cursor + 20);
        cursor += 20;
      }
      if (cursor > data.length) return null;
      entry.dataOffset = cursor;
      const inflated = inflateSync(data.subarray(cursor), { info: true }) as unknown as {
        engine: { bytesWritten: number };
      };
      cursor += inflated.engine.bytesWritten;
      entries.push(entry);
      byOffset.set(start, entry);
    }
  } catch {
    return null;
  }

  const inflate = (entry: Entry): Buffer => inflateSync(data.subarray(entry.dataOffset));
  const resolvedType = (entry: Entry, depth = 0): number | null => {
    if (depth > 64) return null;
    if (entry.type >= 1 && entry.type <= 4) return entry.type;
    if (entry.type === 6) {
      const base = entry.baseOffset !== undefined ? byOffset.get(entry.baseOffset) : undefined;
      return base ? resolvedType(base, depth + 1) : null;
    }
    return null;
  };

  const objectOid = (type: number, body: Buffer): string =>
    createHash("sha1")
      .update(`${["", "commit", "tree", "blob", "tag"][type]} ${body.length}\0`)
      .update(body)
      .digest("hex");
  // Commits resolve in pack order: a REF_DELTA base always precedes the delta
  // in packs Git writes, and an OFS_DELTA base always does by construction.
  const commitContent = new Map<number, Buffer>();
  const commitByOid = new Map<string, Buffer>();
  const commits = new Map<string, string[]>();
  let unresolvedDeltas = 0;
  for (const entry of entries) {
    let body: Buffer | null = null;
    if (entry.type === 1) {
      body = inflate(entry);
    } else if (entry.type === 6 || entry.type === 7) {
      if (entry.type === 6 && resolvedType(entry) !== 1) continue;
      const base =
        entry.type === 6 ? commitContent.get(entry.baseOffset!) : commitByOid.get(entry.baseOid!);
      if (!base) {
        // A thin pack's base lives on the server (usually a tree or blob).
        // A commit hidden this way just ends the walk at the boundary.
        unresolvedDeltas += 1;
        continue;
      }
      body = applyDelta(base, inflate(entry));
      if (!body) {
        unresolvedDeltas += 1;
        continue;
      }
    } else {
      continue;
    }
    const oid = objectOid(1, body);
    commitContent.set(entry.offset, body);
    commitByOid.set(oid, body);
    commits.set(oid, commitParents(body));
  }
  return { commits, unresolvedDeltas };
}

function commitParents(body: Buffer): string[] {
  const parents: string[] = [];
  const text = body.toString("latin1", 0, Math.min(body.length, 64 * 1024));
  for (const line of text.split("\n")) {
    if (line === "") break;
    if (line.startsWith("parent ")) parents.push(line.slice("parent ".length).trim());
  }
  return parents;
}

function readVarint(delta: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = start;
  let byte: number;
  do {
    byte = delta[cursor++]!;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, next: cursor };
}

/** Apply a Git pack delta to its base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
  const source = readVarint(delta, 0);
  if (source.value !== base.length) return null;
  const target = readVarint(delta, source.next);
  const output = Buffer.alloc(target.value);
  let written = 0;
  let cursor = target.next;
  while (cursor < delta.length) {
    const op = delta[cursor++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) offset |= delta[cursor++]! << (bit * 8);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (1 << (4 + bit))) size |= delta[cursor++]! << (bit * 8);
      }
      if (size === 0) size = 0x10000;
      offset >>>= 0;
      if (offset + size > base.length || written + size > output.length) return null;
      base.copy(output, written, offset, offset + size);
      written += size;
    } else if (op > 0) {
      if (cursor + op > delta.length || written + op > output.length) return null;
      delta.copy(output, written, cursor, cursor + op);
      written += op;
      cursor += op;
    } else {
      return null;
    }
  }
  return written === output.length ? output : null;
}

/**
 * Commits reachable from `newOid` inside the pack that end the walk: parents
 * that are not in the pack (they already exist on the server). `reachedOld`
 * is true when the walk met `oldOid` itself.
 */
export function packBoundary(
  commits: Map<string, string[]>,
  newOid: string,
  oldOid: string,
  limit = 100_000,
): { reachedOld: boolean; boundary: string[] } {
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const queue = [newOid];
  while (queue.length > 0 && seen.size < limit) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === oldOid) return { reachedOld: true, boundary: [] };
    const parents = commits.get(oid);
    if (!parents) {
      boundary.add(oid);
      continue;
    }
    queue.push(...parents);
  }
  return { reachedOld: false, boundary: [...boundary] };
}
