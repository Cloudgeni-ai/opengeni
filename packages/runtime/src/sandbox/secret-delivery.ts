/**
 * Secret delivery at the physical exec boundary (dossier §10.3, W1).
 *
 * The tool wrappers (turn-tool-cancellation.ts) call `prepareSecretExec` with
 * the model's command text. It tokenizes `{{secret:…}}` / `{{secretfile:…}}`
 * references, splices them into per-command variable expansions (POSIX or
 * PowerShell), resolves them all-or-nothing through the attempt's
 * `SecretResolver`, and enforces the env caps. Nothing is dispatched on any
 * failure. The resolved values ride an in-memory `AsyncLocalStorage` carry
 * (never serialized) down to the provider call:
 *
 * - routing-session `execCommand` delivers them through an env file
 *   (`. file; rm -f file`) for managed backends whose exec OpenGeni does not
 *   own;
 * - the selfhosted (connected machine) session delivers them natively in
 *   `ExecRequest.env` and splices in the machine's dialect.
 *
 * Everything above the carry (SDK spans, run state, background-command rows,
 * turn-cancellation records) keeps the model's original text.
 *
 * Dependency note: this leaf must not import the routing session (which
 * imports it).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  SecretReferenceError,
  containsSecretReference,
  referenceKey,
  secretValueAtDispatch,
  tokenizeSecretText,
  type ResolvedSecretValue,
  type SecretReference,
  type SecretReferenceFailure,
  type SecretResolver,
  type SecretTextToken,
  type SecretUseSurface,
} from "@opengeni/contracts";
import {
  SECRET_EXEC_ENV_PREFIX,
  dialectFromShell,
  spliceShellCommand,
  type ShellDialect,
  type ShellSpliceResult,
} from "@opengeni/vaults";

/** Total bytes of secret env values delivered to one command (D15). */
export const SECRET_ENV_TOTAL_MAX_BYTES = 262_144;
/** Bytes of one secret env value (D15). */
export const SECRET_ENV_VALUE_MAX_BYTES = 102_400;
/** Attempt-scoped secret files and env files (0700 directory, 0600 files). */
export const SECRET_FILE_ROOT = "/tmp/opengeni-private/secrets";

export type SecretExecUse = {
  surface: SecretUseSurface;
  toolName: string;
  sourceCallId?: string;
};

/**
 * In-memory only. Holds resolved values; never stored, logged or serialized.
 * `spliced` is set when the wrapper already knew the dialect (managed
 * sandboxes run every command through POSIX `/bin/sh`); otherwise the
 * delivery adapter splices in the target's dialect (connected machines).
 */
export interface SecretExecCarry {
  readonly kind: "exec";
  /** The model's original command text (references, escapes intact). */
  readonly command: string;
  readonly tokens: readonly SecretTextToken[];
  readonly values: ReadonlyMap<string, ResolvedSecretValue>;
  readonly spliced: ShellSpliceResult | null;
  /** Attempt-scoped directory name under SECRET_FILE_ROOT. */
  readonly scope: string;
}

/** Literal substitution for stdin (`write_stdin`, `command_input`). */
export interface SecretStdinCarry {
  readonly kind: "stdin";
  readonly chars: string;
  readonly tokens: readonly SecretTextToken[];
  readonly values: ReadonlyMap<string, ResolvedSecretValue>;
}

export type SecretCarry = SecretExecCarry | SecretStdinCarry;

const storage = new AsyncLocalStorage<SecretCarry>();

/** Bind a carry around one tool invocation's provider call(s). */
export function runWithSecretCarry<T>(carry: SecretCarry | null, fn: () => T): T {
  return carry === null ? fn() : storage.run(carry, fn);
}

/**
 * The exec carry for exactly this command, or null. Helper commands in the
 * same async chain (identity probes, cancellation markers) never match.
 */
export function secretExecCarryFor(cmd: unknown): SecretExecCarry | null {
  const carry = storage.getStore();
  if (!carry || carry.kind !== "exec" || typeof cmd !== "string") return null;
  const needle = carry.spliced ? carry.spliced.text : carry.command;
  return cmd.includes(needle) ? carry : null;
}

function secretStdinCarryFor(chars: unknown): SecretStdinCarry | null {
  const carry = storage.getStore();
  if (!carry || carry.kind !== "stdin" || typeof chars !== "string") return null;
  return chars === carry.chars ? carry : null;
}

/** A safe directory name for an attempt (or a random one off-attempt). */
export function secretScopeFor(resolver: SecretResolver): string {
  const principal = resolver.principal;
  const raw =
    principal.kind === "attempt"
      ? `${principal.attemptId}-${principal.executionGeneration}`
      : `${principal.kind}-${crypto.randomUUID()}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

function invalidFailures(tokens: readonly SecretTextToken[]): SecretReferenceFailure[] {
  return tokens.flatMap((token) =>
    token.type === "invalid"
      ? [
          {
            raw: token.raw,
            code: "invalid_reference" as const,
            message: `invalid secret reference (${token.reason})`,
          },
        ]
      : [],
  );
}

function referencesOf(tokens: readonly SecretTextToken[]): SecretReference[] {
  return tokens.flatMap((token) => (token.type === "reference" ? [token.reference] : []));
}

function unescapedText(tokens: readonly SecretTextToken[]): string {
  return tokens
    .map((token) =>
      token.type === "text"
        ? token.value
        : token.type === "reference"
          ? token.reference.raw
          : token.raw,
    )
    .join("");
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const SECRETFILE_HINT =
  "pass it as a file with {{secretfile:…}} instead, which writes the value to a private file and splices its path";

/**
 * D15 caps for values delivered as env/stdin text. Binary or NUL-containing
 * values cannot be environment variables; oversize values bloat every exec.
 * TOTP codes are short and computed at dispatch, so only their seed is known
 * here; they are exempt.
 */
function assertDeliverableText(values: readonly ResolvedSecretValue[]): void {
  const failures: SecretReferenceFailure[] = [];
  let total = 0;
  for (const value of values) {
    if (value.reference.kind === "secretfile") continue;
    const material = value.material;
    if (material.type === "totp") {
      total += 10;
      continue;
    }
    if (material.type === "bytes" || material.value.includes("\u0000")) {
      failures.push({
        raw: value.reference.raw,
        code: "binary_value",
        message: `this value is binary and cannot be delivered as text; ${SECRETFILE_HINT}`,
      });
      continue;
    }
    const length = utf8Length(material.value);
    total += length;
    if (length > SECRET_ENV_VALUE_MAX_BYTES) {
      failures.push({
        raw: value.reference.raw,
        code: "too_large",
        message: `this value is ${length} bytes, over the ${SECRET_ENV_VALUE_MAX_BYTES}-byte limit for one value; ${SECRETFILE_HINT}`,
      });
    }
  }
  if (failures.length === 0 && total > SECRET_ENV_TOTAL_MAX_BYTES) {
    failures.push({
      raw: values.find((value) => value.reference.kind === "secret")?.reference.raw ?? "",
      code: "too_large",
      message: `the referenced values total ${total} bytes, over the ${SECRET_ENV_TOTAL_MAX_BYTES}-byte limit per command; ${SECRETFILE_HINT}`,
    });
  }
  if (failures.length > 0) throw new SecretReferenceError(failures);
}

function distinctByKey(refs: readonly SecretReference[]): SecretReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = referenceKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type PreparedSecretText<C> = {
  /** Text to send down (spliced, or unescaped when only escapes were present). */
  text: string;
  carry: C | null;
};

/**
 * Prepare one shell command. Returns null when the command holds no reference
 * marker or secrets are disabled for this agent (references then pass through
 * literally, Q-35): the command is byte-identical (DL-8, PF-1).
 *
 * `dialect` is the dialect the text will be parsed in, when known now. With
 * null the splice is deferred to the delivery adapter, and every reference is
 * resolved up front (comments included) so failures still precede dispatch.
 * Throws SecretReferenceError.
 */
export async function prepareSecretExec(
  command: string,
  options: {
    resolver: SecretResolver | null | undefined;
    dialect: ShellDialect | null;
    use: SecretExecUse;
  },
): Promise<PreparedSecretText<SecretExecCarry> | null> {
  const { resolver } = options;
  if (!resolver?.enabled || !containsSecretReference(command)) return null;
  const tokens = tokenizeSecretText(command);
  const invalid = invalidFailures(tokens);
  if (invalid.length > 0) throw new SecretReferenceError(invalid);
  const refs = referencesOf(tokens);
  if (refs.length === 0) {
    // Escapes only: deliver the unescaped literal text.
    const text = unescapedText(tokens);
    return text === command ? null : { text, carry: null };
  }
  const spliced =
    options.dialect === null ? null : spliceShellCommand(command, options.dialect, tokens);
  const bound = spliced
    ? new Set(spliced.bindings.map((binding: { key: string }) => binding.key))
    : null;
  const wanted = distinctByKey(refs).filter(
    (ref) => bound === null || bound.has(referenceKey(ref)),
  );
  if (spliced && wanted.length === 0) {
    // References only in comments: nothing to deliver.
    return { text: spliced.text, carry: null };
  }
  const values = await resolver.resolve(wanted, {
    surface: options.use.surface,
    toolName: options.use.toolName,
    ...(options.use.sourceCallId ? { sourceCallId: options.use.sourceCallId } : {}),
  });
  assertDeliverableText([...values.values()]);
  return {
    text: spliced ? spliced.text : command,
    carry: {
      kind: "exec",
      command,
      tokens,
      values,
      spliced,
      scope: secretScopeFor(resolver),
    },
  };
}

/**
 * Prepare literal text (stdin): resolve every reference now; the delivery
 * adapter substitutes values at the provider call. `{{secretfile:…}}` is
 * not allowed here.
 */
export async function prepareSecretStdin(
  chars: string,
  options: { resolver: SecretResolver | null | undefined; use: SecretExecUse },
): Promise<PreparedSecretText<SecretStdinCarry> | null> {
  const { resolver } = options;
  if (!resolver?.enabled || !containsSecretReference(chars)) return null;
  const tokens = tokenizeSecretText(chars);
  const invalid = invalidFailures(tokens);
  if (invalid.length > 0) throw new SecretReferenceError(invalid);
  const refs = referencesOf(tokens);
  if (refs.length === 0) {
    const text = unescapedText(tokens);
    return text === chars ? null : { text, carry: null };
  }
  const fileRefs = refs.filter((ref) => ref.kind === "secretfile");
  if (fileRefs.length > 0) {
    throw new SecretReferenceError(
      fileRefs.map((ref) => ({
        raw: ref.raw,
        code: "secretfile_not_allowed" as const,
        message: `{{secretfile:…}} is not allowed in ${options.use.toolName}; use {{secret:…}} to type the value`,
      })),
    );
  }
  const values = await resolver.resolve(distinctByKey(refs), {
    surface: options.use.surface,
    toolName: options.use.toolName,
    ...(options.use.sourceCallId ? { sourceCallId: options.use.sourceCallId } : {}),
  });
  assertDeliverableText([...values.values()]);
  return { text: chars, carry: { kind: "stdin", chars, tokens, values } };
}

async function textValue(value: ResolvedSecretValue): Promise<string> {
  const material = await secretValueAtDispatch(value);
  if (typeof material !== "string" || material.includes("\u0000")) {
    throw new SecretReferenceError([
      {
        raw: value.reference.raw,
        code: "binary_value",
        message: `this value is binary and cannot be delivered as text; ${SECRETFILE_HINT}`,
      },
    ]);
  }
  return material;
}

function requireValue(
  values: ReadonlyMap<string, ResolvedSecretValue>,
  key: string,
): ResolvedSecretValue {
  const value = values.get(key);
  if (!value) throw new Error("secret delivery: a bound reference has no resolved value");
  return value;
}

/**
 * Substitute stdin values at the provider call. Returns `args` unchanged
 * unless this exact write carries resolved references.
 */
export async function withSecretStdin<T>(args: T): Promise<T> {
  if (!args || typeof args !== "object") return args;
  const chars = (args as { chars?: unknown }).chars;
  const carry = secretStdinCarryFor(chars);
  if (!carry) return args;
  let text = "";
  for (const token of carry.tokens) {
    if (token.type === "text") text += token.value;
    else if (token.type === "reference") {
      text += await textValue(requireValue(carry.values, referenceKey(token.reference)));
    } else text += token.raw;
  }
  return { ...args, chars: text };
}

function safeFileStem(value: ResolvedSecretValue): string {
  const name = `${value.itemName}-${value.fieldName}`
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 64);
  return name.length > 0 ? name : "secret";
}

/** `/tmp/opengeni-private/secrets/<scope>/<sha8>-<name>` (deterministic per reference). */
export function secretFilePath(scope: string, value: ResolvedSecretValue): string {
  const digest = createHash("sha256").update(value.key).digest("hex").slice(0, 8);
  return `${SECRET_FILE_ROOT}/${scope}/${digest}-${safeFileStem(value)}`;
}

export function secretScopeDirectory(scope: string): string {
  return `${SECRET_FILE_ROOT}/${scope}`;
}

/** Bytes for a `{{secretfile:…}}` reference (text as UTF-8, bytes as-is, TOTP code). */
export async function secretFileBytes(value: ResolvedSecretValue): Promise<Uint8Array> {
  const material = await secretValueAtDispatch(value);
  return typeof material === "string" ? new TextEncoder().encode(material) : material;
}

export type SecretFileWriter = (file: { path: string; content: Uint8Array }) => Promise<void>;

/**
 * Build the per-command environment for one splice: plain references get
 * their value (TOTP computed now, Q-33); `{{secretfile:…}}` references get
 * the path of a 0600 file written through `writeFile`.
 */
export async function secretExecEnvironment(
  carry: SecretExecCarry,
  spliced: ShellSpliceResult,
  writeFile: SecretFileWriter | null,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const written = new Set<string>();
  for (const binding of spliced.bindings) {
    const value = requireValue(carry.values, binding.key);
    if (value.reference.kind === "secretfile") {
      const path = secretFilePath(carry.scope, value);
      if (!written.has(path)) {
        if (!writeFile) {
          throw new SecretReferenceError([
            {
              raw: value.reference.raw,
              code: "secretfile_not_allowed",
              message: "{{secretfile:…}} is not available on this sandbox",
            },
          ]);
        }
        await writeFile({ path, content: await secretFileBytes(value) });
        written.add(path);
      }
      env[binding.envName] = path;
      continue;
    }
    env[binding.envName] = await textValue(value);
  }
  return env;
}

/** Splice a deferred carry in the delivery target's dialect. */
export function spliceCarry(carry: SecretExecCarry, dialect: ShellDialect): ShellSpliceResult {
  return carry.spliced ?? spliceShellCommand(carry.command, dialect, carry.tokens);
}

function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** `export NAME='value'` lines for a POSIX env file (sourced, then deleted). */
export function secretEnvFileContent(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!name.startsWith(SECRET_EXEC_ENV_PREFIX) || !/^[A-Z0-9_]+$/.test(name)) {
        throw new Error("secret delivery: invalid binding name");
      }
      return `export ${name}=${posixSingleQuote(value)}\n`;
    })
    .join("");
}

export function secretEnvFilePath(scope: string): string {
  return `${SECRET_FILE_ROOT}/${scope}/env-${crypto.randomUUID()}`;
}

/**
 * Prefix a POSIX command with the env file: source it, delete it whatever the
 * outcome, and refuse to run the command when it cannot be read.
 */
export function withSecretEnvFilePrefix(cmd: string, path: string): string {
  const quoted = posixSingleQuote(path);
  return [
    `if . ${quoted}; then command rm -f -- ${quoted}; else command rm -f -- ${quoted}; exit 125; fi`,
    cmd,
  ].join("\n");
}

/** Remove one attempt's secret files and env files (attempt end, Q-23). */
export function clearSecretFilesCommand(scope: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(scope)) throw new Error("secret delivery: invalid scope");
  return `rm -rf -- ${posixSingleQuote(secretScopeDirectory(scope))}`;
}

/** Dialect of a command run through `shell` (or the default) on a host OS. */
export function shellDialectFor(
  shell: string | null | undefined,
  os: "linux" | "darwin" | "windows" | "unknown",
): ShellDialect {
  return dialectFromShell(shell ?? null, os);
}

export type SecretFilesWriter = (
  scope: string,
  files: ReadonlyArray<{ path: string; content: Uint8Array }>,
) => Promise<void>;

async function resolveTokens(
  tokens: readonly SecretTextToken[],
  options: {
    resolver: SecretResolver;
    use: SecretExecUse;
    writeFiles: SecretFilesWriter | null;
  },
): Promise<Map<string, string>> {
  const invalid = invalidFailures(tokens);
  if (invalid.length > 0) throw new SecretReferenceError(invalid);
  const refs = distinctByKey(referencesOf(tokens));
  const replacements = new Map<string, string>();
  if (refs.length === 0) return replacements;
  const fileRefs = refs.filter((ref) => ref.kind === "secretfile");
  if (fileRefs.length > 0 && !options.writeFiles) {
    throw new SecretReferenceError(
      fileRefs.map((ref) => ({
        raw: ref.raw,
        code: "secretfile_not_allowed" as const,
        message: `{{secretfile:…}} is not available in ${options.use.toolName} on this sandbox`,
      })),
    );
  }
  const values = await options.resolver.resolve(refs, {
    surface: options.use.surface,
    toolName: options.use.toolName,
    ...(options.use.sourceCallId ? { sourceCallId: options.use.sourceCallId } : {}),
  });
  const scope = secretScopeFor(options.resolver);
  const files: Array<{ path: string; content: Uint8Array }> = [];
  for (const ref of refs) {
    const value = requireValue(values, referenceKey(ref));
    if (ref.kind === "secretfile") {
      const path = secretFilePath(scope, value);
      files.push({ path, content: await secretFileBytes(value) });
      replacements.set(referenceKey(ref), path);
    } else {
      replacements.set(referenceKey(ref), await textValue(value));
    }
  }
  if (files.length > 0) await options.writeFiles!(scope, files);
  return replacements;
}

function renderTokens(
  tokens: readonly SecretTextToken[],
  replacements: ReadonlyMap<string, string>,
): string {
  return tokens
    .map((token) =>
      token.type === "text"
        ? token.value
        : token.type === "reference"
          ? replacements.get(referenceKey(token.reference))!
          : token.raw,
    )
    .join("");
}

/**
 * `apply_patch` (Q-24): resolve references in every patch line except the
 * `*** …` header lines that name paths, at the OpenGeni wrapper just before
 * the editor writes. The model-facing patch (run state, spans) keeps the
 * references. Returns null when nothing changes (byte-identical fast path).
 */
export async function resolveSecretPatchText(
  text: string,
  options: {
    resolver: SecretResolver | null | undefined;
    use: SecretExecUse;
    /** True for a whole V4A patch (skip `*** ` header lines); false for a bare diff. */
    headers: boolean;
    writeFiles: SecretFilesWriter | null;
  },
): Promise<string | null> {
  const { resolver } = options;
  if (!resolver?.enabled || !containsSecretReference(text)) return null;
  const lines = text.split(/(?<=\n)/);
  const isHeader = (line: string) => options.headers && line.startsWith("*** ");
  const content = lines.filter((line) => !isHeader(line)).join("");
  if (!containsSecretReference(content)) return null;
  const tokensByLine = lines.map((line) => (isHeader(line) ? null : tokenizeSecretText(line)));
  const replacements = await resolveTokens(
    tokensByLine.flatMap((tokens) => tokens ?? []),
    { resolver, use: options.use, writeFiles: options.writeFiles },
  );
  const resolved = lines
    .map((line, index) => {
      const tokens = tokensByLine[index];
      return tokens ? renderTokens(tokens, replacements) : line;
    })
    .join("");
  return resolved === text ? null : resolved;
}

/**
 * `view_image` accepts only `{{secretfile:…}}` (the image is written to a
 * private file whose path is viewed). Returns null when the path has no
 * reference.
 */
export async function resolveSecretImagePath(
  path: string,
  options: {
    resolver: SecretResolver | null | undefined;
    use: SecretExecUse;
    writeFiles: SecretFilesWriter | null;
  },
): Promise<string | null> {
  const { resolver } = options;
  if (!resolver?.enabled || !containsSecretReference(path)) return null;
  const tokens = tokenizeSecretText(path);
  const plain = referencesOf(tokens).filter((ref) => ref.kind === "secret");
  if (plain.length > 0) {
    throw new SecretReferenceError(
      plain.map((ref) => ({
        raw: ref.raw,
        code: "invalid_reference" as const,
        message: "view_image accepts only {{secretfile:…}} references, which it views as a file",
      })),
    );
  }
  const replacements = await resolveTokens(tokens, {
    resolver,
    use: options.use,
    writeFiles: options.writeFiles,
  });
  const resolved = renderTokens(tokens, replacements);
  return resolved === path ? null : resolved;
}
