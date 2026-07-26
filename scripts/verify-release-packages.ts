import { appendFile, mkdir, writeFile } from "node:fs/promises";
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

export function loadPublishablePackages(): PublishablePackage[] {
  return publishableWorkspacePackages()
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
  const expected = parseExpectedPackages(process.env.OPENGENI_EXPECTED_PACKAGES ?? "");
  const phaseValue = process.env.OPENGENI_RELEASE_PACKAGE_PHASE ?? "";
  if (phaseValue !== "plan" && phaseValue !== "verify") {
    throw new Error("OPENGENI_RELEASE_PACKAGE_PHASE must be plan or verify");
  }

  const publishable = loadPublishablePackages();
  const expectedNames = new Set(expected.map((pkg) => pkg.name));
  const registryEntries = await Promise.all(
    publishable.map(
      async (pkg) =>
        [
          pkg.name,
          await readRegistryPackage(pkg, phaseValue === "verify" && expectedNames.has(pkg.name)),
        ] as const,
    ),
  );
  const result = reconcileReleasePackages({
    sourceSha,
    phase: phaseValue,
    publishable,
    expected,
    registry: new Map(registryEntries),
  });

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

if (import.meta.main) {
  await main();
}
