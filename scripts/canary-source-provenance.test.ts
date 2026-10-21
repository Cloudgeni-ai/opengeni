import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { attest } from "sigstore";
import libnpmpublish from "libnpmpublish";
import { canarySourceStatement, signCanarySource } from "./canary-source-provenance";
import {
  freezeCanaryCohort,
  publishCanaryArtifact,
  publishPreparedCanaries,
} from "./publish-canary";
import { CanaryReceiptStore } from "./canary-publication-receipts";

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "Cloudgeni-ai/opengeni",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "b".repeat(40),
  GITHUB_WORKFLOW_SHA: "b".repeat(40),
  SOURCE_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "1234",
  GITHUB_RUN_ATTEMPT: "1",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_WORKFLOW_REF: "Cloudgeni-ai/opengeni/.github/workflows/publish-canary.yml@refs/heads/main",
};
const manifest = {
  name: "@opengeni/sdk",
  version: "1.0.2-canary.1234001",
  publishConfig: { access: "public", provenance: true },
};
const packed = Buffer.from("synthetic archive");

function tlogFailure(cause: object) {
  return Object.assign(new Error("synthetic Rekor failure", { cause }), {
    code: "TLOG_CREATE_ENTRY_ERROR",
  });
}
const syntheticBundle = (payload: Buffer, type: string) => ({
  dsseEnvelope: { payload: payload.toString("base64"), payloadType: type },
  verificationMaterial: { tlogEntries: [{ logIndex: "7" }] },
});

test.each([
  { code: "FETCH_ERROR", type: "request-timeout" },
  { code: "ECONNRESET", type: "system" },
  { code: "ETIMEDOUT" },
  { code: "EAI_AGAIN" },
  ...[408, 429, 500, 502, 503, 504].map((statusCode) => ({ statusCode })),
])(
  "transient Rekor failure retries identical provenance before retaining evidence: %j",
  async (cause) => {
    const directory = mkdtempSync(join(tmpdir(), "canary-sign-retry-"));
    try {
      let calls = 0;
      const waits: number[] = [];
      const payloads: Buffer[] = [];
      const sign = (async (payload, type, options) => {
        calls++;
        payloads.push(Buffer.from(payload));
        expect(options).toEqual({ retry: { retries: 0 }, timeout: 30_000 });
        expect(readdirSync(directory)).toHaveLength(0);
        if (calls < 3) throw tlogFailure(cause);
        return syntheticBundle(payload, type);
      }) as typeof attest;
      const result = await signCanarySource(manifest, packed, directory, env, sign, async (ms) => {
        waits.push(ms);
      });
      expect(calls).toBe(3);
      expect(waits).toEqual([1_000, 2_000]);
      expect(payloads).toEqual(
        Array(3).fill(Buffer.from(JSON.stringify(canarySourceStatement(manifest, packed, env)))),
      );
      expect(readdirSync(directory)).toHaveLength(1);
      expect(result.evidence?.sha256).toBe(
        createHash("sha256").update(readFileSync(result.file)).digest("hex"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  tlogFailure({ statusCode: 400 }),
  tlogFailure({ statusCode: 401, code: "ECONNRESET" }),
  tlogFailure({ statusCode: 403 }),
  tlogFailure({ statusCode: 409, location: "https://untrusted.example.test/entry" }),
  tlogFailure({ code: "CERT_HAS_EXPIRED" }),
  tlogFailure({ code: "ENOTFOUND" }),
  tlogFailure({ code: "FETCH_ERROR", type: "invalid-json" }),
  tlogFailure({}),
  Object.assign(new Error("Fulcio rejected identity", { cause: { code: "ECONNRESET" } }), {
    code: "CA_CREATE_SIGNING_CERTIFICATE_ERROR",
  }),
  Object.assign(new Error("unscoped transport error"), { code: "ECONNRESET" }),
])("permanent, malformed or non-Rekor failures are not retried: %j", async (error) => {
  const directory = mkdtempSync(join(tmpdir(), "canary-sign-permanent-"));
  try {
    let calls = 0,
      waits = 0;
    await expect(
      signCanarySource(
        manifest,
        packed,
        directory,
        env,
        (async () => {
          calls++;
          throw error;
        }) as typeof attest,
        async () => {
          waits++;
        },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(waits).toBe(0);
    expect(readdirSync(directory)).toHaveLength(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exhausted signing has no npm intent; recovered signing never retries an unknown npm write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canary-sign-custody-"));
  try {
    for (const exhausted of [true, false]) {
      const custodyDirectory = join(directory, exhausted ? "exhausted" : "unknown");
      const custody = new CanaryReceiptStore(custodyDirectory, {
        source: env.SOURCE_SHA,
        workflowSource: env.GITHUB_SHA,
        runId: env.GITHUB_RUN_ID,
        attempt: env.GITHUB_RUN_ATTEMPT,
      });
      const cohort = freezeCanaryCohort(
        ["@opengeni/sdk", "@opengeni/react"].map((name) => ({
          name,
          version: manifest.version,
          previousLatest: "1.0.0",
          manifest: { ...manifest, name },
          packed,
        })),
        custody,
      );
      let signs = 0,
        writes = 0,
        preparations = 0;
      const error = tlogFailure({ code: "ECONNRESET" });
      const operation = publishPreparedCanaries(
        cohort,
        custody,
        "synthetic",
        async () => ({
          "dist-tags": { latest: "1.0.0" },
          versions: {},
        }),
        (async (_manifest, _packed, options) => {
          writes++;
          expect(options.retry).toEqual({ retries: 0 });
          throw Object.assign(new Error("npm response lost"), { code: "ECONNRESET" });
        }) as typeof libnpmpublish.publish,
        120_000,
        async (pkg) => {
          preparations++;
          return signCanarySource(
            pkg.manifest,
            pkg.packed,
            directory,
            env,
            (async (payload, type) => {
              signs++;
              if (exhausted || signs === 1) throw error;
              return syntheticBundle(payload, type);
            }) as typeof attest,
            async () => {},
          );
        },
      );
      if (exhausted) await expect(operation).rejects.toBe(error);
      else await expect(operation).rejects.toThrow("write outcome is unknown");
      expect(signs).toBe(exhausted ? 3 : 2);
      expect(writes).toBe(exhausted ? 0 : 1);
      expect(preparations).toBe(1); // No later package is signed or published.
      const events = readdirSync(custodyDirectory)
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(join(custodyDirectory, file), "utf8")));
      expect(events.filter((event) => event.kind === "WRITE_INTENT")).toHaveLength(
        exhausted ? 0 : 1,
      );
      expect(events.filter((event) => event.kind === "WRITE_UNKNOWN")).toHaveLength(
        exhausted ? 0 : 1,
      );
      expect(
        events.some(
          (event) => event.kind === "WRITE_ACKNOWLEDGED" || event.kind === "WRITE_PHASE_COMPLETE",
        ),
      ).toBe(false);
      if (!exhausted) {
        expect(events.find((event) => event.kind === "WRITE_UNKNOWN").noReplay).toBe(true);
        expect(events.find((event) => event.kind === "PROVENANCE_PREPARED").meaning).toBe(
          "SIGNED_INPUT_NOT_REGISTRY_WRITE_ACCEPTANCE",
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid returned evidence and retained-file failures never restart signing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canary-sign-evidence-"));
  try {
    for (const invalid of [true, false]) {
      let calls = 0;
      const sign = (async (payload, type) => {
        calls++;
        return syntheticBundle(invalid ? Buffer.from("wrong") : payload, type);
      }) as typeof attest;
      const operation = signCanarySource(
        manifest,
        packed,
        invalid ? directory : join(directory, "missing"),
        env,
        sign,
        async () => {
          throw new Error("must not retry evidence/storage failure");
        },
      );
      await expect(operation).rejects.toThrow();
      expect(calls).toBe(1);
      expect(readdirSync(directory)).toHaveLength(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exhausted later signing preserves earlier acknowledgement without completing the cohort", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canary-sign-partial-"));
  try {
    const receiptDirectory = join(directory, "receipts");
    const custody = new CanaryReceiptStore(receiptDirectory, {
      source: env.SOURCE_SHA,
      workflowSource: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
    });
    const cohort = freezeCanaryCohort(
      ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode"].map((name) => ({
        name,
        version: manifest.version,
        previousLatest: "1.0.0",
        manifest: { ...manifest, name },
        packed: Buffer.from(name),
      })),
      custody,
    );
    const writes: string[] = [],
      signs: string[] = [];
    await expect(
      publishPreparedCanaries(
        cohort,
        custody,
        "synthetic",
        async () => ({
          "dist-tags": { latest: "1.0.0" },
          versions: {},
        }),
        (async (pkg, _packed, options) => {
          expect(options.retry).toEqual({ retries: 0 });
          writes.push(String(pkg.name));
          return { ok: true, status: 201 };
        }) as typeof libnpmpublish.publish,
        120_000,
        (pkg) =>
          signCanarySource(
            pkg.manifest,
            pkg.packed,
            directory,
            env,
            (async (payload, type) => {
              signs.push(pkg.name);
              if (pkg.name !== "@opengeni/sdk") throw tlogFailure({ code: "ECONNRESET" });
              return syntheticBundle(payload, type);
            }) as typeof attest,
            async () => {},
          ),
      ),
    ).rejects.toThrow("synthetic Rekor failure");
    expect(writes).toEqual(["@opengeni/sdk"]);
    expect(signs).toEqual([
      "@opengeni/sdk",
      "@opengeni/react",
      "@opengeni/react",
      "@opengeni/react",
    ]);
    const events = readdirSync(receiptDirectory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(receiptDirectory, file), "utf8")));
    expect(events.filter((event) => event.kind === "WRITE_INTENT")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "WRITE_ACKNOWLEDGED")).toHaveLength(1);
    expect(
      events.some((event) =>
        ["WRITE_UNKNOWN", "WRITE_PHASE_COMPLETE", "SITE_PINS_WRITTEN"].includes(event.kind),
      ),
    ).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signed tarball subject distinguishes selected source from truthful controller identity", () => {
  const statement = canarySourceStatement(manifest, packed, env);
  expect(statement.subject).toEqual([
    {
      name: "pkg:npm/%40opengeni/sdk@1.0.2-canary.1234001",
      digest: { sha512: createHash("sha512").update(packed).digest("hex") },
    },
  ]);
  expect(statement.predicate.buildDefinition.externalParameters.source.commit).toBe(env.SOURCE_SHA);
  expect(statement.predicate.buildDefinition.resolvedDependencies).toEqual([
    {
      uri: "git+https://github.com/Cloudgeni-ai/opengeni@refs/heads/main",
      digest: { gitCommit: env.GITHUB_SHA },
    },
    {
      uri: `git+https://github.com/Cloudgeni-ai/opengeni@${env.SOURCE_SHA}`,
      digest: { gitCommit: env.SOURCE_SHA },
    },
  ]);
  expect(statement.predicate.runDetails.metadata.invocationId).toEndWith("/1234/attempts/1");
  expect(canarySourceStatement(manifest, Buffer.from("changed"), env).subject).not.toEqual(
    statement.subject,
  );
  expect(() =>
    canarySourceStatement(manifest, packed, { ...env, RUNNER_ENVIRONMENT: "self-hosted" }),
  ).toThrow();
  expect(() =>
    canarySourceStatement(manifest, packed, { ...env, GITHUB_WORKFLOW_SHA: env.SOURCE_SHA }),
  ).toThrow();
});

test("supplied provenance uses the official verify-before-publish path without falsifying GitHub SHA", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canary-provenance-"));
  try {
    const before = { ...env };
    const sign = (async (payload, type) => ({
      dsseEnvelope: { payload: payload.toString("base64"), payloadType: type },
      verificationMaterial: { tlogEntries: [{ logIndex: "7" }] },
    })) as typeof attest;
    const supplied = await signCanarySource(manifest, packed, directory, env, sign);
    const bundle = JSON.parse(readFileSync(supplied.file, "utf8"));
    const retained = readFileSync(supplied.file);
    expect(supplied.evidence?.bytes).toBe(retained.length);
    expect(supplied.evidence?.sha256).toBe(createHash("sha256").update(retained).digest("hex"));
    expect(JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString())).toEqual(
      canarySourceStatement(manifest, packed, env),
    );
    let calls = 0;
    const publish = (async (_manifest, archive, options) => {
      calls++;
      expect(archive).toEqual(packed);
      expect(options.provenance).toBe(false);
      expect(options.provenanceFile).toBe(supplied.file);
      expect(options.defaultTag).toBe("canary");
      expect(options.retry).toEqual({ retries: 0 });
      return { ok: true, status: 201 }; // supplied-file library path has no URL
    }) as typeof libnpmpublish.publish;
    expect(
      await publishCanaryArtifact(
        manifest,
        packed,
        "synthetic",
        publish,
        undefined,
        undefined,
        supplied,
      ),
    ).toMatchObject({ status: 201, transparencyLogUrl: "https://search.sigstore.dev/?logIndex=7" });
    expect(calls).toBe(1);
    expect(env).toEqual(before);
    await expect(
      signCanarySource(manifest, packed, directory, env, (async () => ({
        dsseEnvelope: { payload: "wrong" },
        verificationMaterial: { tlogEntries: [{ logIndex: "7" }] },
      })) as unknown as typeof attest),
    ).rejects.toThrow("provenance");
    await expect(
      publishCanaryArtifact(
        manifest,
        packed,
        "synthetic",
        (async () => ({ ok: false, status: 400 })) as typeof libnpmpublish.publish,
        undefined,
        undefined,
        supplied,
      ),
    ).rejects.toThrow("not confirmed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
