import { createHash } from "node:crypto";

const argument = process.argv[2];
const HASH = `sha256:${"1".repeat(64)}`;

if (argument === "--opengeni-materializer-identity-v1") {
  process.stdout.write(
    JSON.stringify({
      protocol: "OGAMC001",
      runtimeKind: "native",
      runtimeTarget: "fixture-native",
      maxOutputBytes: 1048576,
      kernelVersion: "fixture-kernel-1",
      codecVersions: { "opengeni.xlsx": "fixture-codec-1" },
      fontRegistryHash: HASH,
      policyHash: HASH,
      supportedModelSchemaVersions: [1],
      supportedOperationProtocolVersions: [1],
      supportedSnapshotProtocolVersions: [1],
    }),
  );
  process.exit(0);
}

const input = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
if (argument === "--opengeni-verify-materialization-v1") {
  if (new TextDecoder().decode(input.subarray(0, 8)) !== "OGAVI001") process.exit(65);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const metadataBytes = view.getUint32(8, true);
  const outputBytes = Number(view.getBigUint64(12, true));
  const metadataEnd = 20 + metadataBytes;
  if (metadataEnd + outputBytes !== input.byteLength) process.exit(66);
  const metadata = JSON.parse(new TextDecoder().decode(input.subarray(20, metadataEnd))) as {
    expectedSemanticHash: string;
  };
  if (metadata.expectedSemanticHash !== HASH) {
    writeFrame("OGAME001", { code: "output_verification_failed", protocol: "OGAMERR1" });
  } else {
    writeFrame("OGAVO001", { protocol: "OGAVR001", semanticHash: HASH });
  }
  process.exit(0);
}

if (argument !== "--opengeni-materialize-v1") process.exit(64);

if (new TextDecoder().decode(input.subarray(0, 8)) !== "OGAMI001") process.exit(65);
const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
const metadataBytes = view.getUint32(8, true);
const sourceBytes = Number(view.getBigUint64(12, true));
const metadataStart = 20;
const metadataEnd = metadataStart + metadataBytes;
if (metadataEnd + sourceBytes !== input.byteLength) process.exit(66);
const manifest = JSON.parse(new TextDecoder().decode(input.subarray(metadataStart, metadataEnd))) as {
  targetHeadSequence: number;
  stateHash: string;
  format: "xlsx";
  codecId: string;
  codecVersion: string;
  kernelVersion: string;
  fontRegistryHash: string;
  policyHash: string;
  normalizedOptions: {
    hang?: boolean;
    malformed?: "hash" | "type" | "extra" | "mime" | "codec";
  };
};
if (manifest.normalizedOptions.hang) {
  await new Promise(() => undefined);
}
const output = new TextEncoder().encode("native-codec-output");
const contentHash = `sha256:${createHash("sha256").update(output).digest("hex")}`;
const metadataValue: Record<string, unknown> = {
  protocol: "OGAMR001",
  headSequence: manifest.targetHeadSequence,
  stateHash: manifest.stateHash,
  format: manifest.format,
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  codecId: manifest.codecId,
  codecVersion: manifest.codecVersion,
  kernelVersion: manifest.kernelVersion,
  fontRegistryHash: manifest.fontRegistryHash,
  policyHash: manifest.policyHash,
  byteSize: output.byteLength,
  contentHash,
  semanticHash: HASH,
};
switch (manifest.normalizedOptions.malformed) {
  case "hash":
    metadataValue.contentHash = "not-a-hash";
    break;
  case "type":
    metadataValue.headSequence = String(manifest.targetHeadSequence);
    break;
  case "extra":
    metadataValue.untrustedExtra = true;
    break;
  case "mime":
    metadataValue.mimeType = "application/pdf";
    break;
  case "codec":
    metadataValue.codecVersion = "other-codec";
    break;
}
const metadata = new TextEncoder().encode(JSON.stringify(metadataValue));
const header = new Uint8Array(20);
header.set(new TextEncoder().encode("OGAMO001"));
const headerView = new DataView(header.buffer);
headerView.setUint32(8, metadata.byteLength, true);
headerView.setBigUint64(12, BigInt(output.byteLength), true);
process.stdout.write(header);
process.stdout.write(metadata);
process.stdout.write(output);

function writeFrame(magic: string, frameValue: Record<string, unknown>): void {
  const frameMetadata = new TextEncoder().encode(JSON.stringify(frameValue));
  const frameHeader = new Uint8Array(20);
  frameHeader.set(new TextEncoder().encode(magic));
  const frameView = new DataView(frameHeader.buffer);
  frameView.setUint32(8, frameMetadata.byteLength, true);
  frameView.setBigUint64(12, 0n, true);
  process.stdout.write(frameHeader);
  process.stdout.write(frameMetadata);
}
