#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { deploymentImageDigests, validateReleaseCandidateReceipt } from "./release-candidate";
import {
  buildReleaseProducerMetadata,
  validateReleaseProducerMetadata,
  validateTrustedReleaseArtifact,
  type ReleaseProducerMetadata,
  type TrustedReleaseArtifact,
} from "./release-provenance";
import {
  validateWorkbenchAcceptanceBundle,
  type AcceptanceBundleExpectations,
  type WorkbenchAcceptanceBundle,
} from "./verify-workbench-acceptance-bundle";

const shaPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;

type CandidateProvenance = {
  producer: ReleaseProducerMetadata;
  artifact: TrustedReleaseArtifact;
};

type Validator = (
  value: unknown,
  expected: AcceptanceBundleExpectations,
) => WorkbenchAcceptanceBundle;

export function assembleReleaseAcceptance(input: {
  operatorBundle: unknown;
  sourceSha: string;
  candidateReceipt: unknown;
  candidateReceiptSha256: string;
  candidateProvenance: unknown;
  acceptanceRunId: number | string;
  acceptanceRunAttempt: number | string;
  validate?: Validator;
}): WorkbenchAcceptanceBundle {
  if (!shaPattern.test(input.sourceSha)) {
    throw new Error("acceptance source SHA must be 40 lowercase hexadecimal characters");
  }
  if (!hashPattern.test(input.candidateReceiptSha256)) {
    throw new Error("candidate receipt SHA-256 must be lowercase hexadecimal");
  }
  const provenance = candidateProvenance(input.candidateProvenance, input.sourceSha);
  const receipt = validateReleaseCandidateReceipt(input.candidateReceipt, {
    sourceSha: input.sourceSha,
    sourceTreeSha: provenance.producer.sourceTreeSha,
    producer: provenance.producer,
  });
  const acceptanceProducer = buildReleaseProducerMetadata({
    kind: "acceptance",
    runId: input.acceptanceRunId,
    runAttempt: input.acceptanceRunAttempt,
    sourceSha: input.sourceSha,
    sourceTreeSha: receipt.sourceTreeSha,
  });
  const bundle = cloneRecord(input.operatorBundle, "operator acceptance bundle");
  bundle.producer = acceptanceProducer;
  bundle.candidate = {
    sourceSha: receipt.sourceSha,
    sourceTreeSha: receipt.sourceTreeSha,
    imageDigests: deploymentImageDigests(receipt),
    chart: receipt.chart,
    producer: provenance.producer,
    receipt: {
      url: provenance.artifact.url,
      sha256: input.candidateReceiptSha256,
      artifact: "release-candidate.json",
    },
  };
  return (input.validate ?? validateWorkbenchAcceptanceBundle)(bundle, {
    sourceSha: input.sourceSha,
    candidateReceipt: receipt,
    candidateProducer: provenance.producer,
    acceptanceProducer,
    candidateReceiptUrl: provenance.artifact.url,
    candidateReceiptSha256: input.candidateReceiptSha256,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [operatorRaw, candidateRaw, provenanceRaw] = await Promise.all([
    boundedRead(args.operatorBundle, 20 * 1024 * 1024, "operator acceptance bundle"),
    boundedRead(args.candidateReceipt, 1024 * 1024, "candidate receipt"),
    boundedRead(args.candidateProvenance, 1024 * 1024, "candidate provenance"),
  ]);
  const actualCandidateHash = createHash("sha256").update(candidateRaw).digest("hex");
  if (actualCandidateHash !== args.candidateReceiptSha256) {
    throw new Error("candidate receipt SHA-256 does not match its downloaded bytes");
  }
  const bundle = assembleReleaseAcceptance({
    operatorBundle: parseJson(operatorRaw, "operator acceptance bundle"),
    sourceSha: args.sourceSha,
    candidateReceipt: parseJson(candidateRaw, "candidate receipt"),
    candidateReceiptSha256: args.candidateReceiptSha256,
    candidateProvenance: parseJson(provenanceRaw, "candidate provenance"),
    acceptanceRunId: args.acceptanceRunId,
    acceptanceRunAttempt: args.acceptanceRunAttempt,
  });
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  const sha256 = createHash("sha256").update(serialized).digest("hex");
  const output = resolve(args.output);
  const shaOutput = resolve(args.shaOutput);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(shaOutput), { recursive: true });
  await writeFile(output, serialized, { mode: 0o600 });
  await writeFile(shaOutput, `${sha256}  workbench-acceptance.json\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, output, sha256 }));
}

function candidateProvenance(value: unknown, sourceSha: string): CandidateProvenance {
  const item = record(value, "candidate provenance");
  const producer = validateReleaseProducerMetadata(item.producer, {
    kind: "candidate",
    sourceSha,
  });
  const artifact = validateTrustedReleaseArtifact(item.artifact, {
    kind: "candidate",
    sourceSha,
    runId: producer.runId,
  });
  return { producer, artifact };
}

function cloneRecord(value: unknown, label: string): Record<string, unknown> {
  const item = record(value, label);
  return structuredClone(item);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function boundedRead(path: string, maximum: number, label: string): Promise<string> {
  const value = await readFile(resolve(path), "utf8");
  if (Buffer.byteLength(value) > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  return value;
}

function parseArgs(values: string[]): {
  operatorBundle: string;
  candidateReceipt: string;
  candidateProvenance: string;
  candidateReceiptSha256: string;
  sourceSha: string;
  acceptanceRunId: string;
  acceptanceRunAttempt: string;
  output: string;
  shaOutput: string;
} {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${flag ?? "<missing>"}`);
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (parsed.has(flag)) throw new Error(`${flag} may be supplied only once`);
    parsed.set(flag, value);
  }
  const allowed = new Set([
    "--operator-bundle",
    "--candidate-receipt",
    "--candidate-provenance",
    "--candidate-receipt-sha256",
    "--source-sha",
    "--acceptance-run-id",
    "--acceptance-run-attempt",
    "--output",
    "--sha-output",
  ]);
  for (const flag of parsed.keys()) {
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
  }
  const required = (flag: string) => {
    const value = parsed.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  return {
    operatorBundle: required("--operator-bundle"),
    candidateReceipt: required("--candidate-receipt"),
    candidateProvenance: required("--candidate-provenance"),
    candidateReceiptSha256: required("--candidate-receipt-sha256"),
    sourceSha: required("--source-sha"),
    acceptanceRunId: required("--acceptance-run-id"),
    acceptanceRunAttempt: required("--acceptance-run-attempt"),
    output: required("--output"),
    shaOutput: required("--sha-output"),
  };
}

if (import.meta.main) await main();
