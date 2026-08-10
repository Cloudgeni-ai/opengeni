type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
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
    "{{json .Manifest}}",
  ]);
  if (result.timedOut) {
    throw new Error(`OCI manifest lookup timed out for ${reference}`);
  }
  if (result.exitCode === 0) {
    let digest: unknown;
    try {
      digest = (JSON.parse(result.stdout) as { digest?: unknown }).digest;
    } catch {
      throw new Error(`OCI registry returned an invalid manifest document for ${reference}`);
    }
    if (typeof digest !== "string" || !digestPattern.test(digest)) {
      throw new Error(`OCI registry returned an invalid manifest digest for ${reference}`);
    }
    return digest;
  }
  const stderrLines = result.stderr.trim().split(/\r?\n/);
  if (
    missingPattern.test(result.stderr) ||
    stderrLines.at(-1) === `ERROR: ${reference}: not found`
  ) {
    return null;
  }
  throw new Error(
    `OCI manifest lookup failed for ${reference}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
  );
}

async function runCommand(argv: string[]): Promise<CommandResult> {
  const useProcessGroup = process.platform !== "win32";
  const child = Bun.spawn(argv, {
    detached: useProcessGroup,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const terminate = (signal: NodeJS.Signals): void => {
    try {
      if (useProcessGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // A concurrent normal exit wins the race with timeout cleanup.
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
  }, 30_000);
  const force = setTimeout(() => {
    if (timedOut) terminate("SIGKILL");
  }, 32_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeout);
    clearTimeout(force);
  }
}

if (import.meta.main) {
  const [reference, ...extra] = process.argv.slice(2);
  if (!reference || extra.length > 0) {
    throw new Error("usage: bun scripts/resolve-optional-oci-manifest.ts <reference>");
  }
  console.log((await resolveOptionalOciManifest(reference)) ?? "");
}
