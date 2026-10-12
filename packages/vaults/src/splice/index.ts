/**
 * Shell splice contract (dossier §10B.1.4). F1 owns the signatures; W1
 * implements the dialect-aware bodies. Each reference in a command becomes a
 * per-command environment variable (`${OPENGENI_SECRET_<n>}` on POSIX,
 * `$env:OPENGENI_SECRET_<n>` on PowerShell); a literal fallback is used where
 * splicing cannot be safe (quoted heredocs, here-strings).
 */
import { referenceKey, SecretReferenceError, type SecretTextToken } from "@opengeni/contracts";

export type ShellDialect = "posix" | "powershell" | "cmd" | "fish" | "unknown";
export interface SecretExecBinding {
  /** Environment variable name, e.g. OPENGENI_SECRET_0. */
  envName: string;
  /** `referenceKey(ref)` of the bound reference. */
  key: string;
  /** True when the value is substituted literally into the command text (fallback). */
  literal: boolean;
  /** Placeholder text replaced by the value at dispatch when `literal`; null otherwise. */
  sentinel: string | null;
}
export interface ShellSpliceResult {
  text: string;
  bindings: SecretExecBinding[];
}

export const SECRET_EXEC_ENV_PREFIX = "OPENGENI_SECRET_";

/**
 * Rewrites `tokens` (from `tokenizeSecretText(text)`) into a command that
 * reads each reference from its own env var. Throws
 * `SecretReferenceError(unsupported_shell)` for cmd, fish and unknown shells.
 *
 * F1 placeholder body (W1 replaces it with the quote- and heredoc-aware
 * scanner): every reference becomes a double-quoted variable expansion
 * regardless of its quoting context. Escapes are already removed by the
 * tokenizer, so `text` is rebuilt from `tokens`.
 */
export function spliceShellCommand(
  _text: string,
  dialect: ShellDialect,
  tokens: readonly SecretTextToken[],
): ShellSpliceResult {
  const references = tokens.filter((token) => token.type === "reference");
  if (references.length === 0) {
    return {
      text: tokens
        .map((token) =>
          token.type === "text"
            ? token.value
            : token.type === "invalid"
              ? token.raw
              : token.reference.raw,
        )
        .join(""),
      bindings: [],
    };
  }
  if (dialect !== "posix" && dialect !== "powershell") {
    throw new SecretReferenceError(
      references.map((token) => ({
        raw: token.type === "reference" ? token.reference.raw : "",
        code: "unsupported_shell" as const,
        message: `secret references are not supported in ${dialect} shells; use sh/bash or PowerShell`,
      })),
      null,
    );
  }
  const bindings: SecretExecBinding[] = [];
  const byKey = new Map<string, SecretExecBinding>();
  let out = "";
  for (const token of tokens) {
    if (token.type === "text") {
      out += token.value;
      continue;
    }
    if (token.type === "invalid") {
      out += token.raw;
      continue;
    }
    const key = referenceKey(token.reference);
    let binding = byKey.get(key);
    if (!binding) {
      binding = {
        envName: `${SECRET_EXEC_ENV_PREFIX}${bindings.length}`,
        key,
        literal: false,
        sentinel: null,
      };
      byKey.set(key, binding);
      bindings.push(binding);
    }
    out += dialect === "posix" ? `"\${${binding.envName}}"` : `"$env:${binding.envName}"`;
  }
  return { text: out, bindings };
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
