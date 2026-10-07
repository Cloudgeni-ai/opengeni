import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import {
  acknowledgedPlan,
  archiveManifest,
  hash,
  MiB,
  normalizeBundle,
  publisherZip,
  PUBLISHER_PATH,
  RECOVERY_PATH,
  REPOSITORY,
  REPOSITORY_URL,
  signedPolicy,
  sourceCohort,
  SLSA,
  type JsonObject,
  type Origin,
  type PlanPackage,
} from "./canary-reconciliation-inputs";
import {
  admitController,
  admitFailedPublisher,
  reconcileAcknowledgedCanaries,
  RecoveryGets,
  RecoveryStore,
  RECOVERY_LIMITS,
  signatureArguments,
} from "./reconcile-canary-publication";

const origin: Origin = { source: "1".repeat(40), tree: "3".repeat(40), runId: "123", attempt: "1" };
const controller = { source: "2".repeat(40), runId: "456", attempt: "1" };
const version = "1.0.2-canary.123001";
const names = ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode", "@opengeni/ogtool"];
const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "canary-reconciliation-test-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function bytes(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}
function tar(members: [string, Buffer, string?][]) {
  const chunks: Buffer[] = [];
  for (const [path, body, type = "0"] of members) {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write("ustar\0", 257, 6);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(members: [string, Buffer][]) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let position = 0;
  for (const [name, body] of members) {
    const path = Buffer.from(name),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46),
      crc = crc32(body);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(body.length, 22);
    h.writeUInt16LE(path.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(body.length, 24);
    c.writeUInt16LE(path.length, 28);
    c.writeUInt32LE(position, 42);
    local.push(h, path, body);
    central.push(c, path);
    position += h.length + path.length + body.length;
  }
  const entries = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(entries.length, 12);
  end.writeUInt32LE(position, 16);
  return Buffer.concat([...local, entries, end]);
}
function fixture(count = 4) {
  const selectedNames = [
    ...names,
    ...Array.from(
      { length: Math.max(0, count - 4) },
      (_, index) => `@opengeni/example-${String(index).padStart(2, "0")}`,
    ),
  ];
  const archives = new Map<string, Buffer>();
  const packages = selectedNames.map((name) => {
    const manifest = {
      name,
      version,
      publishConfig: { access: "public", provenance: true, tag: "canary" },
      dependencies: { example: "1.0.0" },
      exports: { ".": "./dist/index.js" },
    };
    const archive = tar([
      ["package/package.json", bytes(manifest)],
      ["package/dist/index.js", Buffer.from("export const example = 'https://example.test';\n")],
    ]);
    archives.set(name, archive);
    return {
      name,
      version,
      previousLatest: "1.0.0",
      manifestSha256: hash(JSON.stringify(manifest)),
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      archiveBytes: archive.length,
    };
  });
  const cohort = selectedNames.map((name) => ({
    name,
    path: `packages/${name.slice(10)}/package.json`,
    manifest: { name, version: "1.0.0" },
  }));
  const members = new Map<string, Buffer>();
  let ordinal = 0;
  const file = (content: Buffer, suffix: string) => {
    const name = `${String(ordinal++).padStart(4, "0")}.${suffix}`;
    members.set(name, content);
    return { file: name, bytes: content.length, sha256: hash(content) };
  };
  const record = (kind: string, data: JsonObject = {}) =>
    file(
      bytes({
        protocol: 1,
        kind,
        identity: {
          source: origin.source,
          workflowSource: origin.source,
          runId: origin.runId,
          attempt: origin.attempt,
        },
        recordedAt: "2025-01-01T00:00:00.000Z",
        ...data,
      }),
      "json",
    );
  const headers = record("READ_RESPONSE", {
    package: names[0],
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const body = file(bytes({ "dist-tags": { latest: "1.0.0" }, versions: {} }), "body");
  record("READ_BODY", {
    package: names[0],
    headers,
    body,
    complete: true,
    truncated: false,
    received: body.bytes,
    retained: body.bytes,
    category: null,
  });
  record("COHORT_PLAN", {
    packages,
    packageCount: packages.length,
    archiveBytes: packages.reduce((sum, pkg) => sum + pkg.archiveBytes, 0),
    planSha256: hash(JSON.stringify(packages)),
  });
  for (const pkg of packages) {
    const binding = {
      package: pkg.name,
      version: pkg.version,
      integrity: pkg.integrity,
      archiveBytes: pkg.archiveBytes,
      manifestSha256: pkg.manifestSha256,
    };
    const intent = record("WRITE_INTENT", binding);
    record("WRITE_ACKNOWLEDGED", {
      ...binding,
      intent,
      status: 202,
      transparencyLogUrl: "https://search.sigstore.dev/?logIndex=1",
      headers: {},
      meaning: "POSITIVE_LIBRARY_HTTP_RESPONSE_NOT_SIGNED_BYTE_ACCEPTANCE",
    });
  }
  record("WRITE_PHASE_COMPLETE", { packageCount: packages.length });
  record("PUBLICATION_FAILED", { phase: "publication_and_receipts", noReplay: true });
  return { archives, packages, cohort, members };
}
function mutateRecord(
  members: Map<string, Buffer>,
  kind: string,
  change: (value: JsonObject) => void,
) {
  for (const [path, value] of members) {
    if (!path.endsWith(".json")) continue;
    const parsed = JSON.parse(value.toString()) as JsonObject;
    if (parsed.kind === kind) {
      change(parsed);
      members.set(path, bytes(parsed));
      return;
    }
  }
  throw new Error("Missing synthetic record");
}
function provenance(pkg: PlanPackage) {
  const signer = `${REPOSITORY_URL}/${PUBLISHER_PATH}@refs/heads/main`,
    invocation = `${REPOSITORY_URL}/actions/runs/123/attempts/1`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: SLSA,
    subject: [
      {
        name: `pkg:npm/${pkg.name.replace("@", "%40")}@${version}`,
        digest: { sha512: Buffer.from(pkg.integrity.slice(7), "base64").toString("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: { ref: "refs/heads/main", repository: REPOSITORY_URL, path: PUBLISHER_PATH },
        },
        internalParameters: { github: { event_name: "workflow_dispatch" } },
        resolvedDependencies: [
          { uri: `git+${REPOSITORY_URL}@refs/heads/main`, digest: { gitCommit: origin.source } },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: { invocationId: invocation },
      },
    },
  };
  const certificate = {
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
  const bundle = {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      tlogEntries: [{}],
      timestampVerificationData: { rfc3161Timestamps: [] },
    },
    dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: bytes(statement).toString("base64"),
      signatures: [{ sig: "synthetic-only", keyid: "" }],
    },
  };
  const verified = [
    {
      attestation: { bundle: structuredClone(bundle) },
      verificationResult: {
        statement: structuredClone(statement),
        signature: { certificate },
        verifiedTimestamps: [
          { type: "Tlog", uri: "https://rekor.sigstore.dev", timestamp: "2025-01-01T00:00:00Z" },
        ],
      },
    },
  ];
  return { bundle, verified, statement, certificate };
}
function providerFixture() {
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: origin.source,
    head_branch: "main",
    path: PUBLISHER_PATH,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    repository: { full_name: REPOSITORY, id: 1 },
    head_repository: { full_name: REPOSITORY, id: 1 },
    html_url: `${REPOSITORY_URL}/actions/runs/123`,
  };
  const jobs = {
    total_count: 1,
    jobs: [
      {
        name: "Publish canary.N",
        status: "completed",
        conclusion: "failure",
        run_id: 123,
        run_attempt: 1,
        head_sha: origin.source,
        steps: [
          { name: "Set up job", conclusion: "success" },
          { name: "Verify exact source", conclusion: "success" },
          { name: "Publish canary versions", conclusion: "failure" },
          { name: "Retain exact Site package pins for this deployment", conclusion: "skipped" },
          { name: "Retain bounded publication and registry receipts", conclusion: "success" },
          { name: "Complete job", conclusion: "success" },
        ],
      },
    ],
  };
  const artifacts = {
    total_count: 1,
    artifacts: [
      {
        id: 10,
        name: `canary-publication-receipts-${origin.source}`,
        expired: false,
        digest: `sha256:${"a".repeat(64)}`,
        size_in_bytes: 10,
        workflow_run: {
          id: 123,
          head_sha: origin.source,
          head_branch: "main",
          repository_id: 1,
          head_repository_id: 1,
        },
      },
    ],
  };
  return { run, jobs, artifacts };
}

describe("protected recovery admission", () => {
  const environment = () => ({
    SOURCE_SHA: origin.source,
    PUBLISHER_RUN_ID: "123",
    PUBLISHER_ATTEMPT: "1",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_SHA: controller.source,
    GITHUB_SHA: controller.source,
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/${RECOVERY_PATH}@refs/heads/main`,
    GITHUB_RUN_ID: "456",
    GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "synthetic-read-only",
  });
  test("new controller identity is distinct from the historical source", () => {
    expect(admitController(environment(), controller.source)).toEqual({
      controller,
      originInput: { source: origin.source, runId: "123", attempt: "1" },
    });
  });
  for (const [key, value] of Object.entries({
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/production",
    GITHUB_WORKFLOW_SHA: origin.source,
    GITHUB_REPOSITORY: "example/repository",
    GITHUB_SERVER_URL: "https://example.test",
    GITHUB_RUN_ID: "123",
    PUBLISHER_ATTEMPT: "1000",
    SOURCE_SHA: "HEAD",
    GH_TOKEN: "",
    NODE_AUTH_TOKEN: "forbidden",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "forbidden",
  })) {
    test(`refuses controller drift: ${key}`, () =>
      expect(() =>
        admitController({ ...environment(), [key]: value }, controller.source),
      ).toThrow());
  }
  test("provider confirms exact failed origin and absent Site artifact", () => {
    const f = providerFixture();
    expect(admitFailedPublisher(f.run, f.jobs, f.artifacts, origin).id).toBe(10);
  });
  for (const [key, value] of Object.entries({
    conclusion: "success",
    status: "in_progress",
    run_attempt: 2,
    head_sha: controller.source,
    path: RECOVERY_PATH,
    head_branch: "production",
    event: "push",
  })) {
    test(`refuses origin drift: ${key}`, () => {
      const f = providerFixture();
      expect(() =>
        admitFailedPublisher({ ...f.run, [key]: value }, f.jobs, f.artifacts, origin),
      ).toThrow();
    });
  }
  test("API partial pages, expiry, ambiguity, extra failure and existing Site refuse", () => {
    for (let mode = 0; mode < 5; mode++) {
      const f = providerFixture();
      if (mode === 0) f.artifacts.total_count = 2;
      if (mode === 1) f.artifacts.artifacts[0]!.expired = true;
      if (mode === 2) {
        f.artifacts.artifacts.push(structuredClone(f.artifacts.artifacts[0]!));
        f.artifacts.total_count++;
      }
      if (mode === 3) f.jobs.jobs[0]!.steps[0]!.conclusion = "failure";
      if (mode === 4) {
        f.artifacts.artifacts.push({
          ...f.artifacts.artifacts[0]!,
          name: `site-package-versions-${origin.source}`,
        });
        f.artifacts.total_count++;
      }
      expect(() => admitFailedPublisher(f.run, f.jobs, f.artifacts, origin)).toThrow();
    }
  });
});

describe("immutable origin receipts and archives", () => {
  test("flat ordinal ZIP, complete acknowledgement links and manifest match", () => {
    const f = fixture(),
      retained = publisherZip(zip([...f.members]));
    expect(acknowledgedPlan(retained, origin, f.cohort).packages).toEqual(f.packages);
    const inspected = archiveManifest(f.archives.get(names[0]!)!, f.packages[0]!, {
      tarBytes: 0,
      regularBytes: 0,
    });
    expect(inspected.manifest.name).toBe(names[0]);
    expect(inspected.members).toHaveLength(2);
  });
  test("ZIP rejects traversal, duplicate, missing ordinal, corruption and extra local bytes", () => {
    const f = fixture();
    expect(() => publisherZip(zip([["../0000.json", Buffer.alloc(1)]]))).toThrow();
    expect(() =>
      publisherZip(
        zip([
          ["0000.json", bytes({})],
          ["0000.json", bytes({})],
        ]),
      ),
    ).toThrow();
    expect(() => publisherZip(zip([["0001.json", bytes({})]]))).toThrow();
    const broken = zip([...f.members]);
    const changed = 30 + "0000.json".length;
    broken[changed] = broken[changed]! ^ 1;
    expect(() => publisherZip(broken)).toThrow();
    expect(() =>
      publisherZip(Buffer.concat([zip([...f.members]), Buffer.from("extra")])),
    ).toThrow();
  });
  for (const kind of [
    "COHORT_PLAN",
    "WRITE_INTENT",
    "WRITE_ACKNOWLEDGED",
    "WRITE_PHASE_COMPLETE",
    "PUBLICATION_FAILED",
  ]) {
    test(`missing ${kind} refuses instead of replay`, () => {
      const f = fixture();
      for (const [path, row] of f.members)
        if (path.endsWith(".json") && JSON.parse(row.toString()).kind === kind) {
          f.members.delete(path);
          break;
        }
      expect(() => acknowledgedPlan(f.members, origin, f.cohort)).toThrow();
    });
  }
  for (const [label, kind, change] of [
    [
      "UNKNOWN",
      "WRITE_ACKNOWLEDGED",
      (r: JsonObject) => {
        r.kind = "WRITE_UNKNOWN";
      },
    ],
    [
      "negative ACK",
      "WRITE_ACKNOWLEDGED",
      (r: JsonObject) => {
        r.status = 500;
      },
    ],
    [
      "intent hash",
      "WRITE_ACKNOWLEDGED",
      (r: JsonObject) => {
        (r.intent as JsonObject).sha256 = "0".repeat(64);
      },
    ],
    [
      "wrong source",
      "COHORT_PLAN",
      (r: JsonObject) => {
        (r.identity as JsonObject).source = controller.source;
      },
    ],
    [
      "plan hash",
      "COHORT_PLAN",
      (r: JsonObject) => {
        r.planSha256 = "0".repeat(64);
      },
    ],
    [
      "body hash",
      "READ_BODY",
      (r: JsonObject) => {
        (r.body as JsonObject).sha256 = "0".repeat(64);
      },
    ],
    [
      "failure phase",
      "PUBLICATION_FAILED",
      (r: JsonObject) => {
        r.phase = "packing";
      },
    ],
    [
      "unexpected success",
      "PUBLICATION_FAILED",
      (r: JsonObject) => {
        r.kind = "SITE_PINS_WRITTEN";
      },
    ],
  ] as const) {
    test(`receipt refuses ${label}`, () => {
      const f = fixture();
      mutateRecord(f.members, kind, change);
      expect(() => acknowledgedPlan(f.members, origin, f.cohort)).toThrow();
    });
  }
  test("unsafe tar, changed SRI, manifest serialization and local budgets refuse", () => {
    const f = fixture(),
      pkg = f.packages[0]!;
    expect(() =>
      archiveManifest(
        f.archives.get(pkg.name)!,
        { ...pkg, integrity: f.packages[1]!.integrity },
        { tarBytes: 0, regularBytes: 0 },
      ),
    ).toThrow();
    expect(() =>
      archiveManifest(
        f.archives.get(pkg.name)!,
        { ...pkg, manifestSha256: "0".repeat(64) },
        { tarBytes: 0, regularBytes: 0 },
      ),
    ).toThrow();
    expect(() =>
      archiveManifest(f.archives.get(pkg.name)!, pkg, { tarBytes: 512 * MiB, regularBytes: 0 }),
    ).toThrow();
    const link = tar([["package/package.json", bytes({}), "2"]]);
    const linkPkg = {
      ...pkg,
      archiveBytes: link.length,
      integrity: `sha512-${createHash("sha512").update(link).digest("base64")}`,
    };
    expect(() => archiveManifest(link, linkPkg, { tarBytes: 0, regularBytes: 0 })).toThrow();
  });
  test("historical JSON selection uses exclusions, ignore/private and complete dependency topology", () => {
    const files = new Map<string, Buffer>([
      ["package.json", bytes({ workspaces: ["apps/*", "!apps/mobile/", "packages/*"] })],
      [".changeset/config.json", bytes({ ignore: ["@opengeni/ignored"] })],
    ]);
    for (const [path, manifest] of [
      ["apps/mobile/package.json", { name: "@opengeni/mobile", version: "1.0.0" }],
      [
        "packages/a/package.json",
        {
          name: "@opengeni/a",
          version: "1.0.0",
          devDependencies: { "@opengeni/z": "workspace:*" },
        },
      ],
      ["packages/z/package.json", { name: "@opengeni/z", version: "1.0.0" }],
      [
        "packages/private/package.json",
        { name: "@opengeni/private", version: "1.0.0", private: true },
      ],
      ["packages/ignored/package.json", { name: "@opengeni/ignored", version: "1.0.0" }],
    ] as const)
      files.set(path, bytes(manifest));
    expect(sourceCohort(files).map((p) => p.name)).toEqual(["@opengeni/z", "@opengeni/a"]);
  });
});

describe("official verifier post-policy", () => {
  test("pins official argv and accepts only independently verified matching signed data", () => {
    const pkg = fixture().packages[0]!,
      p = provenance(pkg);
    expect(
      signatureArguments("/synthetic/archive.tgz", "/synthetic/bundle.json", origin),
    ).toContain("--deny-self-hosted-runners");
    expect(
      signatureArguments("/synthetic/archive.tgz", "/synthetic/bundle.json", origin),
    ).not.toContain("--no-public-good");
    expect(signedPolicy(p.bundle, p.verified, origin, pkg).archiveSha512).toBe(
      Buffer.from(pkg.integrity.slice(7), "base64").toString("hex"),
    );
    expect(normalizeBundle(p.bundle)).toEqual(normalizeBundle(p.verified[0]!.attestation.bundle));
  });
  for (const key of [
    "issuer",
    "subjectAlternativeName",
    "githubWorkflowRepository",
    "githubWorkflowRef",
    "githubWorkflowSHA",
    "githubWorkflowTrigger",
    "buildSignerURI",
    "buildSignerDigest",
    "runnerEnvironment",
    "sourceRepositoryURI",
    "sourceRepositoryDigest",
    "sourceRepositoryRef",
    "buildConfigURI",
    "buildConfigDigest",
    "buildTrigger",
    "runInvocationURI",
  ]) {
    test(`rejects certificate ${key} drift`, () => {
      const pkg = fixture().packages[0]!,
        p = provenance(pkg);
      (p.certificate as JsonObject)[key] = "synthetic-wrong";
      expect(() => signedPolicy(p.bundle, p.verified, origin, pkg)).toThrow();
    });
  }
  test("rejects differing verified bundle, unsigned statement, subject, invocation and transparency time", () => {
    for (let mode = 0; mode < 5; mode++) {
      const pkg = fixture().packages[0]!,
        p = provenance(pkg);
      if (mode === 0)
        p.verified[0]!.attestation.bundle.dsseEnvelope.signatures[0]!.sig = "different";
      if (mode === 1) p.verified[0]!.verificationResult.statement._type = "wrong";
      if (mode === 2) {
        p.statement.subject[0]!.name = "pkg:npm/example@1.0.0";
        p.bundle.dsseEnvelope.payload = bytes(p.statement).toString("base64");
        p.verified[0]!.attestation.bundle = structuredClone(p.bundle);
        p.verified[0]!.verificationResult.statement = structuredClone(p.statement);
      }
      if (mode === 3)
        p.certificate.runInvocationURI = `${REPOSITORY_URL}/actions/runs/123/attempts/2`;
      if (mode === 4) p.verified[0]!.verificationResult.verifiedTimestamps = [];
      expect(() => signedPolicy(p.bundle, p.verified, origin, pkg)).toThrow();
    }
  });
});

describe("bounded GET-only recovery", () => {
  function setup(count = 4) {
    const f = fixture(count),
      root = directory(),
      store = new RecoveryStore(join(root, "receipts"), controller, origin);
    const requests: { url: string; method?: string | undefined; authorization: string | null }[] =
      [];
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const pkg = f.packages.find((p) =>
        decodeURIComponent(new URL(url).pathname).includes(p.name),
      );
      if (!pkg) throw new Error("Unadmitted synthetic URL");
      if (url.endsWith(".tgz")) return new Response(new Uint8Array(f.archives.get(pkg.name)!));
      if (url.includes("/attestations/"))
        return Response.json({
          attestations: [{ predicateType: SLSA, bundle: provenance(pkg).bundle }],
        });
      if (url.includes("/dist-tags"))
        return Response.json({ latest: pkg.previousLatest, canary: pkg.version });
      return Response.json({
        name: pkg.name,
        version: pkg.version,
        dist: {
          integrity: pkg.integrity,
          tarball: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.slice(10)}-${pkg.version}.tgz`,
          attestations: {
            url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(pkg.name)}@${pkg.version}`,
            provenance: { predicateType: SLSA },
          },
        },
      });
    };
    const verify = async (_store: RecoveryStore, _origin: Origin, archive: { file: string }) => {
      const pkg = f.packages.find((p) =>
        f.archives.get(p.name)!.equals(readFileSync(join(store.directory, archive.file))),
      )!;
      return provenance(pkg).verified;
    };
    return { f, root, store, requests, request, verify };
  }
  test("complete acknowledged cohort emits distinct linked pins without a write/build/dispatch", async () => {
    const s = setup(),
      gets = new RecoveryGets(s.store, s.request, "synthetic-token");
    const result = await reconcileAcknowledgedCanaries({
      origin,
      controller,
      packages: s.f.cohort,
      members: s.f.members,
      artifact: { id: 10 },
      store: s.store,
      gets,
      request: s.request,
      verify: s.verify,
    });
    expect(result.publisherConclusion).toBe("failure");
    expect(result.providerSiteArtifact).toBe("absent");
    expect(result.promotionEligible).toBe(false);
    expect(result.sitePackageVersions).toEqual(
      Object.fromEntries(names.map((name) => [name, version])),
    );
    expect(s.requests).toHaveLength(28);
    expect(s.requests.every((r) => r.method === "GET" && r.authorization === null)).toBe(true);
    expect(result.metadataGets).toBe(16);
    expect(gets.counters().actualGets).toBe(12);
    const pins = readdirSync(s.store.directory).filter((p) => p.endsWith(".pins"));
    expect(pins).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(s.store.directory, pins[0]!), "utf8")).origin).toEqual(
      origin,
    );
    const metadata = readdirSync(join(s.store.directory, "metadata"))
      .filter((p) => p.endsWith(".json"))
      .map((p) => JSON.parse(readFileSync(join(s.store.directory, "metadata", p), "utf8")));
    expect(
      metadata.every(
        (r) => r.failedOrigin.source === origin.source && r.identity.source === controller.source,
      ),
    ).toBe(true);
    expect(metadata.some((r) => r.kind === "COHORT_READS_MATCHED")).toBe(true);
  });
  test("delayed receipt visibility polls GETs and preserves final complete-cohort verification", async () => {
    const s = setup();
    let elapsed = 0,
      pending = true,
      maximum = 0,
      active = 0;
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (
          pending &&
          input.toString().includes("?write=true") &&
          !input.toString().includes("/dist-tags")
        )
          return new Response("{}", { status: 404 });
        return await s.request(input, init);
      } finally {
        active--;
      }
    };
    const result = await reconcileAcknowledgedCanaries({
      origin,
      controller,
      packages: s.f.cohort,
      members: s.f.members,
      artifact: { id: 10 },
      store: s.store,
      gets: new RecoveryGets(s.store, request, "synthetic"),
      request,
      verify: s.verify,
      poll: {
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
          pending = false;
        },
      },
    });
    expect(result.promotionEligible).toBe(false);
    expect(Number(result.metadataGets)).toBeGreaterThan(16);
    expect(maximum).toBeLessThanOrEqual(4);
  });
  test("30 packages retain one complete budget and all 30 final rereads", async () => {
    const s = setup(30),
      gets = new RecoveryGets(s.store, s.request, "synthetic");
    const result = await reconcileAcknowledgedCanaries({
      origin,
      controller,
      packages: s.f.cohort,
      members: s.f.members,
      artifact: { id: 10 },
      store: s.store,
      gets,
      request: s.request,
      verify: s.verify,
    });
    expect((result.packages as unknown[]).length).toBe(30);
    expect(gets.counters().actualGets).toBe(90);
    expect(result.metadataGets).toBe(120);
    expect(s.requests.every((r) => r.method === "GET" && r.authorization === null)).toBe(true);
  });
  for (const mode of [
    "latest",
    "canary",
    "final-integrity",
    "signature",
    "null",
    "quota",
  ] as const) {
    test(`refuses ${mode} without emitting pins`, async () => {
      const s = setup();
      let versionReads = 0,
        elapsed = 0;
      const request = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("?write=true") && !url.includes("/dist-tags")) versionReads++;
        const response = await s.request(input, init);
        if (!url.includes("?write=true")) return response;
        const value = (await response.json()) as JsonObject;
        if (url.includes("/dist-tags")) {
          if (mode === "latest") value.latest = "9.9.9";
          if (mode === "canary") value.canary = "1.0.2-canary.999001";
        } else {
          if (mode === "null") return Response.json(null);
          if (mode === "final-integrity" && versionReads > 4)
            (value.dist as JsonObject).integrity = "sha512-wrong";
        }
        return Response.json(value);
      };
      await expect(
        reconcileAcknowledgedCanaries({
          origin,
          controller,
          packages: s.f.cohort,
          members: s.f.members,
          artifact: { id: 10 },
          store: s.store,
          gets: new RecoveryGets(s.store, request, "synthetic"),
          request,
          verify: mode === "signature" ? async () => [] : s.verify,
          poll: {
            maxReads: mode === "quota" ? 8 : 256,
            now: () => elapsed,
            sleep: async (ms) => {
              elapsed += ms;
            },
          },
        }),
      ).rejects.toThrow();
      expect(readdirSync(s.store.directory).filter((p) => p.endsWith(".pins"))).toEqual([]);
    });
  }
  test("transport retains over-cap prefix and refuses all further GETs", async () => {
    const s = setup();
    let calls = 0;
    const gets = new RecoveryGets(
      s.store,
      async () => {
        calls++;
        return new Response(Buffer.from("12345"));
      },
      "synthetic",
    );
    await expect(
      gets.get("https://registry.npmjs.org/example", "first", "selected", 4),
    ).rejects.toThrow();
    await expect(
      gets.get("https://registry.npmjs.org/example", "second", "selected", 4),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    const bodies = readdirSync(s.store.directory).filter((p) => p.endsWith(".body"));
    expect(readFileSync(join(s.store.directory, bodies[0]!), "utf8")).toBe("1234");
    expect(gets.counters().responseBytes.selected).toBe(5);
  });
  for (const phase of ["headers", "body"] as const) {
    test(`hard GET timeout closes ${phase} custody and forbids another request`, async () => {
      const s = setup();
      let calls = 0;
      const request = async () => {
        calls++;
        if (phase === "headers") return await new Promise<Response>(() => {});
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("prefix"));
            },
          }),
        );
      };
      const gets = new RecoveryGets(s.store, request, "synthetic", () => performance.now(), 20);
      await expect(
        gets.get("https://registry.npmjs.org/example", "first", "selected", 100),
      ).rejects.toThrow("no retry");
      await expect(
        gets.get("https://registry.npmjs.org/example", "second", "selected", 100),
      ).rejects.toThrow("admission closed");
      expect(calls).toBe(1);
      if (phase === "body") {
        const bodies = readdirSync(s.store.directory).filter((p) => p.endsWith(".body"));
        expect(readFileSync(join(s.store.directory, bodies[0]!), "utf8")).toBe("prefix");
        expect(gets.counters().responseBytes.selected).toBe(6);
      }
    });
  }
  test("provider auth stays on the canonical API and never follows an automatic redirect", async () => {
    const s = setup(),
      observed: { url: string; init?: RequestInit | undefined }[] = [];
    const gets = new RecoveryGets(
      s.store,
      async (input, init) => {
        observed.push({ url: input.toString(), init });
        return observed.length === 1
          ? new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://productionresultssatest.blob.core.windows.net/example?sig=synthetic",
              },
            })
          : new Response("zip");
      },
      "synthetic-token",
    );
    const first = await gets.get(
      `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/10/zip`,
      "location",
      "zip",
      100,
    );
    await gets.get(first.location!, "bytes", "zip", 100);
    expect(new Headers(observed[0]!.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-token",
    );
    expect(new Headers(observed[1]!.init?.headers).get("authorization")).toBeNull();
    expect(
      observed.every(
        (r) =>
          r.init?.method === "GET" && r.init.redirect === "manual" && r.init.credentials === "omit",
      ),
    ).toBe(true);
    const logs = readdirSync(s.store.directory)
      .filter((p) => p.endsWith(".json"))
      .map((p) => readFileSync(join(s.store.directory, p), "utf8"))
      .join("");
    expect(logs).not.toContain("synthetic-token");
    expect(logs).not.toContain("sig=synthetic");
  });
  test("expired stage, duplicate label and credential-bearing/cross-host URL refuse before GET", async () => {
    for (const mode of ["expired", "duplicate", "url"] as const) {
      const s = setup();
      let clock = 0,
        calls = 0;
      const gets = new RecoveryGets(
        s.store,
        async () => {
          calls++;
          return Response.json({});
        },
        "synthetic",
        () => clock,
      );
      if (mode === "expired") clock = RECOVERY_LIMITS.deadlineMs;
      if (mode === "duplicate")
        await gets.get("https://registry.npmjs.org/example", "same", "selected", 100);
      await expect(
        gets.get(
          mode === "url"
            ? "https://token@example.test/example"
            : "https://registry.npmjs.org/example",
          "same",
          "selected",
          100,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(mode === "duplicate" ? 1 : 0);
    }
  });
});

describe("recovery workflow authority", () => {
  const workflow = parse(readFileSync(join(import.meta.dir, "..", RECOVERY_PATH), "utf8")) as {
    on: JsonObject;
    permissions: JsonObject;
    concurrency: JsonObject;
    jobs: Record<
      string,
      {
        steps: { name: string; run?: string; env?: JsonObject; with?: JsonObject; if?: string }[];
        "timeout-minutes": number;
      }
    >;
  };
  test("manual protected controller shares publisher serialization and has no write credentials", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    expect(workflow.concurrency).toEqual({ group: "publish-canary", "cancel-in-progress": false });
    expect(workflow.jobs.reconcile!["timeout-minutes"]).toBe(25);
    const runs = workflow.jobs
      .reconcile!.steps.filter((s) => s.run)
      .map((s) => s.run!)
      .join("\n");
    expect(runs).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(runs).toContain("bun scripts/reconcile-canary-publication.ts");
    expect(runs).not.toContain("publish-canary.ts");
    expect(runs).not.toContain("bun run build");
    expect(JSON.stringify(workflow)).not.toContain("NPM_TOKEN");
    expect(JSON.stringify(workflow)).not.toContain("id-token");
  });
  test("new receipt delivery remains distinct and pin upload cannot run after a failure", () => {
    const steps = workflow.jobs.reconcile!.steps;
    const receipts = steps.find((s) => s.name === "Retain linked reconciliation receipts")!;
    const pins = steps.find((s) => s.name === "Retain explicitly reconciled Site pins")!;
    expect(receipts.if).toBe("always()");
    expect(pins.if).toBeUndefined();
    expect(String(receipts.with?.name)).toStartWith("canary-publication-reconciliation-");
    expect(String(pins.with?.name)).toStartWith("reconciled-site-package-versions-");
    expect(pins.with?.path).toBe(".release/canary-reconciliation/*.pins");
    expect(receipts.with?.["include-hidden-files"]).toBe(true);
  });
});
