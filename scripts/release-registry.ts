export const DEFAULT_RELEASE_OCI_PREFIX = "ghcr.io/cloudgeni-ai";

const registryComponent = "[a-z0-9]+(?:[._-][a-z0-9]+)*";
const registryHost = "(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::(?:[1-9][0-9]{0,4}))?";
const releaseOciPrefixPattern = new RegExp(`^${registryHost}(?:/${registryComponent})*$`);

export function normalizeReleaseOciPrefix(
  value: string | undefined = DEFAULT_RELEASE_OCI_PREFIX,
): string {
  if (!value || value !== value.trim() || !releaseOciPrefixPattern.test(value)) {
    throw new Error(
      "release OCI prefix must be a lowercase registry host with optional repository path",
    );
  }
  const port = value.split("/", 1)[0]?.split(":")[1];
  if (port && Number(port) > 65_535) {
    throw new Error("release OCI prefix registry port must be at most 65535");
  }
  return value;
}

export function releaseRegistryHost(prefix: string): string {
  return normalizeReleaseOciPrefix(prefix).split("/", 1)[0]!;
}

export function releaseImageName(prefix: string, role: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(role)) {
    throw new Error("release image role must be a lowercase identifier");
  }
  return `${normalizeReleaseOciPrefix(prefix)}/opengeni-${role}`;
}

export function releaseChartReference(prefix: string): string {
  return `oci://${normalizeReleaseOciPrefix(prefix)}/charts/opengeni`;
}

export function isExactSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function releaseOciPrefixFromEnvironment(): string {
  return normalizeReleaseOciPrefix(process.env.OPENGENI_RELEASE_OCI_PREFIX);
}

if (import.meta.main) {
  const prefix = releaseOciPrefixFromEnvironment();
  console.log(JSON.stringify({ prefix, registry: releaseRegistryHost(prefix) }));
}
