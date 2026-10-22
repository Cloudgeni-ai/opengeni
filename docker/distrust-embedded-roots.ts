// Distrust root certificates compiled into the Bun and Node executables we ship.
//
// Bun and Node trust a root list built into the executable, independently of the
// operating system store. Bun keeps it as DER, Node as PEM text; for Bun's fetch
// neither --use-openssl-ca nor tls.setDefaultCACertificates removes those roots.
// In October 2026 the keys of eight eMudhra intermediate CAs chaining to emSign
// roots were exposed. Bun dropped the four emSign roots upstream
// (oven-sh/bun#46159, first released in 1.4.4). Until every image runs releases
// without them, this step makes the four roots unusable in place: inside each
// exact certificate it rewrites the "emSign" name bytes to "xxSign" (same length,
// still valid DER; PEM is re-encoded with its original line breaks), so no issued
// chain can name them as its issuer any more. Nothing else in the file changes.
//
// Usage: bun docker/distrust-embedded-roots.ts [--check] <roots.pem> <binary>...
// --check changes nothing and fails if a binary still embeds a distrusted root.
// Each binary is a Bun or Node executable or a `bun build --compile` output, for
// any architecture: only the certificate bytes are touched, so a foreign
// architecture's executable is patched without running it. Idempotent; a binary
// that does not embed the roots passes unchanged. The step fails when a root is
// found more than once. A patched `bun` or `node` for this machine's
// architecture is also asked which roots it trusts.
import { createHash } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

// SHA-256 fingerprints of the distrusted roots, as published by Mozilla.
const DISTRUSTED = new Map([
  ["bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3", "emSign ECC Root CA - C3"],
  ["86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b", "emSign ECC Root CA - G3"],
  ["125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f", "emSign Root CA - C1"],
  ["40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367", "emSign Root CA - G1"],
]);

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const [rootsPath, ...binaryPaths] = checkOnly ? args.slice(1) : args;
if (!rootsPath || binaryPaths.length === 0) {
  throw new Error("usage: distrust-embedded-roots.ts [--check] <roots.pem> <binary>...");
}

const PEM = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g;
const ders = [...readFileSync(rootsPath, "utf8").matchAll(PEM)].map((match) =>
  Buffer.from(match[1]!.replace(/\s+/g, ""), "base64"),
);
const fingerprints = ders.map((der) => createHash("sha256").update(der).digest("hex"));
if (
  ders.length !== DISTRUSTED.size ||
  fingerprints.some((fingerprint) => !DISTRUSTED.has(fingerprint))
) {
  throw new Error(`${rootsPath} must hold exactly the ${DISTRUSTED.size} pinned roots`);
}

// One embedded copy of a root: where it sits and how to write a certificate there.
type Site = { at: number; trusted: boolean; encode: (der: Buffer) => Buffer };

function indexes(haystack: Buffer, needle: Buffer): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

function sites(binary: Buffer, der: Buffer, distrusted: Buffer): Site[] {
  const found: Site[] = [];
  for (const [form, trusted] of [
    [der, true],
    [distrusted, false],
  ] as const) {
    for (const at of indexes(binary, form)) found.push({ at, trusted, encode: (next) => next });
  }
  // PEM text: both forms share a leading run of base64 (the name comes later).
  const base64 = der.toString("base64");
  const prefix = Buffer.from(base64.slice(0, 32));
  if (!distrusted.toString("base64").startsWith(prefix.toString())) {
    throw new Error("distrusted root differs inside its PEM search prefix");
  }
  const end = Buffer.from("-----END CERTIFICATE-----");
  for (const at of indexes(binary, prefix)) {
    const stop = binary.indexOf(end, at);
    if (stop === -1 || stop - at > 16 * base64.length) continue;
    const text = binary.subarray(at, stop).toString("latin1");
    const compact = text.replace(/\s+/g, "");
    if (compact !== base64 && compact !== distrusted.toString("base64")) continue;
    found.push({
      at,
      trusted: compact === base64,
      encode: (next) => {
        // Keep the original line breaks; base64 of a same-length DER has the same length.
        const characters = next.toString("base64")[Symbol.iterator]();
        return Buffer.from(
          text.replace(/\S/g, () => characters.next().value!),
          "latin1",
        );
      },
    });
  }
  return found;
}

// ELF e_machine values for the architectures Opengeni images are built for.
const ELF_MACHINE: Record<string, number> = { x64: 0x3e, arm64: 0xb7 };

// Only a plain runtime named `bun` or `node` is run: a compiled program would
// start itself.
function isRuntimeForThisMachine(path: string, binary: Buffer): boolean {
  return (
    ["bun", "node"].includes(basename(path)) &&
    binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    binary.readUInt16LE(18) === ELF_MACHINE[process.arch]
  );
}

for (const binaryPath of binaryPaths) {
  const binary = readFileSync(binaryPath);
  let changed = 0;
  for (const [index, der] of ders.entries()) {
    const name = DISTRUSTED.get(fingerprints[index]!)!;
    const distrusted = Buffer.from(der.toString("latin1").replaceAll("emSign", "xxSign"), "latin1");
    const found = sites(binary, der, distrusted);
    const trusted = found.filter((site) => site.trusted);
    const done = found.length - trusted.length;
    if (checkOnly && trusted.length > 0) {
      throw new Error(`${binaryPath} still embeds ${name}`);
    } else if (trusted.length === 1 && done === 0) {
      const [site] = trusted;
      site!.encode(distrusted).copy(binary, site!.at);
      changed += 1;
      console.log(`${binaryPath}: distrusted ${name}`);
    } else if (trusted.length === 0 && done <= 1) {
      console.log(`${binaryPath}: ${name} ${done === 1 ? "already distrusted" : "not embedded"}`);
    } else {
      throw new Error(
        `${binaryPath}: ${name} has ${trusted.length} trusted and ${done} distrusted copies`,
      );
    }
    if (sites(binary, der, distrusted).some((site) => site.trusted)) {
      throw new Error(`${binaryPath} still embeds ${name}`);
    }
  }

  if (changed > 0) {
    // Replace the file by rename: the binary may be the one running this script.
    const target = realpathSync(binaryPath);
    const temporary = `${target}.distrust-${process.pid}`;
    writeFileSync(temporary, binary);
    chmodSync(temporary, statSync(target).mode & 0o7777);
    renameSync(temporary, target);
  }

  if (!isRuntimeForThisMachine(binaryPath, binary)) continue;
  // Ask the resulting runtime itself which roots it trusts.
  const check = spawnSync(
    binaryPath,
    [
      "-e",
      `const { X509Certificate } = require("node:crypto");
       const tls = require("node:tls");
       const trusted = tls.rootCertificates.filter((pem) => new X509Certificate(pem).subject.includes("emSign"));
       console.log(trusted.length);`,
    ],
    { encoding: "utf8" },
  );
  if (check.status !== 0 || check.stdout.trim() !== "0") {
    throw new Error(`${binaryPath} still trusts emSign roots: ${check.stdout}${check.stderr}`);
  }
  console.log(`${binaryPath}: no emSign root is trusted`);
}
