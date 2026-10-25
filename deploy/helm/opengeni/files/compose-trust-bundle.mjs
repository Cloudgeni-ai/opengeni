import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID, X509Certificate } from "node:crypto";

// Executed once by an init container, before Bun reads NODE_EXTRA_CA_CERTS.
// No network, credentials, recurring process, or modification of source mounts.
const [destination, ...sources] = process.argv.slice(1);
if (!destination || sources.length < 2) throw new Error("CA bundle inputs are required");
const certificates = [];
let bytes = 0;
for (const source of sources) {
  if (statSync(source).size > 1_048_576 - bytes) throw new Error("CA bundle input is too large");
  const content = readFileSync(source, "utf8");
  bytes += Buffer.byteLength(content);
  if (bytes > 1_048_576) throw new Error("CA bundle input is too large");
  const blocks =
    content.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (
    !blocks.length ||
    content.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()
  ) {
    throw new Error("CA bundle input must contain only PEM certificates");
  }
  for (const block of blocks) {
    if (!new X509Certificate(block).ca) throw new Error("CA bundle contains a non-CA certificate");
    certificates.push(block);
  }
}
// Write only after every input validates; a bad input prevents application start.
const temporary = `${destination}.${randomUUID()}.tmp`;
try {
  writeFileSync(temporary, `${certificates.join("\n")}\n`, { mode: 0o444, flag: "wx" });
  renameSync(temporary, destination);
} finally {
  rmSync(temporary, { force: true });
}
