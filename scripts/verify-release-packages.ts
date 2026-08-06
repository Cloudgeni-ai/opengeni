import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { publishableWorkspacePackages } from "./publishable-workspaces";

export type PublishablePackage = {
  name: string;
  version: string;
};

export type RegistryPackage = {
  name: string;
  version: string;
  gitHead: string | null;
  integrity: string | null;
};

export type ReleasePackageReceipt = PublishablePackage & {
  state: "pending" | "published";
  gitHead: string | null;
  integrity: string | null;
};

export type VerifiedPackagePublicationReceipt = {
  schemaVersion: 1;
  phase: "verify";
  sourceSha: string;
  needsPublish: false;
  releaseReady: true;
  packages: ReleasePackageReceipt[];
  bomPackages: ReleasePackageReceipt[];
};

const packageNamePattern = /^@opengeni\/[a-z0-9][a-z0-9._-]*$/;
const packageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sourceShaPattern = /^[0-9a-f]{40}$/;

export function parseExpectedPackages(value: string): PublishablePackage[] {
  const specs = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  return specs.map((spec) => {
    const separator = spec.lastIndexOf("@");
    const name = spec.slice(0, separator);
    const version = spec.slice(separator + 1);
    if (!packageNamePattern.test(name) || !packageVersionPattern.test(version)) {
      throw new Error(`invalid expected package spec: ${spec}`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate expected package: ${name}`);
    }
    seen.add(name);
    return { name, version };
  });
}

export function validateVerifiedPackagePublicationReceipt(
  value: unknown,
  expected: { sourceSha: string; packageNames: string[] },
): VerifiedPackagePublicationReceipt {
  const receipt = record(value, "verified package publication receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "phase",
      "sourceSha",
      "needsPublish",
      "releaseReady",
      "packages",
      "bomPackages",
    ],
    "verified package publication receipt",
  );
  if (receipt.schemaVersion !== 1 || receipt.phase !== "verify") {
    throw new Error("verified package publication receipt schema or phase is invalid");
  }
  if (receipt.sourceSha !== expected.sourceSha || !sourceShaPattern.test(expected.sourceSha)) {
    throw new Error("verified package publication receipt source SHA does not match");
  }
  if (receipt.needsPublish !== false || receipt.releaseReady !== true) {
    throw new Error("verified package publication receipt is not terminal and release-ready");
  }

  const packages = normalizePublishedPackageReceipts(receipt.packages, "packages");
  const bomPackages = normalizePublishedPackageReceipts(receipt.bomPackages, "bomPackages");
  const expectedNames = [...expected.packageNames].sort();
  const actualNames = bomPackages.map((pkg) => pkg.name);
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      "verified package publication receipt does not cover the exact package closure",
    );
  }
  const bomByName = new Map(bomPackages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of packages) {
    if (pkg.gitHead !== expected.sourceSha) {
      throw new Error("verified published package does not belong to the package source SHA");
    }
    if (JSON.stringify(bomByName.get(pkg.name)) !== JSON.stringify(pkg)) {
      throw new Error("verified published package is not identical to its package BOM entry");
    }
  }

  return {
    schemaVersion: 1,
    phase: "verify",
    sourceSha: expected.sourceSha,
    needsPublish: false,
    releaseReady: true,
    packages,
    bomPackages,
  };
}

export function assertPackageEvidenceMatchesRegistry(
  evidence: VerifiedPackagePublicationReceipt,
  bomPackages: ReleasePackageReceipt[],
): void {
  if (JSON.stringify(evidence.bomPackages) !== JSON.stringify(bomPackages)) {
    throw new Error("verified package publication receipt no longer matches npm registry identity");
  }
}

export function deriveExpectedReleasePackages(
  publishable: PublishablePackage[],
  registry: Map<string, RegistryPackage | null>,
): PublishablePackage[] {
  return publishable.filter((pkg) => {
    const remote = registry.get(pkg.name);
    if (remote === undefined) {
      throw new Error(`registry state was not loaded for ${pkg.name}`);
    }
    return remote === null;
  });
}

export function resolveExpectedReleasePackages(options: {
  phase: "plan" | "verify";
  deriveExpected: boolean;
  declaredExpected: PublishablePackage[];
  publishable: PublishablePackage[];
  registry: Map<string, RegistryPackage | null>;
}): PublishablePackage[] {
  if (!options.deriveExpected) return options.declaredExpected;
  if (options.phase !== "plan") {
    throw new Error("automatic package derivation is valid only during planning");
  }
  if (options.declaredExpected.length !== 0) {
    throw new Error("automatic package derivation cannot be combined with a declared package set");
  }
  return deriveExpectedReleasePackages(options.publishable, options.registry);
}

export function reconcileReleasePackages(options: {
  sourceSha: string;
  phase: "plan" | "verify";
  publishable: PublishablePackage[];
  expected: PublishablePackage[];
  registry: Map<string, RegistryPackage | null>;
}): {
  needsPublish: boolean;
  releaseReady: boolean;
  packages: ReleasePackageReceipt[];
  bomPackages: ReleasePackageReceipt[];
} {
  const { sourceSha, phase, publishable, expected, registry } = options;
  if (!sourceShaPattern.test(sourceSha)) {
    throw new Error("source SHA must be 40 lowercase hexadecimal characters");
  }

  const localByName = new Map(publishable.map((pkg) => [pkg.name, pkg]));
  const expectedByName = new Map(expected.map((pkg) => [pkg.name, pkg]));

  for (const item of expected) {
    const local = localByName.get(item.name);
    if (!local) {
      throw new Error(`expected package is not publishable in this checkout: ${item.name}`);
    }
    if (local.version !== item.version) {
      throw new Error(
        `expected ${item.name}@${item.version}, but the checkout contains ${item.name}@${local.version}`,
      );
    }
  }

  const unexpectedMissing = publishable.filter(
    (pkg) => registry.get(pkg.name) === null && !expectedByName.has(pkg.name),
  );
  if (unexpectedMissing.length > 0) {
    throw new Error(
      `unlisted unpublished package versions would escape this release: ${unexpectedMissing
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join(", ")}`,
    );
  }

  const receiptFor = (
    item: PublishablePackage,
    expectedInThisRelease: boolean,
  ): ReleasePackageReceipt => {
    const remote = registry.get(item.name);
    if (remote === undefined) {
      throw new Error(`registry state was not loaded for ${item.name}`);
    }
    if (remote === null) {
      if (!expectedInThisRelease) {
        throw new Error(`unlisted unpublished package version: ${item.name}@${item.version}`);
      }
      return { ...item, state: "pending", gitHead: null, integrity: null };
    }
    if (remote.name !== item.name || remote.version !== item.version) {
      throw new Error(`registry returned the wrong identity for ${item.name}@${item.version}`);
    }
    if (!remote.gitHead || !sourceShaPattern.test(remote.gitHead)) {
      throw new Error(`registry gitHead is missing or invalid for ${item.name}@${item.version}`);
    }
    if (expectedInThisRelease && remote.gitHead !== sourceSha) {
      throw new Error(
        `version collision: ${item.name}@${item.version} belongs to gitHead ${remote.gitHead ?? "missing"}, not ${sourceSha}`,
      );
    }
    if (!remote.integrity?.startsWith("sha512-")) {
      throw new Error(`registry integrity is missing or invalid for ${item.name}@${item.version}`);
    }
    return {
      ...item,
      state: "published",
      gitHead: remote.gitHead,
      integrity: remote.integrity,
    };
  };

  const bomPackages = [...publishable]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<ReleasePackageReceipt>((item) => receiptFor(item, expectedByName.has(item.name)));
  const bomByName = new Map(bomPackages.map((item) => [item.name, item]));
  const packages = expected.map<ReleasePackageReceipt>((item) => bomByName.get(item.name)!);

  const needsPublish = packages.some((pkg) => pkg.state === "pending");
  if (phase === "verify" && needsPublish) {
    throw new Error(
      `publication did not settle every expected package: ${packages
        .filter((pkg) => pkg.state === "pending")
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join(", ")}`,
    );
  }

  return { needsPublish, releaseReady: !needsPublish, packages, bomPackages };
}

export function loadPublishablePackages(root?: string): PublishablePackage[] {
  return publishableWorkspacePackages(root)
    .map(({ name, version }) => {
      if (!packageNamePattern.test(name) || !packageVersionPattern.test(version)) {
        throw new Error(`invalid publishable package manifest: ${name}@${version}`);
      }
      return { name, version };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchRegistryPackage(pkg: PublishablePackage): Promise<RegistryPackage | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status} for ${pkg.name}@${pkg.version}`);
    }
    const metadata = (await response.json()) as {
      name?: unknown;
      version?: unknown;
      gitHead?: unknown;
      dist?: { integrity?: unknown } | undefined;
    };
    return {
      name: typeof metadata.name === "string" ? metadata.name : "",
      version: typeof metadata.version === "string" ? metadata.version : "",
      gitHead: typeof metadata.gitHead === "string" ? metadata.gitHead : null,
      integrity: typeof metadata.dist?.integrity === "string" ? metadata.dist.integrity : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readRegistryPackage(
  pkg: PublishablePackage,
  waitForAvailability: boolean,
): Promise<RegistryPackage | null> {
  const attempts = waitForAvailability ? 24 : 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fetchRegistryPackage(pkg);
      if (
        !waitForAvailability ||
        attempt === attempts ||
        (result !== null && result.gitHead !== null && result.integrity !== null)
      ) {
        return result;
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await Bun.sleep(5_000);
  }
  if (lastError) throw lastError;
  return null;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const sourceSha = process.env.OPENGENI_RELEASE_SOURCE_SHA ?? "";
  const phaseValue = process.env.OPENGENI_RELEASE_PACKAGE_PHASE ?? "";
  if (phaseValue !== "plan" && phaseValue !== "verify") {
    throw new Error("OPENGENI_RELEASE_PACKAGE_PHASE must be plan or verify");
  }

  const packageClosureRoot = process.env.OPENGENI_RELEASE_PACKAGE_CLOSURE_ROOT;
  const localPublishable = loadPublishablePackages(
    packageClosureRoot ? resolve(packageClosureRoot) : undefined,
  );
  const declaredExpected = parseExpectedPackages(process.env.OPENGENI_EXPECTED_PACKAGES ?? "");
  const deriveExpectedValue = process.env.OPENGENI_RELEASE_PACKAGE_DERIVE_EXPECTED ?? "";
  if (deriveExpectedValue !== "" && deriveExpectedValue !== "true") {
    throw new Error("OPENGENI_RELEASE_PACKAGE_DERIVE_EXPECTED must be true or unset");
  }
  const packageEvidencePath = process.env.OPENGENI_RELEASE_PACKAGE_BOM_RECEIPT ?? "";
  const packageEvidenceSourceSha = process.env.OPENGENI_RELEASE_PACKAGE_BOM_SOURCE_SHA ?? "";
  if (Boolean(packageEvidencePath) !== Boolean(packageEvidenceSourceSha)) {
    throw new Error(
      "OPENGENI_RELEASE_PACKAGE_BOM_RECEIPT and OPENGENI_RELEASE_PACKAGE_BOM_SOURCE_SHA must be set together",
    );
  }
  if (packageEvidencePath && (declaredExpected.length !== 0 || deriveExpectedValue !== "")) {
    throw new Error("verified package BOM evidence is valid only for an application-only release");
  }
  const packageEvidence = packageEvidencePath
    ? validateVerifiedPackagePublicationReceipt(
        JSON.parse(await readFile(resolve(root, packageEvidencePath), "utf8")) as unknown,
        {
          sourceSha: packageEvidenceSourceSha,
          packageNames: localPublishable.map((pkg) => pkg.name),
        },
      )
    : null;
  const publishable = packageEvidence
    ? packageEvidence.bomPackages.map(({ name, version }) => ({ name, version }))
    : localPublishable;
  const expectedNames = new Set(declaredExpected.map((pkg) => pkg.name));
  const registryEntries = await Promise.all(
    publishable.map(
      async (pkg) =>
        [
          pkg.name,
          await readRegistryPackage(pkg, phaseValue === "verify" && expectedNames.has(pkg.name)),
        ] as const,
    ),
  );
  const registry = new Map(registryEntries);
  const expected = resolveExpectedReleasePackages({
    phase: phaseValue,
    deriveExpected: deriveExpectedValue === "true",
    declaredExpected,
    publishable,
    registry,
  });
  const result = reconcileReleasePackages({
    sourceSha,
    phase: phaseValue,
    publishable,
    expected,
    registry,
  });
  if (packageEvidence) assertPackageEvidenceMatchesRegistry(packageEvidence, result.bomPackages);

  const receipt = {
    schemaVersion: 1,
    phase: phaseValue,
    sourceSha,
    needsPublish: result.needsPublish,
    releaseReady: result.releaseReady,
    packages: result.packages,
    bomPackages: result.bomPackages,
  };
  const receiptPath = resolve(
    root,
    process.env.OPENGENI_RELEASE_PACKAGE_RECEIPT ?? "evidence/release-packages.json",
  );
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    await appendFile(
      githubOutput,
      [
        `needs_publish=${String(result.needsPublish)}`,
        `release_ready=${String(result.releaseReady)}`,
        `verified_packages=${JSON.stringify(result.packages)}`,
        `bom_packages=${JSON.stringify(result.bomPackages)}`,
      ].join("\n") + "\n",
      "utf8",
    );
  }
  console.log(JSON.stringify(receipt));
}

function normalizePublishedPackageReceipts(value: unknown, label: string): ReleasePackageReceipt[] {
  if (!Array.isArray(value))
    throw new Error(`verified package publication ${label} must be an array`);
  const seen = new Set<string>();
  return value
    .map((item, index) => {
      const pkg = record(item, `verified package publication ${label}[${index}]`);
      exactKeys(
        pkg,
        ["name", "version", "state", "gitHead", "integrity"],
        `verified package publication ${label}[${index}]`,
      );
      if (
        typeof pkg.name !== "string" ||
        !packageNamePattern.test(pkg.name) ||
        typeof pkg.version !== "string" ||
        !packageVersionPattern.test(pkg.version) ||
        pkg.state !== "published" ||
        typeof pkg.gitHead !== "string" ||
        !sourceShaPattern.test(pkg.gitHead) ||
        typeof pkg.integrity !== "string" ||
        !pkg.integrity.startsWith("sha512-")
      ) {
        throw new Error(`verified package publication ${label}[${index}] is invalid`);
      }
      if (seen.has(pkg.name)) {
        throw new Error(`verified package publication ${label} contains a duplicate package`);
      }
      seen.add(pkg.name);
      return {
        name: pkg.name,
        version: pkg.version,
        state: "published" as const,
        gitHead: pkg.gitHead,
        integrity: pkg.integrity,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function record(value: unknown, label: string): Record<string, unknown> {
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

if (import.meta.main) {
  await main();
}
