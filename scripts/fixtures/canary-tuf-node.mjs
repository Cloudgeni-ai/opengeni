import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Exercise the real pinned verifier and bundled Sigstore trust root, offline.
// No mocked crypto, OIDC identity, registry, custom trust root, or threshold.
assert.equal(process.versions.bun, undefined, "publisher verifier must run under native Node");
const require = createRequire(import.meta.url);
const sigstoreRequire = createRequire(require.resolve("sigstore"));
const tufEntry = sigstoreRequire.resolve("@sigstore/tuf");
const tufRequire = createRequire(tufEntry);
const { TrustedMetadataStore } = require(join(dirname(tufRequire.resolve("tuf-js")), "store.js"));
const seeds = JSON.parse(readFileSync(join(dirname(tufEntry), "../seeds.json"), "utf8"));
const bytes = Buffer.from(seeds["https://tuf-repo-cdn.sigstore.dev"]["root.json"], "base64");
const store = new TrustedMetadataStore(bytes);
assert.ok(store.root.signed.version > 0);
const changed = JSON.parse(bytes.toString());
changed.signed.version++;
assert.throws(() => new TrustedMetadataStore(Buffer.from(JSON.stringify(changed))), /root was signed by 0\//);
console.log("real Sigstore TUF bootstrap verified; tampered root refused");
