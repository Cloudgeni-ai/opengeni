import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanaryReceiptStore } from "../canary-publication-receipts";
import {
  canaryCohortHandoff,
  freezeCanaryCohort,
  parseCanaryCohort,
  publishPreparedCanaries,
  readRegistryPackage,
} from "../publish-canary";

// Run the bundled production orchestration under native Node, not bun:test.
// Only registry I/O is synthetic. Never inherit credentials or make live calls.
assert.equal(process.versions.bun, undefined);
assert.equal(process.env.GITHUB_ACTIONS, undefined);
assert.equal(process.env.NODE_AUTH_TOKEN, undefined);
Object.defineProperty(globalThis, "fetch", {
  value: async () => { throw new Error("Unexpected live registry request"); },
});

const root = mkdtempSync(join(tmpdir(), "canary-node-cohort-"));
const version = "1.0.1-canary.4";
const names = ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode", "@opengeni/ogtool"];
const identity = { source: "a".repeat(40), workflowSource: "a".repeat(40), runId: "1234", attempt: "1" };
try {
  const directory = join(root, "receipts");
  const custody = new CanaryReceiptStore(directory, identity);
  const cohort = freezeCanaryCohort(names.map(name => ({
    name, version, previousLatest: "1.0.0",
    manifest: { name, version, publishConfig: { access: "public", provenance: true } },
    packed: Buffer.from(`synthetic-archive-${name}`),
  })), custody);
  let writes = 0;
  await publishPreparedCanaries(cohort, custody, "synthetic-token", (name, _request, _base, options) => {
    assert.equal(options?.receiptVersion, undefined, "the publish job never waits for visibility");
    return readRegistryPackage(name, async (_url, init) => {
      assert.equal(init?.method, "GET");
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ "dist-tags": { latest: "1.0.0" }, versions: {} });
    }, "https://registry.example.test", options);
  }, async (manifest, packed, options) => {
    assert.equal(manifest.name, cohort[writes]!.name);
    assert.deepEqual(packed, cohort[writes]!.packed);
    assert.deepEqual(options.retry, { retries: 0 });
    writes++;
    return { ok: true, status: 202, transparencyLogUrl: "https://search.sigstore.dev/?logIndex=7" };
  });
  assert.equal(writes, cohort.length);
  const handoff = canaryCohortHandoff(cohort, identity);
  assert.ok(!handoff.includes("\n"), "the job output is one line");
  assert.deepEqual(
    parseCanaryCohort(handoff, identity).packages.map(pkg => [pkg.name, pkg.version, pkg.integrity]),
    cohort.map(pkg => [pkg.name, pkg.version, pkg.integrity]),
  );
  const events = readdirSync(directory).filter(file => file.endsWith(".json")).sort()
    .map(file => JSON.parse(readFileSync(join(directory, file), "utf8")));
  assert.equal(events.filter(event => event.kind === "WRITE_ACKNOWLEDGED").length, 4);
  assert.equal(events.filter(event => event.kind === "WRITE_UNKNOWN").length, 0);
  assert.equal(events.filter(event => event.kind === "WRITE_PHASE_COMPLETE").length, 1);
  console.log("native Node publication and cohort handoff passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
