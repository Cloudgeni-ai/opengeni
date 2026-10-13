/**
 * Shell splice contract (design §10B.1.4). F1 owns the signatures; W1
 * implements the dialect-aware bodies. Each reference in a command becomes a
 * per-command environment variable (`${OPENGENI_SECRET_<n>}` on POSIX,
 * `${env:OPENGENI_SECRET_<n>}` on PowerShell). Literal bodies (quoted heredocs,
 * `@'…'@` here-strings) are rewritten into their expanding form with the body
 * escaped, so no value is ever placed in command text.
 */
import { SecretReferenceError, type SecretTextToken } from "@opengeni/contracts";
import { PosixSplicer } from "./posix";
import { PowerShellSplicer } from "./powershell";
import { BindingTable, streamFromTokens } from "./stream";

export type ShellDialect = "posix" | "powershell" | "cmd" | "fish" | "unknown";
export interface SecretExecBinding {
  /** Environment variable name, e.g. OPENGENI_SECRET_0. */
  envName: string;
  /** `referenceKey(ref)` of the bound reference. */
  key: string;
  /** Always false: every context is spliced as an expansion (no literal fallback). */
  literal: boolean;
  /** Always null (kept for the F1 contract shape). */
  sentinel: string | null;
}
export interface ShellSpliceResult {
  text: string;
  bindings: SecretExecBinding[];
}

export const SECRET_EXEC_ENV_PREFIX = "OPENGENI_SECRET_";

/**
 * Rewrites `tokens` (from `tokenizeSecretText(text)`) into a command that
 * reads each reference from its own env var, shell-aware (see `posix.ts` and
 * `powershell.ts` for the context tables). Throws
 * `SecretReferenceError(unsupported_shell)` for cmd, fish and unknown shells
 * when the command holds a reference. Escapes are already removed by the
 * tokenizer, so the result is rebuilt from `tokens` and `_text` is unused.
 * Pure: no values are involved.
 */
export function spliceShellCommand(
  _text: string,
  dialect: ShellDialect,
  tokens: readonly SecretTextToken[],
): ShellSpliceResult {
  const references = tokens.filter((token) => token.type === "reference");
  const items = streamFromTokens(tokens);
  if (references.length === 0) {
    return { text: items.join(""), bindings: [] };
  }
  if (dialect !== "posix" && dialect !== "powershell") {
    throw new SecretReferenceError(
      references.map((token) => ({
        raw: token.type === "reference" ? token.reference.raw : "",
        code: "unsupported_shell" as const,
        message:
          dialect === "cmd"
            ? 'secret references cannot be used safely in cmd.exe; run the command with shell "powershell" instead, or pass the value as a file with {{secretfile:…}}'
            : `secret references are not supported in ${dialect} shells; run the command with shell "sh" or "bash" (or "powershell" on Windows), or pass the value as a file with {{secretfile:…}}`,
      })),
      null,
    );
  }
  const table = new BindingTable(SECRET_EXEC_ENV_PREFIX);
  const text =
    dialect === "posix"
      ? new PosixSplicer(items, table).run()
      : new PowerShellSplicer(items, table).run();
  return { text, bindings: table.bindings };
}

/** Pick the splice dialect for a shell path or name on a given OS. */
export function dialectFromShell(
  shell: string | null,
  os: "linux" | "darwin" | "windows" | "unknown",
): ShellDialect {
  if (shell === null || shell.trim() === "") {
    if (os === "windows") return "powershell";
    if (os === "linux" || os === "darwin") return "posix";
    return "unknown";
  }
  const base = shell
    .trim()
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (["sh", "bash", "dash", "zsh", "ksh", "mksh", "ash", "busybox"].includes(base)) return "posix";
  if (base === "pwsh" || base === "powershell") return "powershell";
  if (base === "cmd") return "cmd";
  if (base === "fish") return "fish";
  return "unknown";
}
