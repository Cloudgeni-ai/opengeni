import { createHash } from "node:crypto";
import { z } from "zod";

const stream = z
  .object({
    base64: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const receipt = z
  .object({
    version: z.literal(1),
    nonce: z.string().uuid(),
    commandSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    exitCode: z.number().int(),
    stdout: stream,
    stderr: stream,
  })
  .strict();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Only internal, non-interactive filesystem commands use this envelope. It
 * adds no provider Start or files: the original command inherits the exact
 * provider cwd/environment and completes inside the one foreground invocation.
 * Its streams become data, never status-looking output or a presentation tail. */
export function synchronousCommandEnvelope(command: string, nonce: string) {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const commandSha256 = sha256(Buffer.from(command, "utf8"));
  const wrapped = [
    "python3 -I -S - <<'__OPENGENI_FS_COMPLETION__'",
    "import base64, hashlib, json, subprocess, sys",
    `command = base64.b64decode(${JSON.stringify(encoded)})`,
    "process = subprocess.Popen(['/bin/sh', '-c', command.decode('utf-8')], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
    "stdout, stderr = process.communicate()",
    "exit_code = process.returncode if process.returncode >= 0 else 128 - process.returncode",
    "def stream(data):",
    "    return {'base64': base64.b64encode(data).decode('ascii'), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}",
    `receipt = {'version': 1, 'nonce': ${JSON.stringify(nonce)}, 'commandSha256': hashlib.sha256(command).hexdigest(), 'exitCode': exit_code, 'stdout': stream(stdout), 'stderr': stream(stderr)}`,
    "sys.stdout.write(json.dumps(receipt, separators=(',', ':')) + '\\n')",
    "sys.stdout.flush()",
    "sys.exit(exit_code)",
    "__OPENGENI_FS_COMPLETION__",
  ].join("\n");
  return {
    command: wrapped,
    decode(
      text: unknown,
      nativeExitCode: unknown,
    ): {
      stdout: string;
      stderr: string;
      exitCode: number;
    } | null {
      if (typeof text !== "string" || !Number.isSafeInteger(nativeExitCode)) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      const result = receipt.safeParse(parsed);
      if (
        !result.success ||
        result.data.nonce !== nonce ||
        result.data.commandSha256 !== commandSha256 ||
        result.data.exitCode !== nativeExitCode
      )
        return null;
      const output = { stdout: "", stderr: "", exitCode: result.data.exitCode };
      for (const name of ["stdout", "stderr"] as const) {
        const page = result.data[name];
        const bytes = Buffer.from(page.base64, "base64");
        if (
          bytes.toString("base64") !== page.base64 ||
          bytes.byteLength !== page.bytes ||
          sha256(bytes) !== page.sha256
        )
          return null;
        output[name] = bytes.toString("utf8");
      }
      return output;
    },
  };
}
