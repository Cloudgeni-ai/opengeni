import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseExpectedPackages, type PublishablePackage } from "./verify-release-packages";
import {
  validateReleaseProducerMetadata,
  type ReleaseProducerMetadata,
} from "./release-provenance";

export const RELEASE_IMAGE_ROLES = ["api", "worker", "web", "relay", "sandbox"] as const;
export type ReleaseImageRole = (typeof RELEASE_IMAGE_ROLES)[number];

export const RELEASE_IMAGE_NAMES: Record<ReleaseImageRole, string> = {
  api: "ghcr.io/cloudgeni-ai/opengeni-api",
  worker: "ghcr.io/cloudgeni-ai/opengeni-worker",
  web: "ghcr.io/cloudgeni-ai/opengeni-web",
  relay: "ghcr.io/cloudgeni-ai/opengeni-relay",
  sandbox: "ghcr.io/cloudgeni-ai/opengeni-sandbox",
};

export type ReleaseCandidateImage = {
  name: string;
  digest: string;
};

export type ReleaseChartCandidate = {
  version: string;
  bytesSha256: string;
  artifact: string;
};

export type ReleaseChartIdentity = ReleaseChartCandidate & {
  reference: "oci://ghcr.io/cloudgeni-ai/charts/opengeni";
  manifestDigest: string;
};

export type ReleaseCandidateReceipt = {
  schemaVersion: 2;
  sourceSha: string;
  sourceTreeSha: string;
  releaseVersion: string;
  packages: PublishablePackage[];
  images: Record<ReleaseImageRole, ReleaseCandidateImage>;
  chart: ReleaseChartCandidate;
  producer: ReleaseProducerMetadata;
  aliases: {
    migration: "api";
  };
};

const sourceShaPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const hashPattern = /^[0-9a-f]{64}$/;

export function buildReleaseCandidateReceipt(input: {
  sourceSha: string;
  sourceTreeSha: string;
  packages: PublishablePackage[];
  imageDigests: Record<ReleaseImageRole, string>;
  chart: ReleaseChartCandidate;
  producer: ReleaseProducerMetadata;
}): ReleaseCandidateReceipt {
  if (!sourceShaPattern.test(input.sourceSha)) {
    throw new Error("release candidate sourceSha must be 40 lowercase hexadecimal characters");
  }
  if (!sourceShaPattern.test(input.sourceTreeSha)) {
    throw new Error("release candidate sourceTreeSha must be 40 lowercase hexadecimal characters");
  }
  if (input.producer.sourceSha !== input.sourceSha) {
    throw new Error("release candidate producer sourceSha must equal sourceSha");
  }
  if (input.producer.sourceTreeSha !== input.sourceTreeSha) {
    throw new Error("release candidate producer sourceTreeSha must equal sourceTreeSha");
  }
  const chart = normalizeChart(input.chart);
  const releaseVersion = chart.version;
  const packages = normalizePackages(input.packages);
  const images = {} as Record<ReleaseImageRole, ReleaseCandidateImage>;
  for (const role of RELEASE_IMAGE_ROLES) {
    const digest = input.imageDigests[role];
    if (!digestPattern.test(digest)) {
      throw new Error(`release candidate ${role} digest must be an exact sha256 digest`);
    }
    images[role] = { name: RELEASE_IMAGE_NAMES[role], digest };
  }

  return {
    schemaVersion: 2,
    sourceSha: input.sourceSha,
    sourceTreeSha: input.sourceTreeSha,
    releaseVersion,
    packages,
    images,
    chart,
    producer: validateReleaseProducerMetadata(input.producer, {
      kind: "candidate",
      sourceSha: input.sourceSha,
      sourceTreeSha: input.sourceTreeSha,
    }),
    aliases: { migration: "api" },
  };
}

export function validateReleaseCandidateReceipt(
  value: unknown,
  expected?: {
    sourceSha?: string;
    sourceTreeSha?: string;
    packages?: PublishablePackage[];
    producer?: ReleaseProducerMetadata;
  },
): ReleaseCandidateReceipt {
  const receipt = object(value, "release candidate receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "sourceSha",
      "sourceTreeSha",
      "releaseVersion",
      "packages",
      "images",
      "chart",
      "producer",
      "aliases",
    ],
    "release candidate receipt",
  );
  if (receipt.schemaVersion !== 2) {
    throw new Error("release candidate receipt schemaVersion must be 2");
  }
  if (typeof receipt.sourceSha !== "string" || !sourceShaPattern.test(receipt.sourceSha)) {
    throw new Error("release candidate sourceSha must be 40 lowercase hexadecimal characters");
  }
  if (typeof receipt.sourceTreeSha !== "string" || !sourceShaPattern.test(receipt.sourceTreeSha)) {
    throw new Error("release candidate sourceTreeSha must be 40 lowercase hexadecimal characters");
  }
  if (typeof receipt.releaseVersion !== "string" || !versionPattern.test(receipt.releaseVersion)) {
    throw new Error("release candidate releaseVersion must be an exact semver version");
  }

  const packages = normalizePackages(receipt.packages);

  const rawImages = object(receipt.images, "release candidate images");
  exactKeys(rawImages, RELEASE_IMAGE_ROLES, "release candidate images");
  const imageDigests = {} as Record<ReleaseImageRole, string>;
  for (const role of RELEASE_IMAGE_ROLES) {
    const image = object(rawImages[role], `release candidate image ${role}`);
    exactKeys(image, ["name", "digest"], `release candidate image ${role}`);
    if (image.name !== RELEASE_IMAGE_NAMES[role]) {
      throw new Error(`release candidate ${role} image must be ${RELEASE_IMAGE_NAMES[role]}`);
    }
    if (typeof image.digest !== "string" || !digestPattern.test(image.digest)) {
      throw new Error(`release candidate ${role} digest must be an exact sha256 digest`);
    }
    imageDigests[role] = image.digest;
  }

  const chart = normalizeChart(receipt.chart);
  if (chart.version !== receipt.releaseVersion) {
    throw new Error("release candidate chart version must equal releaseVersion");
  }
  const producer = validateReleaseProducerMetadata(receipt.producer, {
    kind: "candidate",
    sourceSha: receipt.sourceSha,
    sourceTreeSha: receipt.sourceTreeSha,
  });

  const aliases = object(receipt.aliases, "release candidate aliases");
  exactKeys(aliases, ["migration"], "release candidate aliases");
  if (aliases.migration !== "api") {
    throw new Error("release candidate migration image must alias the API image");
  }

  if (expected?.sourceSha && receipt.sourceSha !== expected.sourceSha) {
    throw new Error(
      `release candidate sourceSha ${receipt.sourceSha} does not match ${expected.sourceSha}`,
    );
  }
  if (expected?.sourceTreeSha && receipt.sourceTreeSha !== expected.sourceTreeSha) {
    throw new Error(
      `release candidate sourceTreeSha ${receipt.sourceTreeSha} does not match ${expected.sourceTreeSha}`,
    );
  }
  if (expected?.producer && JSON.stringify(producer) !== JSON.stringify(expected.producer)) {
    throw new Error("release candidate producer provenance does not match the trusted run");
  }
  if (expected?.packages) {
    const expectedPackages = normalizePackages(expected.packages);
    if (JSON.stringify(packages) !== JSON.stringify(expectedPackages)) {
      throw new Error("release candidate package plan does not match expected_packages");
    }
  }

  return buildReleaseCandidateReceipt({
    sourceSha: receipt.sourceSha,
    sourceTreeSha: receipt.sourceTreeSha,
    packages,
    imageDigests,
    chart,
    producer,
  });
}

export function deploymentImageDigests(
  receipt: ReleaseCandidateReceipt,
): Record<ReleaseImageRole | "migration", string> {
  return {
    api: receipt.images.api.digest,
    migration: receipt.images.api.digest,
    worker: receipt.images.worker.digest,
    web: receipt.images.web.digest,
    relay: receipt.images.relay.digest,
    sandbox: receipt.images.sandbox.digest,
  };
}

export function releaseBomImages(receipt: ReleaseCandidateReceipt): ReleaseCandidateImage[] {
  return RELEASE_IMAGE_ROLES.map((role) => receipt.images[role]);
}

function normalizePackages(value: unknown): PublishablePackage[] {
  if (!Array.isArray(value)) {
    throw new Error("release candidate packages must be an array");
  }
  const specs = value.map((item, index) => {
    const pkg = object(item, `release candidate packages[${index}]`);
    exactKeys(pkg, ["name", "version"], `release candidate packages[${index}]`);
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
      throw new Error(`release candidate packages[${index}] must contain name and version`);
    }
    return `${pkg.name}@${pkg.version}`;
  });
  return parseExpectedPackages(specs.join(",")).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function normalizeChart(value: unknown): ReleaseChartCandidate {
  const chart = object(value, "release candidate chart");
  exactKeys(chart, ["version", "bytesSha256", "artifact"], "release candidate chart");
  if (typeof chart.version !== "string" || !versionPattern.test(chart.version)) {
    throw new Error("release candidate chart version must be an exact semver version");
  }
  if (typeof chart.bytesSha256 !== "string" || !hashPattern.test(chart.bytesSha256)) {
    throw new Error("release candidate chart bytesSha256 must be lowercase SHA-256");
  }
  if (typeof chart.artifact !== "string" || chart.artifact !== `opengeni-${chart.version}.tgz`) {
    throw new Error("release candidate chart artifact must match its version");
  }
  return {
    version: chart.version,
    bytesSha256: chart.bytesSha256,
    artifact: chart.artifact,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} must contain exactly: ${canonical.join(", ")}`);
  }
}

function parseJson<T>(label: string, value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

async function writeReceiptFromEnvironment(): Promise<void> {
  const receipt = buildReleaseCandidateReceipt({
    sourceSha: process.env.OPENGENI_RELEASE_CANDIDATE_SOURCE_SHA ?? "",
    sourceTreeSha: process.env.OPENGENI_RELEASE_CANDIDATE_SOURCE_TREE_SHA ?? "",
    packages: parseJson<PublishablePackage[]>(
      "OPENGENI_RELEASE_CANDIDATE_PACKAGES",
      process.env.OPENGENI_RELEASE_CANDIDATE_PACKAGES ?? "",
    ),
    imageDigests: parseJson<Record<ReleaseImageRole, string>>(
      "OPENGENI_RELEASE_CANDIDATE_IMAGE_DIGESTS",
      process.env.OPENGENI_RELEASE_CANDIDATE_IMAGE_DIGESTS ?? "",
    ),
    chart: parseJson<ReleaseChartCandidate>(
      "OPENGENI_RELEASE_CANDIDATE_CHART",
      process.env.OPENGENI_RELEASE_CANDIDATE_CHART ?? "",
    ),
    producer: parseJson<ReleaseProducerMetadata>(
      "OPENGENI_RELEASE_CANDIDATE_PRODUCER",
      process.env.OPENGENI_RELEASE_CANDIDATE_PRODUCER ?? "",
    ),
  });
  const outputPath = resolve(
    import.meta.dir,
    "..",
    process.env.OPENGENI_RELEASE_CANDIDATE_PATH ?? "evidence/release-candidate.json",
  );
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  const sha256 = createHash("sha256").update(serialized).digest("hex");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `sha256=${sha256}\n`, "utf8");
  }
  console.log(JSON.stringify({ path: outputPath, sha256, receipt }));
}

async function verifyReceiptFile(args: {
  path: string;
  sourceSha: string;
  expectedPackages: string;
}): Promise<void> {
  const raw = await readFile(resolve(args.path), "utf8");
  if (raw.length > 1024 * 1024) {
    throw new Error("release candidate receipt exceeds 1 MiB");
  }
  const receipt = validateReleaseCandidateReceipt(
    parseJson<unknown>("release candidate receipt", raw),
    {
      sourceSha: args.sourceSha,
      packages: parseExpectedPackages(args.expectedPackages),
    },
  );
  console.log(JSON.stringify({ ok: true, receipt }));
}

function parseArgs(values: string[]): {
  verifyPath: string | null;
  sourceSha: string;
  expectedPackages: string;
} {
  const output = {
    verifyPath: null as string | null,
    sourceSha: "",
    expectedPackages: "",
  };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    const next = () => {
      const value = values[++index];
      if (!value) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === "--verify") output.verifyPath = next();
    else if (flag === "--source-sha") output.sourceSha = next();
    else if (flag === "--expected-packages") {
      const value = values[++index];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      output.expectedPackages = value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (output.verifyPath && !output.sourceSha) {
    throw new Error("--verify requires --source-sha");
  }
  return output;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.verifyPath) {
    await verifyReceiptFile({
      path: args.verifyPath,
      sourceSha: args.sourceSha,
      expectedPackages: args.expectedPackages,
    });
  } else {
    await writeReceiptFromEnvironment();
  }
}
