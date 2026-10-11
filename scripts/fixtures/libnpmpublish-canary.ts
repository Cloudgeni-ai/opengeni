import assert from "node:assert/strict";

// ci-info chooses a provider at module import time. This disposable process
// must never inherit a real CI or OIDC identity from the test runner.
assert.equal(process.env.CI, undefined);
assert.equal(process.env.GITHUB_ACTIONS, undefined);
assert.equal(process.env.GITLAB_CI, undefined);
assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);

const { default: libnpmpublish } = await import("libnpmpublish");
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
  assert.equal(requests[0]!.auth, "Bearer synthetic-token");
  assert.deepEqual((requests[0]!.body as { "dist-tags": Record<string, string> })["dist-tags"], {
    canary: manifest.version,
  });
  await assert.rejects(
    libnpmpublish.publish(manifest, tarball, { ...options, provenance: true }),
    /Automatic provenance generation not supported/,
  );
  assert.equal(requests.length, 1);
  rejectWrite = true;
  await assert.rejects(
    libnpmpublish.publish(
      { ...manifest, name: "@example/unsettled-package" },
      tarball,
      { ...options, provenance: false },
    ),
    /503/,
  );
  assert.equal(requests.length, 2, "zero write retries must issue one failed request");
  process.stdout.write("synthetic publisher boundary passed\n");
} finally {
  server.stop(true);
}
