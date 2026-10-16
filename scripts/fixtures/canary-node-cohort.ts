import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanaryReceiptStore } from "../canary-publication-receipts";
import {
  freezeCanaryCohort,
  publishAndVerifyCanaryCohort,
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
try {
  for (const delayed of [false, true]) {
    const directory = join(root, delayed ? "delayed" : "immediate");
    const custody = new CanaryReceiptStore(directory, {
      source: "a".repeat(40), workflowSource: "a".repeat(40), runId: "1234", attempt: "1",
    });
    const cohort = freezeCanaryCohort(names.map(name => ({
      name, version, previousLatest: "1.0.0",
      manifest: { name, version, publishConfig: { access: "public", provenance: true } },
      packed: Buffer.from(`synthetic-archive-${name}`),
    })), custody);
    let writes = 0, pendingAt: number | undefined, resumedAt: number | undefined;
    const pins = await publishAndVerifyCanaryCohort(cohort, custody, "synthetic-token", {
      // The immediate case uses all production defaults. Bound only the delayed
      // case's deadline; neither clock nor sleep is injected in either case.
      ...(delayed ? { timeoutMs: 15_000 } : {}),
      publish: async (manifest, packed, options) => {
        assert.equal(manifest.name, cohort[writes]!.name);
        assert.deepEqual(packed, cohort[writes]!.packed);
        assert.deepEqual(options.retry, { retries: 0 });
        writes++;
        return { ok: true, status: 201, transparencyLogUrl: "https://search.sigstore.dev/?logIndex=7" };
      },
      read: (name, _request, _base, options) => {
        const pkg = cohort.find(item => item.name === name)!;
        const confirming = options?.receiptVersion !== undefined;
        if (confirming) assert.equal(writes, cohort.length, "all writes precede confirmation");
        const pending = confirming && delayed && name === names[0] && pendingAt === undefined;
        if (pending) pendingAt = performance.now();
        else if (confirming && delayed && name === names[0] && resumedAt === undefined)
          resumedAt = performance.now();
        return readRegistryPackage(name, async (url, init) => {
          assert.equal(init?.method, "GET");
          assert.ok(init?.signal instanceof AbortSignal);
          if (!confirming) return Response.json({ "dist-tags": { latest: "1.0.0" }, versions: {} });
          if (String(url).includes("/dist-tags"))
            return Response.json({ latest: "1.0.0", canary: version });
          if (pending) return new Response(null, { status: 404 });
          return Response.json({ name, version, dist: {
            integrity: pkg.integrity,
            attestations: { url: "https://registry.example.test/attestation",
              provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
          } });
        }, "https://registry.example.test", options);
      },
    });
    assert.equal(writes, cohort.length);
    assert.deepEqual(pins, Object.fromEntries(names.map(name => [name, version])));
    const events = readdirSync(directory).filter(file => file.endsWith(".json")).sort()
      .map(file => JSON.parse(readFileSync(join(directory, file), "utf8")));
    assert.equal(events.filter(event => event.kind === "WRITE_ACKNOWLEDGED").length, 4);
    assert.equal(events.filter(event => event.kind === "WRITE_UNKNOWN").length, 0);
    const matched = events.find(event => event.kind === "COHORT_READS_MATCHED");
    assert.equal(matched?.freshCompleteCohort, true);
    assert.equal(matched?.packageCount, 4);
    assert.equal(events.filter(event => event.kind === "READ_OBSERVATION" && event.phase === "final").length, 4);
    if (delayed) {
      assert.ok(pendingAt !== undefined && resumedAt !== undefined);
      assert.ok(resumedAt - pendingAt >= 900, "real default timer must wait before polling again");
      assert.ok(events.some(event => event.kind === "READ_OBSERVATION" && event.observation === "version_pending"));
    }
  }
  console.log("native Node publication and confirmation passed with default timers");
} finally {
  rmSync(root, { recursive: true, force: true });
}
