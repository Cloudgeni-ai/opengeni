import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { attest } from "sigstore";
import libnpmpublish from "libnpmpublish";
import { canarySourceStatement, signCanarySource } from "./canary-source-provenance";
import { publishCanaryArtifact } from "./publish-canary";

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
