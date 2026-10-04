import { execFileSync } from "node:child_process";
import { lstat, readFile, open, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { VerificationReader } from "./auth";
import { ProbeError } from "./http";
import { runBurst } from "./runner";

export function parseCli(argv: string[]) {
  const out = {
    execute: false,
    confirm: false,
    intent: fileURLToPath(new URL("plain.intent.json", import.meta.url)),
    cohort: "",
    authorization: "",
    verificationDir: "",
    output: "",
    stopFile: "",
  };
  let explicitDry = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--execute") out.execute = true;
    else if (flag === "--dry-run") explicitDry = true;
    else if (flag === "--confirm-parent-authorized") out.confirm = true;
    else {
      const keys = {
        "--intent": "intent",
        "--cohort": "cohort",
        "--authorization": "authorization",
        "--verification-dir": "verificationDir",
        "--output": "output",
        "--stop-file": "stopFile",
      } as const;
      const key = keys[flag as keyof typeof keys];
      const value = argv[++index];
      if (!key || !value || value.startsWith("--")) throw new Error("invalid CLI argument");
      out[key] = value;
    }
  }
  if (explicitDry && out.execute) throw new Error("--dry-run and --execute cannot be combined");
  if (
    out.execute &&
    (!out.confirm || !out.cohort || !out.authorization || !out.output || !out.stopFile)
  )
    throw new Error("execution requires confirm/cohort/authorization/output/stop-file");
  return out;
}
export function mailboxReader(directory: string): VerificationReader {
  return async (identity, signal) => {
    const path = join(directory, `${identity.label}.json`);
    for (;;) {
      signal.throwIfAborted();
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
          throw new ProbeError("verification_file_must_be_private_regular_file");
        const verification = z
          .object({ email: z.string().email(), url: z.string().url() })
          .strict()
          .parse(JSON.parse(await readFile(path, "utf8")));
        if (verification.email.toLowerCase() !== identity.email.toLowerCase())
          throw new ProbeError("mailbox_identity_mismatch");
        return verification.url;
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
          throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 250);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  };
}
async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const intent = JSON.parse(await readFile(args.intent, "utf8"));
  if (!args.execute) {
    console.log(JSON.stringify(await runBurst({ intent, sourceSha: "offline" }), null, 2));
    return;
  }
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const git = (argv: string[]) =>
    execFileSync("git", argv, {
      cwd: repoRoot,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    }).trim();
  const sourceSha = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain", "--", "scripts/operator/launch-burst"]))
    throw new ProbeError("harness_source_is_dirty");
  const cohortText = await readFile(args.cohort, "utf8");
  const authorization = JSON.parse(await readFile(args.authorization, "utf8"));
  // Reserve output exclusively without truncating an earlier run. A rejected gate
  // never invokes this checkpoint and creates no output file.
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let consumed = false;
  const result = await runBurst({
    intent,
    execute: true,
    confirm: args.confirm,
    sourceSha,
    cohortText,
    authorization,
    ...(args.verificationDir ? { verificationReader: mailboxReader(args.verificationDir) } : {}),
    stopRequested: async () => {
      try {
        await access(args.stopFile);
        return true;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return false;
        throw error;
      }
    },
    checkpoint: async (snapshot) => {
      if (!consumed) {
        const receipt = await open(`${args.authorization}.consumed`, "wx", 0o600);
        try {
          await receipt.writeFile(
            `${JSON.stringify({ sourceSha, consumedAt: new Date().toISOString() })}\n`,
          );
          await receipt.sync();
        } finally {
          await receipt.close();
        }
        consumed = true;
      }
      output ??= await open(args.output, "wx", 0o600);
      const content = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
      await output.write(content, 0, content.length, 0);
      await output.truncate(content.length);
      await output.sync();
    },
  }).finally(async () => {
    await output?.close();
  });
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.main) {
  main().catch(() => {
    // Never print thrown Zod/fetch/file errors: they may embed input, URLs or secrets.
    console.error(
      JSON.stringify({ error: "burst_configuration_or_execution_failed", loadPass: false }),
    );
    process.exitCode = 2;
  });
}
