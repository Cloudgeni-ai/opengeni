import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, inflateRawSync } from "node:zlib";

export const REPOSITORY = "Cloudgeni-ai/opengeni";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const PUBLISHER_PATH = ".github/workflows/publish-canary.yml";
export const RECOVERY_PATH = ".github/workflows/reconcile-canary-publication.yml";
export const SLSA = "https://slsa.dev/provenance/v1";
export const MiB = 1024 * 1024;
export type JsonObject = Record<string, unknown>;
export type Origin = { source: string; tree: string; runId: string; attempt: string };
export type PlanPackage = {
  name: string;
  version: string;
  previousLatest?: string;
  manifestSha256: string;
  integrity: string;
  archiveBytes: number;
};
export type SourcePackage = { name: string; manifest: JsonObject; path: string };

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function object(value: unknown): JsonObject {
  requireThat(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected object",
  );
  return value as JsonObject;
}
export function array(value: unknown): unknown[] {
  requireThat(Array.isArray(value), "Expected array");
  return value;
}
export function text(value: unknown): string {
  requireThat(typeof value === "string", "Expected string");
  return value;
}
export function hash(bytes: Buffer | string, algorithm = "sha256"): string {
  return createHash(algorithm).update(bytes).digest("hex");
}
export function json(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function equal(actual: unknown, expected: unknown, message: string): void {
  requireThat(isDeepStrictEqual(actual, expected), message);
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  requireThat(
    Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum,
    "Integer outside bound",
  );
  return Number(value);
}
export function positiveId(value: unknown): string {
  const result = text(value);
  requireThat(
    /^[1-9]\d{0,14}$/.test(result) && Number.isSafeInteger(Number(result)),
    "Invalid workflow ID",
  );
  return result;
}
export function sha(value: unknown): string {
  const result = text(value);
  requireThat(/^[a-f0-9]{40}$/.test(result), "Invalid source SHA");
  return result;
}

// Historical source is JSON data, never an imported module or executable checkout.
// The caller also pins the historical selection/publisher protocol blobs to the
// controller's supported implementations before using this selection.
export function sourceCohort(files: ReadonlyMap<string, Buffer>): SourcePackage[] {
  const root = object(json(files.get("package.json")!));
  const config = object(json(files.get(".changeset/config.json")!));
  const excluded = new Set(
    array(root.workspaces)
      .map(text)
      .filter((p) => p.startsWith("!"))
      .map((p) => p.slice(1).replace(/\/+$/u, "")),
  );
  const ignored = new Set(array(config.ignore ?? []).map(text));
  const all = [...files.entries()]
    .filter(
      ([path]) =>
        /^(apps|packages)\/[^/]+\/package\.json$/.test(path) && !excluded.has(path.slice(0, -13)),
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => ({ path, manifest: object(json(bytes)) }))
    .filter((p) => typeof p.manifest.name === "string" && typeof p.manifest.version === "string")
    .map((p) => ({ ...p, name: text(p.manifest.name) }));
  requireThat(new Set(all.map((p) => p.name)).size === all.length, "Duplicate source workspace");
  const selected = all.filter(
    (p) => p.name.startsWith("@opengeni/") && p.manifest.private !== true && !ignored.has(p.name),
  );
  requireThat(selected.length > 0 && selected.length <= 64, "Source cohort outside bound");
  const byName = new Map(selected.map((p) => [p.name, p]));
  const visited = new Set<string>(),
    visiting = new Set<string>(),
    ordered: SourcePackage[] = [];
  const visit = (pkg: SourcePackage) => {
    if (visited.has(pkg.name)) return;
    requireThat(!visiting.has(pkg.name), "Source workspace dependency cycle");
    visiting.add(pkg.name);
    const dependencies = new Set<string>();
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "devDependencies",
    ]) {
      for (const name of Object.keys(object(pkg.manifest[field] ?? {})))
        if (byName.has(name)) dependencies.add(name);
    }
    for (const name of [...dependencies].sort()) visit(byName.get(name)!);
    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  };
  for (const pkg of selected) visit(pkg);
  return ordered;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The publisher artifact has only flat ordinal JSON/body files; no extraction. */
export function publisherZip(bytes: Buffer): Map<string, Buffer> {
  requireThat(bytes.length >= 22 && bytes.length <= 80 * MiB, "Receipt ZIP outside bound");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  requireThat(end >= 0, "Missing ZIP end");
  const count = bytes.readUInt16LE(end + 10),
    central = bytes.readUInt32LE(end + 16);
  requireThat(
    bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0 &&
      bytes.readUInt16LE(end + 8) === count &&
      count > 0 &&
      count <= 2048 &&
      central + bytes.readUInt32LE(end + 12) === end,
    "Unsupported ZIP directory",
  );
  const result = new Map<string, Buffer>(),
    spans: [number, number][] = [];
  let offset = central,
    total = 0;
  for (let index = 0; index < count; index++) {
    requireThat(
      offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50,
      "Invalid ZIP entry",
    );
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16),
      packed = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extra + comment;
    requireThat(
      next <= end &&
        (flags & ~0x808) === 0 &&
        [0, 8].includes(method) &&
        bytes.readUInt16LE(offset + 34) === 0,
      "Unsupported ZIP encoding",
    );
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    requireThat(
      /^\d{4}\.(json|body)$/.test(name) && !result.has(name),
      "Unexpected or duplicate ZIP member",
    );
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    requireThat((mode & 0o170000) === 0 || (mode & 0o170000) === 0o100000, "Nonregular ZIP member");
    requireThat(size <= (name.endsWith(".json") ? 64 * 1024 : 8 * MiB), "ZIP member outside bound");
    total += size;
    requireThat(total <= 80 * MiB, "Inflated ZIP outside bound");
    const local = bytes.readUInt32LE(offset + 42);
    requireThat(
      local + 30 <= central &&
        bytes.readUInt32LE(local) === 0x04034b50 &&
        bytes.readUInt16LE(local + 6) === flags &&
        bytes.readUInt16LE(local + 8) === method,
      "Invalid ZIP local entry",
    );
    const localNameLength = bytes.readUInt16LE(local + 26),
      start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    requireThat(
      bytes.subarray(local + 30, local + 30 + localNameLength).equals(Buffer.from(name)) &&
        start + packed <= central,
      "ZIP local member differs",
    );
    const unpacked =
      method === 0
        ? Buffer.from(bytes.subarray(start, start + packed))
        : inflateRawSync(bytes.subarray(start, start + packed), {
            maxOutputLength: Math.max(1, size),
          });
    requireThat(unpacked.length === size && crc32(unpacked) === crc, "ZIP member digest differs");
    let localEnd = start + packed;
    if (flags & 8) {
      if (localEnd + 4 <= central && bytes.readUInt32LE(localEnd) === 0x08074b50) localEnd += 4;
      requireThat(
        localEnd + 12 <= central &&
          bytes.readUInt32LE(localEnd) === crc &&
          bytes.readUInt32LE(localEnd + 4) === packed &&
          bytes.readUInt32LE(localEnd + 8) === size,
        "ZIP descriptor differs",
      );
      localEnd += 12;
    } else {
      requireThat(
        bytes.readUInt32LE(local + 14) === crc &&
          bytes.readUInt32LE(local + 18) === packed &&
          bytes.readUInt32LE(local + 22) === size,
        "ZIP local size differs",
      );
    }
    spans.push([local, localEnd]);
    result.set(name, unpacked);
    offset = next;
  }
  requireThat(offset === end, "Extra ZIP directory bytes");
  spans.sort(([a], [b]) => a - b);
  let cursor = 0;
  for (const [start, finish] of spans) {
    requireThat(start === cursor, "Overlapping or unlisted ZIP bytes");
    cursor = finish;
  }
  requireThat(cursor === central, "Unlisted ZIP local bytes");
  const names = [...result.keys()].sort();
  for (let index = 0; index < names.length; index++)
    requireThat(Number(names[index]!.slice(0, 4)) === index, "Missing receipt ordinal");
  return result;
}

function linkedFile(value: unknown, members: ReadonlyMap<string, Buffer>): string {
  const ref = object(value),
    file = text(ref.file),
    bytes = members.get(file);
  requireThat(
    Object.keys(ref).sort().join(",") === "bytes,file,sha256" &&
      bytes &&
      bytes.length === ref.bytes &&
      hash(bytes) === ref.sha256,
    "Receipt file link differs",
  );
  return file;
}

export function acknowledgedPlan(
  members: ReadonlyMap<string, Buffer>,
  origin: Origin,
  cohort: readonly SourcePackage[],
): {
  packages: PlanPackage[];
  planSha256: string;
  inventory: { file: string; bytes: number; sha256: string }[];
} {
  const records = [...members.entries()]
    .filter(([name]) => name.endsWith(".json"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, bytes]) => ({ file, record: object(json(bytes)) }));
  const identity = {
    source: origin.source,
    workflowSource: origin.source,
    runId: origin.runId,
    attempt: origin.attempt,
  };
  const allowed = new Set([
    "READ_RESPONSE",
    "READ_BODY",
    "READ_FAILED",
    "READ_SELECTION",
    "READ_OBSERVATION",
    "COHORT_PLAN",
    "WRITE_INTENT",
    "WRITE_ACKNOWLEDGED",
    "WRITE_PHASE_COMPLETE",
    "PUBLICATION_FAILED",
  ]);
  const bodies = new Set<string>(),
    headers = new Set<string>();
  for (const { file, record } of records) {
    equal(record.identity, identity, "Receipt origin identity differs");
    requireThat(
      record.protocol === 1 &&
        allowed.has(text(record.kind)) &&
        typeof record.recordedAt === "string" &&
        Number.isFinite(Date.parse(record.recordedAt)),
      "Unsupported publisher receipt",
    );
    if (record.kind === "READ_BODY") {
      const headerFile = linkedFile(record.headers, members),
        bodyFile = linkedFile(record.body, members);
      const header = records.find((row) => row.file === headerFile)?.record;
      requireThat(
        header?.kind === "READ_RESPONSE" &&
          header.package === record.package &&
          bodyFile.endsWith(".body") &&
          !headers.has(headerFile) &&
          !bodies.has(bodyFile) &&
          Number(headerFile.slice(0, 4)) < Number(bodyFile.slice(0, 4)) &&
          Number(bodyFile.slice(0, 4)) < Number(file.slice(0, 4)) &&
          record.retained === members.get(bodyFile)!.length &&
          Number.isSafeInteger(record.received) &&
          Number(record.received) >= Number(record.retained) &&
          typeof record.complete === "boolean" &&
          typeof record.truncated === "boolean",
        "Receipt body custody differs",
      );
      headers.add(headerFile);
      bodies.add(bodyFile);
    }
    if (record.kind === "READ_RESPONSE") integer(record.status, 100, 599);
  }
  requireThat(
    [...members.keys()].filter((p) => p.endsWith(".body")).every((p) => bodies.has(p)),
    "Orphan response body",
  );
  requireThat(
    records.filter((r) => r.record.kind === "READ_RESPONSE").every((r) => headers.has(r.file)),
    "Unclosed response header",
  );
  const only = (kind: string) => {
    const found = records.filter((r) => r.record.kind === kind);
    requireThat(found.length === 1, `Expected one ${kind}`);
    return found[0]!;
  };
  const plan = only("COHORT_PLAN"),
    complete = only("WRITE_PHASE_COMPLETE"),
    failure = only("PUBLICATION_FAILED");
  const packages = array(plan.record.packages).map((value, index): PlanPackage => {
    const pkg = object(value);
    const keys = Object.keys(pkg).sort().join(",");
    requireThat(
      keys === "archiveBytes,integrity,manifestSha256,name,version" ||
        keys === "archiveBytes,integrity,manifestSha256,name,previousLatest,version",
      "Unsupported cohort plan fields",
    );
    const name = text(pkg.name),
      version = text(pkg.version);
    requireThat(
      name === cohort[index]?.name &&
        /^@opengeni\/[a-z0-9][a-z0-9._-]*$/.test(name) &&
        /^\d+\.\d+\.\d+-canary\.[1-9]\d*$/.test(version) &&
        Number(version.split("-canary.")[1]) ===
          Number(origin.runId) * 1000 + Number(origin.attempt) &&
        /^[a-f0-9]{64}$/.test(text(pkg.manifestSha256)) &&
        /^sha512-[A-Za-z0-9+/]{86}==$/.test(text(pkg.integrity)),
      "Cohort package identity differs",
    );
    integer(pkg.archiveBytes, 1, 64 * MiB);
    if (Object.hasOwn(pkg, "previousLatest")) text(pkg.previousLatest);
    return pkg as PlanPackage;
  });
  requireThat(
    packages.length === cohort.length &&
      plan.record.packageCount === packages.length &&
      complete.record.packageCount === packages.length &&
      packages.reduce((sum, p) => sum + p.archiveBytes, 0) === plan.record.archiveBytes &&
      Number(plan.record.archiveBytes) <= 512 * MiB &&
      hash(JSON.stringify(packages)) === plan.record.planSha256 &&
      new Set(packages.map((p) => p.version)).size === 1 &&
      failure.record.phase === "publication_and_receipts" &&
      failure.record.noReplay === true,
    "Cohort plan or failure differs",
  );
  const intents = records.filter((r) => r.record.kind === "WRITE_INTENT"),
    acks = records.filter((r) => r.record.kind === "WRITE_ACKNOWLEDGED");
  requireThat(
    intents.length === packages.length && acks.length === packages.length,
    "Incomplete acknowledged cohort",
  );
  let previous = Number(plan.file.slice(0, 4));
  for (let index = 0; index < packages.length; index++) {
    const pkg = packages[index]!,
      intent = intents[index]!,
      ack = acks[index]!;
    const binding = {
      package: pkg.name,
      version: pkg.version,
      integrity: pkg.integrity,
      archiveBytes: pkg.archiveBytes,
      manifestSha256: pkg.manifestSha256,
    };
    for (const record of [intent.record, ack.record])
      for (const [key, value] of Object.entries(binding))
        equal(record[key], value, "Write binding differs");
    requireThat(
      linkedFile(ack.record.intent, members) === intent.file &&
        Number(intent.file.slice(0, 4)) > previous &&
        Number(ack.file.slice(0, 4)) > Number(intent.file.slice(0, 4)) &&
        integer(ack.record.status, 200, 299) &&
        /^https:\/\/search\.sigstore\.dev\/\?logIndex=\d+$/.test(
          text(ack.record.transparencyLogUrl),
        ) &&
        ack.record.meaning === "POSITIVE_LIBRARY_HTTP_RESPONSE_NOT_SIGNED_BYTE_ACCEPTANCE",
      "Write acknowledgement differs",
    );
    previous = Number(ack.file.slice(0, 4));
  }
  requireThat(
    Number(complete.file.slice(0, 4)) > previous &&
      Number(failure.file.slice(0, 4)) > Number(complete.file.slice(0, 4)) &&
      failure.file === records.at(-1)?.file,
    "Publisher closure order differs",
  );
  return {
    packages,
    planSha256: text(plan.record.planSha256),
    inventory: [...members].map(([file, bytes]) => ({
      file,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
  };
}

function tarNumber(bytes: Buffer): number {
  const value = bytes.toString("ascii").replace(/\0.*$/s, "").trim();
  requireThat(/^[0-7]*$/.test(value), "Unsupported tar number");
  return integer(value ? parseInt(value, 8) : 0, 0, 256 * MiB);
}
function tarText(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)),
  );
}
/** No filesystem extraction; links, sparse files and nonregular payloads refuse. */
export function archiveManifest(
  packed: Buffer,
  pkg: PlanPackage,
  budget: { tarBytes: number; regularBytes: number },
): { manifest: JsonObject; members: { memberPath: string; bytes: number; sha256: string }[] } {
  requireThat(
    packed.length === pkg.archiveBytes &&
      `sha512-${createHash("sha512").update(packed).digest("base64")}` === pkg.integrity,
    "Archive bytes differ from acknowledged plan",
  );
  const tar = gunzipSync(packed, {
    maxOutputLength: Math.min(256 * MiB, 512 * MiB - budget.tarBytes),
  });
  budget.tarBytes += tar.length;
  requireThat(budget.tarBytes <= 512 * MiB && tar.length % 512 === 0, "Tar cohort outside bound");
  let offset = 0,
    pendingPath: string | undefined,
    manifest: JsonObject | undefined;
  const seen = new Set<string>(),
    members: { memberPath: string; bytes: number; sha256: string }[] = [];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      requireThat(
        pendingPath === undefined &&
          tar.length - offset >= 1024 &&
          tar.subarray(offset).every((byte) => byte === 0),
        "Invalid tar closure",
      );
      requireThat(manifest, "Packed manifest missing");
      return { manifest, members };
    }
    let checksum = 0;
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : header[index]!;
    requireThat(checksum === tarNumber(header.subarray(148, 156)), "Tar checksum differs");
    const size = tarNumber(header.subarray(124, 136)),
      type = header[156],
      start = offset + 512;
    requireThat(start + size <= tar.length, "Truncated tar member");
    const body = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 120 || type === 76) {
      requireThat(
        pendingPath === undefined && size <= 64 * 1024,
        "Tar extended header outside bound",
      );
      if (type === 76) pendingPath = tarText(body).replace(/\n$/, "");
      else {
        let cursor = 0;
        while (cursor < body.length) {
          const space = body.indexOf(32, cursor);
          requireThat(space > cursor, "Invalid PAX length");
          const length = integer(
            Number(body.subarray(cursor, space).toString("ascii")),
            1,
            64 * 1024,
          );
          requireThat(
            cursor + length <= body.length && body[cursor + length - 1] === 10,
            "Invalid PAX record",
          );
          const item = tarText(body.subarray(space + 1, cursor + length - 1)),
            equals = item.indexOf("=");
          const key = item.slice(0, equals),
            value = item.slice(equals + 1);
          requireThat(
            equals > 0 &&
              ["path", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"].includes(key),
            "Unsupported PAX field",
          );
          if (key === "path") {
            requireThat(pendingPath === undefined, "Duplicate PAX path");
            pendingPath = value;
          }
          cursor += length;
        }
      }
      continue;
    }
    const prefix = tarText(header.subarray(345, 500)),
      path = pendingPath ?? `${prefix ? prefix + "/" : ""}${tarText(header.subarray(0, 100))}`;
    pendingPath = undefined;
    requireThat(
      /^package(?:\/|$)/.test(path) &&
        !/[\\\x00-\x1f\x7f]/.test(path) &&
        !path
          .replace(/\/$/, "")
          .split("/")
          .some((part) => part === ".." || part === "." || part === "") &&
        (path !== "package" || type === 53) &&
        !seen.has(path),
      "Unsafe or duplicate tar path",
    );
    seen.add(path);
    requireThat(seen.size <= 20_000, "Tar member count outside bound");
    requireThat(type === 0 || type === 48 || (type === 53 && size === 0), "Nonregular tar member");
    if (type === 53) continue;
    budget.regularBytes += size;
    requireThat(budget.regularBytes <= 512 * MiB, "Regular payload cohort outside bound");
    members.push({ memberPath: path, bytes: size, sha256: hash(body) });
    if (path === "package/package.json") {
      requireThat(size <= 64 * 1024, "Manifest outside bound");
      manifest = object(json(body));
      requireThat(
        manifest.name === pkg.name &&
          manifest.version === pkg.version &&
          hash(JSON.stringify(manifest)) === pkg.manifestSha256,
        "Packed manifest differs",
      );
      const publish = object(manifest.publishConfig);
      requireThat(
        publish.access === "public" &&
          publish.provenance === true &&
          (publish.tag === undefined || publish.tag === "canary") &&
          manifest.devDependencies === undefined,
        "Packed publication contract differs",
      );
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        requireThat(
          Object.values(object(manifest[field] ?? {})).every(
            (spec) => typeof spec === "string" && !spec.startsWith("workspace:"),
          ),
          "Unrewritten published dependency",
        );
      }
    }
  }
  throw new Error("Missing tar end");
}

// Only protobuf's documented absent defaults are normalized on BOTH sides.
export function normalizeBundle(value: unknown): unknown {
  const result = object(structuredClone(value));
  const timestamps =
    result.verificationMaterial && object(result.verificationMaterial).timestampVerificationData;
  if (
    timestamps &&
    Array.isArray(object(timestamps).rfc3161Timestamps) &&
    array(object(timestamps).rfc3161Timestamps).length === 0
  )
    delete object(timestamps).rfc3161Timestamps;
  if (result.dsseEnvelope)
    for (const signature of array(object(result.dsseEnvelope).signatures))
      if (object(signature).keyid === "") delete object(signature).keyid;
  return result;
}
export function signedPolicy(
  bundle: unknown,
  verified: unknown,
  origin: Origin,
  pkg: PlanPackage,
): JsonObject {
  const rows = array(verified);
  requireThat(rows.length === 1, "Expected one verified signature");
  const row = object(rows[0]),
    attestation = object(row.attestation),
    verification = object(row.verificationResult);
  equal(
    normalizeBundle(attestation.bundle),
    normalizeBundle(bundle),
    "Verified bundle differs from retained bundle",
  );
  const certificate = object(object(verification.signature).certificate);
  const signer = `${REPOSITORY_URL}/${PUBLISHER_PATH}@refs/heads/main`;
  const invocation = `${REPOSITORY_URL}/actions/runs/${origin.runId}/attempts/${origin.attempt}`;
  const expected = {
    issuer: "https://token.actions.githubusercontent.com",
    subjectAlternativeName: signer,
    githubWorkflowRepository: REPOSITORY,
    githubWorkflowRef: "refs/heads/main",
    githubWorkflowSHA: origin.source,
    githubWorkflowTrigger: "workflow_dispatch",
    buildSignerURI: signer,
    buildSignerDigest: origin.source,
    runnerEnvironment: "github-hosted",
    sourceRepositoryURI: REPOSITORY_URL,
    sourceRepositoryDigest: origin.source,
    sourceRepositoryRef: "refs/heads/main",
    buildConfigURI: signer,
    buildConfigDigest: origin.source,
    buildTrigger: "workflow_dispatch",
    runInvocationURI: invocation,
  };
  for (const [key, value] of Object.entries(expected))
    equal(certificate[key], value, "Certificate identity differs");
  requireThat(
    array(verification.verifiedTimestamps).some((stamp) => {
      const item = object(stamp);
      return (
        item.type === "Tlog" &&
        item.uri === "https://rekor.sigstore.dev" &&
        Number.isFinite(Date.parse(text(item.timestamp)))
      );
    }),
    "Verified transparency time missing",
  );
  const retained = object(bundle),
    material = object(retained.verificationMaterial),
    envelope = object(retained.dsseEnvelope);
  requireThat(
    retained.mediaType === "application/vnd.dev.sigstore.bundle.v0.3+json" &&
      array(envelope.signatures).length === 1 &&
      array(material.tlogEntries).length >= 1 &&
      envelope.payloadType === "application/vnd.in-toto+json",
    "Unsupported provenance bundle",
  );
  const encoded = text(envelope.payload);
  requireThat(
    encoded.length <= 2 * MiB && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
    "Invalid signed payload encoding",
  );
  const decoded = Buffer.from(encoded, "base64");
  requireThat(decoded.toString("base64") === encoded, "Noncanonical signed payload");
  const statement = object(json(decoded));
  equal(verification.statement, statement, "Verified statement differs from signed payload");
  requireThat(
    statement._type === "https://in-toto.io/Statement/v1" && statement.predicateType === SLSA,
    "Unsupported signed statement",
  );
  equal(
    statement.subject,
    [
      {
        name: `pkg:npm/${pkg.name.replace("@", "%40")}@${pkg.version}`,
        digest: { sha512: Buffer.from(pkg.integrity.slice(7), "base64").toString("hex") },
      },
    ],
    "Signed archive subject differs",
  );
  const predicate = object(statement.predicate),
    definition = object(predicate.buildDefinition),
    details = object(predicate.runDetails);
  requireThat(
    definition.buildType ===
      "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
    "Signed build type differs",
  );
  equal(
    object(definition.externalParameters).workflow,
    { ref: "refs/heads/main", repository: REPOSITORY_URL, path: PUBLISHER_PATH },
    "Signed workflow differs",
  );
  equal(
    object(object(definition.internalParameters).github).event_name,
    "workflow_dispatch",
    "Signed event differs",
  );
  equal(
    definition.resolvedDependencies,
    [{ uri: `git+${REPOSITORY_URL}@refs/heads/main`, digest: { gitCommit: origin.source } }],
    "Signed source differs",
  );
  equal(
    object(details.builder).id,
    "https://github.com/actions/runner/github-hosted",
    "Signed runner differs",
  );
  equal(object(details.metadata).invocationId, invocation, "Signed invocation differs");
  return {
    certificate,
    statementSha256: hash(decoded),
    archiveSha512: Buffer.from(pkg.integrity.slice(7), "base64").toString("hex"),
  };
}
