import assert from "node:assert/strict";
import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ci-info chooses a provider at module import time. This disposable process
// must never inherit a real CI or OIDC identity from the test runner.
assert.equal(process.env.CI, undefined);
assert.equal(process.env.GITHUB_ACTIONS, undefined);
assert.equal(process.env.GITLAB_CI, undefined);
assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);

// Only cryptographic network verification is stubbed in this isolated process.
// The real publishing library must check subjects, call verify, and attach the
// verified supplied bundle before any PUT. No real identity or registry is used.
let verified = 0, rejectSignature = false;
mock.module("sigstore", () => ({ verify: async () => {
  if (rejectSignature) throw new Error("synthetic invalid signature");
  verified++;
} }));
const { default: libnpmpublish } = await import("libnpmpublish");
const directory = mkdtempSync(join(tmpdir(), "canary-library-"));
const requests: { auth: string | null; body: unknown }[] = [];
let rejectWrite = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push({ auth: request.headers.get("authorization"), body: await request.json() });
    return Response.json({ ok: !rejectWrite }, { status: rejectWrite ? 503 : 201 });
  },
});

try {
  const manifest = { name: "@example/package", version: "1.0.1-canary.4" };
  const tarball = Buffer.from("synthetic-tarball");
  const options = {
    registry: server.url.toString(),
    forceAuth: { token: "synthetic-token" },
    defaultTag: "canary" as const,
    access: "public" as const,
    retry: { retries: 0 as const },
  };
  const response = await libnpmpublish.publish(manifest, tarball, {
    ...options,
    provenance: false,
  });
  assert.equal(response.ok, true);
  assert.equal(requests.length, 1);
  const supplied = join(directory, "provenance.json");
  const statement = { subject: [{ name: "pkg:npm/%40example/package@1.0.1-canary.4",
    digest: { sha512: createHash("sha512").update(tarball).digest("hex") } }] };
  const bundle = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } };
  writeFileSync(supplied, JSON.stringify(bundle));
  const suppliedResponse = await libnpmpublish.publish(manifest, tarball, {
    ...options, provenance: false, provenanceFile: supplied,
  });
  assert.equal(verified, 1);
  assert.equal(suppliedResponse.transparencyLogUrl, undefined);
  assert.equal(requests.length, 2);
  const attachments = (requests[1]!.body as { _attachments: Record<string, { data: string }> })._attachments;
  assert.ok(Object.values(attachments).some(attachment => attachment.data === JSON.stringify(bundle)));
  await assert.rejects(libnpmpublish.publish(manifest, Buffer.from("changed archive"), {
    ...options, provenance: false, provenanceFile: supplied,
  }), /digest does not match/);
  assert.equal(verified, 1);
  assert.equal(requests.length, 2);
  rejectSignature = true;
  await assert.rejects(libnpmpublish.publish(manifest, tarball, {
    ...options, provenance: false, provenanceFile: supplied,
  }), /invalid signature/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.auth, "Bearer synthetic-token");
  assert.deepEqual((requests[0]!.body as { "dist-tags": Record<string, string> })["dist-tags"], {
    canary: manifest.version,
  });
  await assert.rejects(
    libnpmpublish.publish(manifest, tarball, { ...options, provenance: true }),
    /Automatic provenance generation not supported/,
  );
  assert.equal(requests.length, 2);
  rejectWrite = true;
  await assert.rejects(
    libnpmpublish.publish(
      { ...manifest, name: "@example/unsettled-package" },
      tarball,
      { ...options, provenance: false },
    ),
    /503/,
  );
  assert.equal(requests.length, 3, "zero write retries must issue one failed request");
  process.stdout.write("synthetic publisher boundary passed\n");
} finally {
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
}
