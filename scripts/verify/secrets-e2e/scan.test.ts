import { describe, expect, test } from "bun:test";

import {
  type Needle,
  isAllowed,
  maybeDecompress,
  needlesFor,
  parseAllowRule,
  scanBuffer,
  scrubKnownValues,
} from "./scan";

const VALUE = "OGCANARY-1f0e6c1e-6a3b-4f7e-9d2c-5b8a7e3c1d00";
const needles: Needle[] = needlesFor([{ label: "Canary", value: VALUE }]);

describe("known-value scanning", () => {
  test("finds raw, JSON-escaped, URL, base64 and hex encodings with counts", () => {
    const quoted = 'pa"ss/word+1=ok';
    const quotedNeedles = needlesFor([{ label: "Quoted", value: quoted }]);
    const text = [
      `raw ${VALUE} and ${VALUE}`,
      JSON.stringify({ value: quoted }),
      `q=${encodeURIComponent(quoted)}`,
      Buffer.from(VALUE).toString("base64"),
      Buffer.from(VALUE).toString("hex"),
    ].join("\n");
    const hits = scanBuffer("mem", text, [...needles, ...quotedNeedles]);
    const summary = Object.fromEntries(
      hits.map((hit) => [`${hit.label}/${hit.encoding}`, hit.count]),
    );
    expect(summary["Canary/raw"]).toBe(2);
    expect(summary["Canary/base64"]).toBe(1);
    expect(summary["Canary/hex"]).toBe(1);
    expect(summary["Quoted/json"]).toBe(1);
    expect(summary["Quoted/url"]).toBe(1);
  });

  test("hits never carry the value", () => {
    const hits = scanBuffer("mem", `x${VALUE}x`, needles);
    expect(JSON.stringify(hits)).not.toContain(VALUE);
  });

  test("rejects values too short to scan reliably", () => {
    expect(() => needlesFor([{ label: "short", value: "abc" }])).toThrow();
  });

  test("decompresses gzip and zstd before scanning", () => {
    const data = Buffer.from(`snapshot ${VALUE}`);
    const gz = Buffer.from(Bun.gzipSync(new Uint8Array(data)));
    const zst = Buffer.from(Bun.zstdCompressSync(new Uint8Array(data)));
    expect(scanBuffer("gz", maybeDecompress(gz), needles)).toHaveLength(1);
    expect(scanBuffer("zst", maybeDecompress(zst), needles)).toHaveLength(1);
  });

  test("scrubs evidence text and counts replacements", () => {
    const scrubbed = scrubKnownValues(`a ${VALUE} b ${VALUE}`, needles);
    expect(scrubbed.hits).toBe(2);
    expect(scrubbed.text).not.toContain(VALUE);
    expect(scrubbed.text).toContain("[[known-value:Canary:raw]]");
  });

  test("allow rules match by label and location", () => {
    const rule = parseAllowRule("Save Canary=^db:opengeni/public\\.session_events\\.");
    const hit = {
      location: "db:opengeni/public.session_events.payload",
      label: "Save Canary",
      encoding: "raw",
      count: 1,
    };
    expect(isAllowed(hit, [rule])).toBe(rule);
    expect(isAllowed({ ...hit, label: "Canary" }, [rule])).toBeUndefined();
    expect(isAllowed({ ...hit, location: "log:/tmp/x.log" }, [rule])).toBeUndefined();
  });
});
