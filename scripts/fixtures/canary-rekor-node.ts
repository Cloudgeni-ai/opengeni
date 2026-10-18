import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { attest } from "sigstore";
import { signCanarySource } from "../canary-source-provenance";

// Real pinned Sigstore Rekor transport, local synthetic responses only. This
// fixture does not claim cryptographic validity; the separate native TUF test
// and official verify-before-PUT path retain that boundary.
assert.equal(process.versions.bun, undefined);
assert.equal(process.env.GITHUB_ACTIONS, undefined);
assert.equal(process.env.NODE_AUTH_TOKEN, undefined);
const require = createRequire(import.meta.url);
const sigstoreRequire = createRequire(require.resolve("sigstore"));
const { TLogClient } = require(join(dirname(sigstoreRequire.resolve("@sigstore/sign")), "witness/tlog/client.js"));
const root = mkdtempSync(join(tmpdir(), "canary-rekor-node-"));
let posts = 0;
const server = createServer((request, response) => {
  assert.equal(request.url, "/api/v1/log/entries");
  assert.equal(request.method, "POST");
  request.resume();
  request.on("end", () => {
    posts++;
    if (posts === 1) {
      // Simulate a committed append whose 201 response is cut off after headers.
      response.writeHead(201, { "content-type": "application/json", "content-length": "1000" });
      response.write('{"entry":');
      setTimeout(() => response.destroy(), 25);
    } else {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ entry: { logIndex: 7 } }));
    }
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new TLogClient({
    rekorBaseURL: `http://127.0.0.1:${address.port}`, retry: { retries: 0 }, timeout: 2_000,
  });
  const payloads: Buffer[] = [];
  let transient: unknown;
  const sign = (async (payload, type) => {
    payloads.push(Buffer.from(payload));
    let entry;
    try {
      entry = await client.createEntry({ synthetic: true });
    } catch (error) {
      transient = error;
      throw error;
    }
    return { dsseEnvelope: { payload: payload.toString("base64"), payloadType: type },
      verificationMaterial: { tlogEntries: [{ logIndex: String(entry.logIndex) }] } };
  }) as typeof attest;
  const env = {
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "Cloudgeni-ai/opengeni",
    GITHUB_SERVER_URL: "https://github.com", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_SHA: "b".repeat(40), SOURCE_SHA: "a".repeat(40), GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "1",
    RUNNER_ENVIRONMENT: "github-hosted", GITHUB_WORKFLOW_REF: "Cloudgeni-ai/opengeni/.github/workflows/publish-canary.yml@refs/heads/main",
  };
  const started = performance.now();
  const supplied = await signCanarySource({ name: "@opengeni/sdk", version: "1.0.2-canary.1234001" },
    Buffer.from("synthetic archive"), root, env, sign); // Real native default sleep.
  assert.ok(transient && typeof transient === "object" && "code" in transient && transient.code === "TLOG_CREATE_ENTRY_ERROR");
  assert.ok("cause" in transient && transient.cause && typeof transient.cause === "object" && "code" in transient.cause);
  assert.equal(transient.cause.code, "ECONNRESET");
  assert.equal(posts, 2);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.ok(performance.now() - started >= 1_000);
  assert.equal(JSON.parse(readFileSync(supplied.file, "utf8")).dsseEnvelope.payload, payloads[0]!.toString("base64"));
  console.log("native Node recovered a real Rekor response-body reset; identical statement retained");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
}
