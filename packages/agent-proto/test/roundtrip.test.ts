/**
 * Cross-stack protobuf round-trip test (TypeScript side).
 *
 * Proves the Rust (`prost`) and TypeScript (`ts-proto`) wire stacks, both
 * generated from the one `agent/proto/opengeni_agent.proto`, agree on the wire:
 *
 *   1. Self round-trip: every canonical message encodes and decodes back to
 *      itself (the TS codec is internally consistent).
 *   2. Cross-stack Rust → TS: decode the RUST-encoded fixture
 *      (`agent/tests/fixtures/rust_encoded.txt`) with the TS codec and assert it
 *      equals the canonical value — a Rust-encoded message decodes correctly in
 *      TS. (The TS → Rust direction is proven by the Rust test reading the
 *      TS-produced fixture.)
 *   3. Byte-equality: for the map-free messages, the bytes the TS codec produces
 *      are IDENTICAL to the bytes the Rust codec produced — the strongest form of
 *      agreement (canonical proto3 wire bytes match exactly).
 *
 * This test also WRITES the TS-encoded fixture (`ts_encoded.txt`) so the Rust
 * round-trip test can read it; the driver `agent/scripts/roundtrip.sh` sequences
 * the two so both fixtures exist.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlRequest, ControlResponse, Hello } from "../src/index";
import { canonicalControlRequest, canonicalControlResponse, canonicalHello } from "./corpus";

const here = dirname(fileURLToPath(import.meta.url));
// packages/agent-proto/test -> repo root -> agent/tests/fixtures
const fixturesDir = join(here, "..", "..", "..", "agent", "tests", "fixtures");

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Parses a `name=hex\n` fixture file into a name → bytes map. */
function loadFixture(name: string): Record<string, Uint8Array> | undefined {
  const path = join(fixturesDir, name);
  if (!existsSync(path)) return undefined;
  const body = readFileSync(path, "utf8");
  const map: Record<string, Uint8Array> = {};
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    map[line.slice(0, eq)] = fromHex(line.slice(eq + 1));
  }
  return map;
}

// Encode the canonical corpus once and persist it for the Rust test to read.
const encoded = {
  control_response: ControlResponse.encode(canonicalControlResponse()).finish(),
  control_request: ControlRequest.encode(canonicalControlRequest()).finish(),
  hello: Hello.encode(canonicalHello()).finish(),
};

mkdirSync(fixturesDir, { recursive: true });
writeFileSync(
  join(fixturesDir, "ts_encoded.txt"),
  `control_response=${toHex(encoded.control_response)}\n` +
    `control_request=${toHex(encoded.control_request)}\n` +
    `hello=${toHex(encoded.hello)}\n`,
);

describe("wire-protocol cross-stack round-trip", () => {
  test("self round-trip (TS encode -> TS decode)", () => {
    expect(ControlResponse.decode(encoded.control_response)).toEqual(canonicalControlResponse());
    expect(ControlRequest.decode(encoded.control_request)).toEqual(canonicalControlRequest());
    expect(Hello.decode(encoded.hello)).toEqual(canonicalHello());
  });

  test("cross-stack Rust -> TS decode equals canonical", () => {
    const rust = loadFixture("rust_encoded.txt");
    if (!rust) {
      throw new Error(
        "agent/tests/fixtures/rust_encoded.txt missing — run agent/scripts/roundtrip.sh",
      );
    }
    expect(ControlResponse.decode(rust.control_response!)).toEqual(canonicalControlResponse());
    expect(ControlRequest.decode(rust.control_request!)).toEqual(canonicalControlRequest());
    expect(Hello.decode(rust.hello!)).toEqual(canonicalHello());
  });

  test("byte-equality with Rust for map-free messages", () => {
    const rust = loadFixture("rust_encoded.txt");
    if (!rust) {
      throw new Error(
        "agent/tests/fixtures/rust_encoded.txt missing — run agent/scripts/roundtrip.sh",
      );
    }
    // ControlResponse and Hello have no map fields, so proto3 canonical encoding
    // is deterministic and the bytes must match exactly across the two stacks.
    expect(toHex(encoded.control_response)).toBe(toHex(rust.control_response!));
    expect(toHex(encoded.hello)).toBe(toHex(rust.hello!));
  });
});
