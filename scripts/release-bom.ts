import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RELEASE_IMAGE_NAMES, RELEASE_IMAGE_ROLES } from "./release-candidate";

export type ReleaseBomPackage = {
  name: string;
  version: string;
  gitHead: string;
  integrity: string;
};

export type ReleaseBomImage = {
  name: string;
  digest: string;
};

export type ReleaseBom = {
  schemaVersion: 1;
  sourceSha: string;
  releaseVersion: string;
  packages: ReleaseBomPackage[];
  images: ReleaseBomImage[];
};

const packageNamePattern = /^@opengeni\/[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sourceShaPattern = /^[0-9a-f]{40}$/;
const integrityPattern = /^sha512-[A-Za-z0-9+/=]+$/;
const imageNamePattern = /^ghcr\.io\/[a-z0-9._/-]+$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;
const requiredReleaseImages = RELEASE_IMAGE_ROLES.map((role) => RELEASE_IMAGE_NAMES[role]).sort();

function uniqueBy<T>(items: T[], key: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export function buildReleaseBom(input: {
  sourceSha: string;
  releaseVersion: string;
  packages: Array<ReleaseBomPackage & { state: "published" }>;
  images: ReleaseBomImage[];
}): ReleaseBom {
  if (!sourceShaPattern.test(input.sourceSha)) {
    throw new Error("release BOM sourceSha must be 40 lowercase hexadecimal characters");
  }
  if (!versionPattern.test(input.releaseVersion)) {
    throw new Error("release BOM releaseVersion must be an exact semver version");
  }
  if (input.packages.length === 0) throw new Error("release BOM packages must not be empty");
  if (input.images.length === 0) throw new Error("release BOM images must not be empty");

  for (const pkg of input.packages) {
    if (
      !packageNamePattern.test(pkg.name) ||
      !versionPattern.test(pkg.version) ||
      !sourceShaPattern.test(pkg.gitHead) ||
      !integrityPattern.test(pkg.integrity)
    ) {
      throw new Error(`invalid release BOM package identity: ${pkg.name}@${pkg.version}`);
    }
    if (pkg.state !== "published") {
      throw new Error(`release BOM package is not published: ${pkg.name}@${pkg.version}`);
    }
  }
  for (const image of input.images) {
    if (!imageNamePattern.test(image.name) || !imageDigestPattern.test(image.digest)) {
      throw new Error(`invalid release BOM image identity: ${image.name}@${image.digest}`);
    }
  }

  uniqueBy(input.packages, (pkg) => pkg.name, "package");
  uniqueBy(input.images, (image) => image.name, "image");
  const suppliedImages = new Set(input.images.map((image) => image.name));
  if (suppliedImages.size !== requiredReleaseImages.length) {
    throw new Error(`release BOM images must contain exactly: ${requiredReleaseImages.join(", ")}`);
  }
  for (const requiredImage of requiredReleaseImages) {
    if (!suppliedImages.has(requiredImage)) {
      throw new Error(`release BOM is missing required image: ${requiredImage}`);
    }
  }

  return {
    schemaVersion: 1,
    sourceSha: input.sourceSha,
    releaseVersion: input.releaseVersion,
    packages: input.packages
      .map(({ name, version, gitHead, integrity }) => ({ name, version, gitHead, integrity }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    images: [...input.images].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function parseJsonArray<T>(name: string, value: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed as T[];
}

async function main(): Promise<void> {
  const bom = buildReleaseBom({
    sourceSha: process.env.OPENGENI_RELEASE_BOM_SOURCE_SHA ?? "",
    releaseVersion: process.env.OPENGENI_RELEASE_BOM_VERSION ?? "",
    packages: parseJsonArray<ReleaseBomPackage & { state: "published" }>(
      "OPENGENI_RELEASE_BOM_PACKAGES",
      process.env.OPENGENI_RELEASE_BOM_PACKAGES ?? "",
    ),
    images: parseJsonArray<ReleaseBomImage>(
      "OPENGENI_RELEASE_BOM_IMAGES",
      process.env.OPENGENI_RELEASE_BOM_IMAGES ?? "",
    ),
  });
  const serialized = `${JSON.stringify(bom, null, 2)}\n`;
  const sha256 = createHash("sha256").update(serialized).digest("hex");
  const outputPath = resolve(
    import.meta.dir,
    "..",
    process.env.OPENGENI_RELEASE_BOM_PATH ?? "evidence/release-bom.json",
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `sha256=${sha256}\n`, "utf8");
  }
  console.log(JSON.stringify({ path: outputPath, sha256, bom }));
}

if (import.meta.main) await main();
