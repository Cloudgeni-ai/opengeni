// Run after this standalone app's own frozen install, which the root workspace
// does not install. Check the actual CommonJS boundary used by Expo Router.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const query = require("query-string") as {
  parseUrl(url: string): { url: string; query: Record<string, unknown> };
  stringifyUrl(url: { url: string; query: Record<string, unknown> }): string;
};
assert.ok(
  readFileSync(require.resolve("query-string"), "utf8").includes(
    "require('decode-uri-component').default",
  ),
);
const url = "opengeni://session/42?title=caf%C3%A9+%F0%9F%98%80&bad=%E0%A4%A&bad=%zz";
const result = query.parseUrl(url);
assert.equal(result.url, "opengeni://session/42");
assert.equal(result.query.title, "café 😀");
assert.deepEqual(result.query.bad, ["%E0%A4%A", "%zz"]);
assert.deepEqual(query.parseUrl(query.stringifyUrl(result)), result);

// GHSA-qr28-fpjm-wq7f: the old decoder rescans the whole string for each run.
const runs = Array.from({ length: 32_000 }, (_, index) => {
  const high = Math.floor(index / 256)
    .toString(16)
    .padStart(2, "0");
  const low = (index % 256).toString(16).padStart(2, "0");
  return `%${high}%${low}x`;
}).join("");
const start = performance.now();
const crafted = query.parseUrl(`opengeni://session/42?value=${runs}%zz`);
assert.equal(typeof crafted.query.value, "string");
assert.ok((crafted.query.value as string).endsWith("%zz"));
assert.ok(performance.now() - start < 5_000, "malformed URI decoding exceeded five seconds");
console.log("Mobile URI decoding: Unicode, malformed input, round-trip and 224 KB attack passed.");
