type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type Run = (argv: string[]) => Promise<CommandResult>;

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const missingPattern = /(?:manifest unknown|MANIFEST_UNKNOWN|404 Not Found)/;

export async function resolveOptionalOciManifest(
  reference: string,
  run: Run = runCommand,
): Promise<string | null> {
  if (reference.length === 0 || reference.length > 512 || /[\u0000-\u0020\u007f]/.test(reference)) {
    throw new Error("OCI manifest reference is invalid");
  }
  const result = await run([
    "docker",
    "buildx",
    "imagetools",
    "inspect",
    reference,
    "--format",
    "{{.Manifest.Digest}}",
  ]);
  const digest = result.stdout.trim();
  if (result.exitCode === 0) {
    if (!digestPattern.test(digest)) {
      throw new Error(`OCI registry returned an invalid manifest digest for ${reference}`);
    }
    return digest;
  }
  if (missingPattern.test(result.stderr)) {
    return null;
  }
  throw new Error(
    `OCI manifest lookup failed for ${reference}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
  );
}

async function runCommand(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

if (import.meta.main) {
  const [reference, ...extra] = process.argv.slice(2);
  if (!reference || extra.length > 0) {
    throw new Error("usage: bun scripts/resolve-optional-oci-manifest.ts <reference>");
  }
  console.log((await resolveOptionalOciManifest(reference)) ?? "");
}
