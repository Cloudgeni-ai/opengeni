import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test tools only. Never modify application dependencies or the Bun lockfile.
// CI discovers deployment tests automatically; do not silently skip promtool.
export async function run(command: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Cannot download test tool: ${response.status} ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function testTool(
  name: "helm" | "promtool",
  promtoolVersion?: "2.55.1" | "3.5.0",
): Promise<string> {
  if (promtoolVersion && name !== "promtool") throw new Error("Version override is promtool-only");
  const override = promtoolVersion
    ? `OPENGENI_PROMTOOL_${promtoolVersion.replaceAll(".", "_")}`
    : `OPENGENI_${name.toUpperCase()}`;
  // A generic PATH/override must not substitute a different engine for a
  // versioned compatibility check. Specific overrides are checked by tests.
  const explicit = process.env[override] ?? (promtoolVersion ? undefined : Bun.which(name));
  if (explicit) return explicit;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`Install ${name} or set ${override}`);
  }
  const version = name === "helm" ? "3.19.0" : (promtoolVersion ?? "3.5.0");
  const dir = join(tmpdir(), `opengeni-${name}-${version}-linux-amd64`);
  const binary = join(
    dir,
    name === "helm" ? "linux-amd64/helm" : `prometheus-${version}.linux-amd64/promtool`,
  );
  // Only reuse a previously verified install, not an unvalidated partial tar.
  if (await Bun.file(join(dir, "verified.sha256")).exists()) {
    const expected = (await Bun.file(join(dir, "verified.sha256")).text()).trim();
    const actual = createHash("sha256")
      .update(new Uint8Array(await Bun.file(binary).arrayBuffer()))
      .digest("hex");
    if (actual === expected) return binary;
    throw new Error(`Cached ${name} checksum mismatch`);
  }
  await mkdir(dir, { recursive: true });
  const archiveName =
    name === "helm"
      ? `helm-v${version}-linux-amd64.tar.gz`
      : `prometheus-${version}.linux-amd64.tar.gz`;
  const base =
    name === "helm"
      ? "https://get.helm.sh"
      : `https://github.com/prometheus/prometheus/releases/download/v${version}`;
  const [archive, checksumBytes] = await Promise.all([
    download(`${base}/${archiveName}`),
    download(`${base}/${name === "helm" ? `${archiveName}.sha256sum` : "sha256sums.txt"}`),
  ]);
  const checksumText = new TextDecoder().decode(checksumBytes);
  const expected = checksumText
    .split("\n")
    .find((line) => line.includes(archiveName))
    ?.split(/\s+/)[0];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected || actual !== expected)
    throw new Error(`Official ${name} archive checksum mismatch`);
  const archivePath = join(dir, archiveName);
  await Bun.write(archivePath, archive);
  const extracted = await run([
    "tar",
    "-xzf",
    archivePath,
    "-C",
    dir,
    name === "helm" ? "linux-amd64/helm" : `prometheus-${version}.linux-amd64/promtool`,
  ]);
  if (extracted.code !== 0) throw new Error(extracted.stderr);
  await Bun.write(
    join(dir, "verified.sha256"),
    createHash("sha256")
      .update(new Uint8Array(await Bun.file(binary).arrayBuffer()))
      .digest("hex"),
  );
  return binary;
}
