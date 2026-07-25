import type {
  RunCredentialAuthNeeded,
  RunCredentialFile,
  RunCredentialRedaction,
  RunCredentialsResolution,
} from "@opengeni/contracts";
import type {
  ExecCommandArgs,
  SandboxClient,
  SandboxSessionLike,
  SandboxSessionState,
} from "@openai/agents/sandbox";

const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_FILES = 64;
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_MATERIAL_BYTES = 4 * 1024 * 1024;
const MAX_AUTH_NEEDED_NOTICES = 32;
const MAX_REDACTION_VALUES = 256;
const WRITE_CHUNK_BYTES = 24 * 1024;
const COMMAND_OK_MARKER = "__OPENGENI_RUN_CREDENTIAL_COMMAND_OK__";
const AUTH_NEEDED_REASONS = new Set([
  "missing_connection",
  "expired",
  "insufficient_scope",
  "refresh_failed",
]);
const PORTABLE_LOCK_STALE_MINUTES = 2;

export type RunCredentialExpectedScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
};

export type NormalizedRunCredentialMaterial = {
  environment: Record<string, string>;
  files: RunCredentialFile[];
  fileEnvironment: Record<string, string>;
  expiresAt: Date | null;
  authNeeded: RunCredentialAuthNeeded[];
  redactions: RunCredentialRedaction[];
};

export type RunCredentialCommandSession = Pick<SandboxSessionLike, "exec" | "execCommand">;
export type RunCredentialCommandRunner = (
  session: RunCredentialCommandSession,
  args: ExecCommandArgs,
) => Promise<unknown>;
export type RunCredentialSessionReady = (
  session: RunCredentialCommandSession,
) => Promise<void> | void;

export class RunCredentialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCredentialValidationError";
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedString(value: unknown, label: string, maxBytes: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new RunCredentialValidationError(`${label} must be a string`);
  }
  if (byteLength(value) > maxBytes) {
    throw new RunCredentialValidationError(`${label} exceeds ${maxBytes} bytes`);
  }
  if (value?.includes("\0")) {
    throw new RunCredentialValidationError(`${label} contains a NUL byte`);
  }
}

function requiredBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new RunCredentialValidationError(`${label} must be a string`);
  }
  assertBoundedString(value, label, maxBytes);
  return value;
}

function assertOptionalNonEmptyString(value: unknown, label: string, maxBytes: number): void {
  assertBoundedString(value, label, maxBytes);
  if (typeof value === "string" && !value.trim()) {
    throw new RunCredentialValidationError(`${label} must not be empty`);
  }
}

function normalizeAuthNeeded(notices: unknown, required: boolean): RunCredentialAuthNeeded[] {
  if (notices !== undefined && !Array.isArray(notices)) {
    throw new RunCredentialValidationError("authNeeded must be an array");
  }
  const rawNotices = notices ?? [];
  const normalized: RunCredentialAuthNeeded[] = [];
  if (required && rawNotices.length === 0) {
    throw new RunCredentialValidationError("auth_needed resolution must contain a notice");
  }
  if (rawNotices.length > MAX_AUTH_NEEDED_NOTICES) {
    throw new RunCredentialValidationError(
      `auth-needed notice count exceeds ${MAX_AUTH_NEEDED_NOTICES}`,
    );
  }
  for (const [index, notice] of rawNotices.entries()) {
    if (!isRecord(notice)) {
      throw new RunCredentialValidationError(`authNeeded[${index}] must be an object`);
    }
    const reason = notice.reason;
    if (typeof reason !== "string" || !AUTH_NEEDED_REASONS.has(reason)) {
      throw new RunCredentialValidationError(`authNeeded[${index}].reason is invalid`);
    }
    assertOptionalNonEmptyString(notice.providerDomain, `authNeeded[${index}].providerDomain`, 512);
    assertOptionalNonEmptyString(notice.connectionId, `authNeeded[${index}].connectionId`, 512);
    assertOptionalNonEmptyString(notice.resource, `authNeeded[${index}].resource`, 2_048);
    assertOptionalNonEmptyString(notice.message, `authNeeded[${index}].message`, 2_048);
    if (notice.scopes !== undefined && !Array.isArray(notice.scopes)) {
      throw new RunCredentialValidationError(`authNeeded[${index}].scopes must be an array`);
    }
    const scopes = notice.scopes ?? [];
    if (scopes.length > 128) {
      throw new RunCredentialValidationError(`authNeeded[${index}].scopes exceeds 128 entries`);
    }
    for (const scope of scopes) {
      requiredBoundedString(scope, `authNeeded[${index}].scope`, 512);
      if (!scope.trim()) {
        throw new RunCredentialValidationError(`authNeeded[${index}].scope must not be empty`);
      }
    }
    if (notice.authorizationUrl !== undefined) {
      const authorizationUrl = requiredBoundedString(
        notice.authorizationUrl,
        `authNeeded[${index}].authorizationUrl`,
        4_096,
      );
      let url: URL;
      try {
        url = new URL(authorizationUrl);
      } catch {
        throw new RunCredentialValidationError(`authNeeded[${index}].authorizationUrl is invalid`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new RunCredentialValidationError(
          `authNeeded[${index}].authorizationUrl must use http or https`,
        );
      }
    }
    normalized.push({
      reason: reason as RunCredentialAuthNeeded["reason"],
      ...(typeof notice.providerDomain === "string"
        ? { providerDomain: notice.providerDomain }
        : {}),
      ...(typeof notice.connectionId === "string" ? { connectionId: notice.connectionId } : {}),
      ...(scopes.length > 0 ? { scopes: scopes as string[] } : {}),
      ...(typeof notice.resource === "string" ? { resource: notice.resource } : {}),
      ...(typeof notice.authorizationUrl === "string"
        ? { authorizationUrl: notice.authorizationUrl }
        : {}),
      ...(typeof notice.message === "string" ? { message: notice.message } : {}),
    });
  }
  return normalized;
}

function assertResolutionScope(
  resolution: Record<string, unknown>,
  expected: RunCredentialExpectedScope,
): void {
  if (
    resolution.accountId !== expected.accountId ||
    resolution.workspaceId !== expected.workspaceId ||
    resolution.sessionId !== expected.sessionId
  ) {
    throw new RunCredentialValidationError("run credential provider returned a scope mismatch");
  }
}

function normalizeRelativeFilePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new RunCredentialValidationError(`invalid run credential file path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new RunCredentialValidationError(`invalid run credential file path: ${path}`);
  }
  return path;
}

function assertEnvironmentName(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new RunCredentialValidationError(`invalid ${label}: ${name}`);
  }
}

/**
 * Validate the untrusted host-port response before any secret is written to a
 * box. The host owns credential selection; OpenGeni owns scope checks, bounds,
 * path safety, and the transport lifecycle.
 */
export function normalizeRunCredentialsResolution(
  resolution: Extract<RunCredentialsResolution, { status: "not_applicable" }>,
  expected: RunCredentialExpectedScope,
  now?: Date,
): null;
export function normalizeRunCredentialsResolution(
  resolution: Exclude<RunCredentialsResolution, { status: "not_applicable" }>,
  expected: RunCredentialExpectedScope,
  now?: Date,
): NormalizedRunCredentialMaterial;
export function normalizeRunCredentialsResolution(
  resolution: RunCredentialsResolution,
  expected: RunCredentialExpectedScope,
  now?: Date,
): NormalizedRunCredentialMaterial | null;
export function normalizeRunCredentialsResolution(
  resolution: RunCredentialsResolution,
  expected: RunCredentialExpectedScope,
  now: Date = new Date(),
): NormalizedRunCredentialMaterial | null {
  if (!isRecord(resolution)) {
    throw new RunCredentialValidationError("run credential resolution must be an object");
  }
  const candidate = resolution as unknown as Record<string, unknown>;
  if (
    candidate.status !== "ok" &&
    candidate.status !== "auth_needed" &&
    candidate.status !== "not_applicable"
  ) {
    throw new RunCredentialValidationError("run credential resolution status is invalid");
  }
  assertResolutionScope(candidate, expected);
  if (candidate.status === "not_applicable") return null;
  const authNeeded = normalizeAuthNeeded(candidate.authNeeded, candidate.status === "auth_needed");
  if (candidate.status === "auth_needed") {
    return {
      environment: {},
      files: [],
      fileEnvironment: {},
      expiresAt: null,
      authNeeded,
      redactions: [],
    };
  }

  if (!isRecord(candidate.environment)) {
    throw new RunCredentialValidationError("run credential environment must be an object");
  }
  const environmentEntries = Object.entries(candidate.environment);
  if (environmentEntries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new RunCredentialValidationError(
      `run credential environment exceeds ${MAX_ENVIRONMENT_ENTRIES} entries`,
    );
  }
  let totalBytes = 0;
  const environment: Record<string, string> = {};
  for (const [name, rawValue] of environmentEntries) {
    assertEnvironmentName(name, "run credential environment name");
    const value = requiredBoundedString(
      rawValue,
      `run credential environment value: ${name}`,
      MAX_ENVIRONMENT_VALUE_BYTES,
    );
    const valueBytes = byteLength(value);
    totalBytes += valueBytes;
    Object.defineProperty(environment, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  if (candidate.files !== undefined && !Array.isArray(candidate.files)) {
    throw new RunCredentialValidationError("run credential files must be an array");
  }
  const files = candidate.files ?? [];
  if (files.length > MAX_CREDENTIAL_FILES) {
    throw new RunCredentialValidationError(
      `run credential file count exceeds ${MAX_CREDENTIAL_FILES}`,
    );
  }
  const paths = new Map<string, string>();
  const normalizedFiles = files.map((file, index) => {
    if (!isRecord(file)) {
      throw new RunCredentialValidationError(`run credential file ${index} must be an object`);
    }
    const path = normalizeRelativeFilePath(
      requiredBoundedString(file.path, `run credential file ${index} path`, 240),
    );
    const folded = path.toLocaleLowerCase("en-US");
    const collision = paths.get(folded);
    if (collision !== undefined) {
      throw new RunCredentialValidationError(
        `run credential file path collision: ${collision} and ${path}`,
      );
    }
    paths.set(folded, path);
    const content = requiredBoundedString(
      file.content,
      `run credential file content: ${path}`,
      MAX_CREDENTIAL_FILE_BYTES,
    );
    const contentBytes = byteLength(content);
    if (file.mode !== undefined && file.mode !== "0400" && file.mode !== "0600") {
      throw new RunCredentialValidationError(`run credential file mode is invalid: ${path}`);
    }
    totalBytes += contentBytes;
    return { path, content, mode: file.mode ?? "0600" } as RunCredentialFile;
  });

  if (candidate.fileEnvironment !== undefined && !isRecord(candidate.fileEnvironment)) {
    throw new RunCredentialValidationError("run credential fileEnvironment must be an object");
  }
  const fileEnvironment: Record<string, string> = {};
  for (const [name, unresolvedPath] of Object.entries(candidate.fileEnvironment ?? {})) {
    assertEnvironmentName(name, "run credential file environment name");
    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      throw new RunCredentialValidationError(
        `run credential environment name is declared twice: ${name}`,
      );
    }
    const path = normalizeRelativeFilePath(
      requiredBoundedString(unresolvedPath, `run credential file environment path: ${name}`, 240),
    );
    if (!paths.has(path.toLocaleLowerCase("en-US"))) {
      throw new RunCredentialValidationError(
        `run credential file environment references an unknown file: ${path}`,
      );
    }
    Object.defineProperty(fileEnvironment, name, {
      value: path,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (environmentEntries.length + Object.keys(fileEnvironment).length > MAX_ENVIRONMENT_ENTRIES) {
    throw new RunCredentialValidationError(
      `combined run credential environment exceeds ${MAX_ENVIRONMENT_ENTRIES} entries`,
    );
  }
  if (totalBytes > MAX_TOTAL_MATERIAL_BYTES) {
    throw new RunCredentialValidationError(
      `run credential material exceeds ${MAX_TOTAL_MATERIAL_BYTES} bytes`,
    );
  }

  const redactions: RunCredentialRedaction[] = Object.entries(environment).map(([name, value]) => ({
    name,
    value,
  }));
  if (candidate.redactions !== undefined && !Array.isArray(candidate.redactions)) {
    throw new RunCredentialValidationError("run credential redactions must be an array");
  }
  const additionalRedactions = candidate.redactions ?? [];
  if (additionalRedactions.length > MAX_REDACTION_VALUES) {
    throw new RunCredentialValidationError(
      `run credential redactions exceed ${MAX_REDACTION_VALUES} entries`,
    );
  }
  for (const [index, redaction] of additionalRedactions.entries()) {
    if (!isRecord(redaction)) {
      throw new RunCredentialValidationError(`redactions[${index}] must be an object`);
    }
    const name = requiredBoundedString(redaction.name, `redactions[${index}].name`, 128);
    const value = requiredBoundedString(
      redaction.value,
      `redactions[${index}].value`,
      MAX_ENVIRONMENT_VALUE_BYTES,
    );
    if (!name.trim() || !value) {
      throw new RunCredentialValidationError(`redactions[${index}] must contain a name and value`);
    }
    redactions.push({ name, value });
  }

  let expiresAt: Date | null = null;
  if (candidate.expiresAt !== undefined && candidate.expiresAt !== null) {
    const expiry = requiredBoundedString(candidate.expiresAt, "run credential expiry", 128);
    expiresAt = new Date(expiry);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      throw new RunCredentialValidationError("run credential expiry is invalid or already expired");
    }
  }
  return {
    environment,
    files: normalizedFiles,
    fileEnvironment,
    expiresAt,
    authNeeded,
    redactions,
  };
}

function assertPathIdentity(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new RunCredentialValidationError(`${label} is not safe for a credential path`);
  }
  return value;
}

export function runCredentialRoot(sessionId: string): string {
  return `/tmp/opengeni-run-credentials/${assertPathIdentity(sessionId, "sessionId")}`;
}

export function runCredentialPointerFile(sessionId: string): string {
  return `${runCredentialRoot(sessionId)}/current`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function portableBase64DecodeCommand(): string {
  return [
    "{",
    "if printf %s QQ== | base64 -d >/dev/null 2>&1; then base64 -d",
    "elif printf %s QQ== | base64 -D >/dev/null 2>&1; then base64 -D",
    "elif command -v openssl >/dev/null 2>&1; then openssl base64 -d -A",
    "else exit 69",
    "fi",
    "}",
  ].join("\n");
}

/** Prefer util-linux flock; fall back to an atomic, stale-reaped mkdir lock. */
function pointerLockAcquireCommands(root: string): string[] {
  const lockFile = shellQuote(`${root}/.pointer.lock`);
  const lockDirectory = shellQuote(`${root}/.pointer.lockdir`);
  return [
    `if command -v flock >/dev/null 2>&1; then`,
    `  exec 9>${lockFile}`,
    "  flock -w 30 9",
    "  _opengeni_pointer_lock_kind=flock",
    "else",
    `  _opengeni_pointer_lock_dir=${lockDirectory}`,
    "  _opengeni_pointer_lock_deadline=$(($(date +%s) + 30))",
    '  while ! mkdir "$_opengeni_pointer_lock_dir" 2>/dev/null; do',
    `    if find "$_opengeni_pointer_lock_dir" -prune -mmin +${PORTABLE_LOCK_STALE_MINUTES} -print 2>/dev/null | grep -q .; then`,
    '      _opengeni_stale_lock="${_opengeni_pointer_lock_dir}.stale.$$"',
    '      if mv "$_opengeni_pointer_lock_dir" "$_opengeni_stale_lock" 2>/dev/null; then',
    '        rm -rf -- "$_opengeni_stale_lock"',
    "        continue",
    "      fi",
    "    fi",
    '    [ "$(date +%s)" -lt "$_opengeni_pointer_lock_deadline" ] || exit 73',
    "    sleep 0.1",
    "  done",
    "  _opengeni_pointer_lock_kind=directory",
    `  trap 'rmdir ${lockDirectory} 2>/dev/null || :' EXIT HUP INT TERM`,
    "fi",
  ];
}

function pointerLockReleaseCommands(): string[] {
  return [
    'if [ "${_opengeni_pointer_lock_kind:-}" = directory ]; then',
    '  rmdir "$_opengeni_pointer_lock_dir" 2>/dev/null || :',
    "  trap - EXIT HUP INT TERM",
    "fi",
  ];
}

function outputOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const candidate = result as {
    output?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return [candidate.output, candidate.stdout, candidate.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

async function runCredentialCommand(
  session: RunCredentialCommandSession,
  cmd: string,
  commandRunner?: RunCredentialCommandRunner,
): Promise<void> {
  const marked = `set -eu\n${cmd}\nprintf '\\n${COMMAND_OK_MARKER}\\n'`;
  const args: ExecCommandArgs = {
    cmd: `env -u BASH_ENV bash --noprofile --norc -c ${shellQuote(marked)}`,
    yieldTimeMs: 120_000,
    maxOutputTokens: 4_000,
  };
  const result = commandRunner
    ? await commandRunner(session, args)
    : session.exec
      ? await session.exec(args)
      : session.execCommand
        ? await session.execCommand(args)
        : undefined;
  if (!outputOf(result).includes(COMMAND_OK_MARKER)) {
    throw new Error("run credential materialization command failed");
  }
}

async function writeCredentialFile(
  session: RunCredentialCommandSession,
  path: string,
  content: string,
  commandRunner?: RunCredentialCommandRunner,
): Promise<void> {
  await runCredentialCommand(session, `: > ${shellQuote(path)}`, commandRunner);
  const encoded = base64(content);
  for (let offset = 0; offset < encoded.length; offset += WRITE_CHUNK_BYTES) {
    const chunk = encoded.slice(offset, offset + WRITE_CHUNK_BYTES);
    await runCredentialCommand(
      session,
      `printf %s ${shellQuote(chunk)} | ${portableBase64DecodeCommand()} >> ${shellQuote(path)}`,
      commandRunner,
    );
  }
  await runCredentialCommand(
    session,
    `[ "$(wc -c < ${shellQuote(path)} | tr -d '[:space:]')" = ${shellQuote(String(byteLength(content)))} ]`,
    commandRunner,
  );
}

export type MaterializeRunCredentialsOptions = {
  sessionId: string;
  attemptId: string;
  executionGeneration: number;
  /** Initial provision after recovery may prune generations from older attempts. */
  pruneOtherAttempts?: boolean;
  /** An all-auth-needed replacement removes every prior readable generation. */
  prunePreviousGenerations?: boolean;
  /** Renewal keeps the active and immediately prior same-attempt generations. */
  pruneSupersededGenerations?: boolean;
  commandRunner?: RunCredentialCommandRunner;
};

/** Materialize one complete immutable generation, then atomically flip current. */
export async function materializeRunCredentials(
  session: RunCredentialCommandSession,
  material: NormalizedRunCredentialMaterial,
  options: MaterializeRunCredentialsOptions,
): Promise<void> {
  const root = runCredentialRoot(options.sessionId);
  const attemptId = assertPathIdentity(options.attemptId, "attemptId");
  if (!Number.isSafeInteger(options.executionGeneration) || options.executionGeneration < 0) {
    throw new RunCredentialValidationError("executionGeneration must be a non-negative integer");
  }
  const nonce = crypto.randomUUID();
  const prefix = `${attemptId}-${options.executionGeneration}-`;
  const versionName = `${attemptId}-${options.executionGeneration}-${nonce}`;
  const stage = `${root}/versions/.stage-${versionName}`;
  const version = `${root}/versions/${versionName}`;
  for (const file of material.files) {
    const mode = file.mode ?? "0600";
    if (mode !== "0400" && mode !== "0600") {
      throw new RunCredentialValidationError(`run credential file mode is invalid: ${file.path}`);
    }
  }
  await runCredentialCommand(
    session,
    [
      "umask 077",
      `mkdir -p -- ${shellQuote(`${root}/versions`)}`,
      `chmod 0700 -- ${shellQuote(root)} ${shellQuote(`${root}/versions`)}`,
      `rm -rf -- ${shellQuote(stage)}`,
      `mkdir -p -- ${shellQuote(`${stage}/files`)}`,
    ].join("\n"),
    options.commandRunner,
  );

  const environmentLines = [
    ...Object.entries(material.environment).map(
      ([name, value]) => `export ${name}=${shellQuote(value)}`,
    ),
    ...Object.entries(material.fileEnvironment).map(
      ([name, path]) => `export ${name}=${shellQuote(`${version}/files/${path}`)}`,
    ),
  ];
  await writeCredentialFile(
    session,
    `${stage}/env`,
    environmentLines.length > 0 ? `${environmentLines.join("\n")}\n` : "",
    options.commandRunner,
  );
  await runCredentialCommand(
    session,
    `chmod 0600 -- ${shellQuote(`${stage}/env`)}`,
    options.commandRunner,
  );

  for (const file of material.files) {
    const target = `${stage}/files/${file.path}`;
    const parent = target.slice(0, target.lastIndexOf("/"));
    await runCredentialCommand(session, `mkdir -p -- ${shellQuote(parent)}`, options.commandRunner);
    await writeCredentialFile(session, target, file.content, options.commandRunner);
    await runCredentialCommand(
      session,
      `chmod ${shellQuote(file.mode ?? "0600")} -- ${shellQuote(target)}`,
      options.commandRunner,
    );
  }

  await runCredentialCommand(
    session,
    [
      ...pointerLockAcquireCommands(root),
      `previous=$(cat -- ${shellQuote(`${root}/current`)} 2>/dev/null || :)`,
      `mv -- ${shellQuote(stage)} ${shellQuote(version)}`,
      `printf '%s\\n' ${shellQuote(versionName)} > ${shellQuote(`${root}/.next`)}`,
      `mv -f -- ${shellQuote(`${root}/.next`)} ${shellQuote(`${root}/current`)}`,
      ...(options.prunePreviousGenerations
        ? [
            `find ${shellQuote(`${root}/versions`)} -mindepth 1 -maxdepth 1 ! -name ${shellQuote(versionName)} -exec rm -rf -- {} +`,
          ]
        : options.pruneOtherAttempts
          ? [
              `find ${shellQuote(`${root}/versions`)} -mindepth 1 -maxdepth 1 ! -name ${shellQuote(`${attemptId}-${options.executionGeneration}-*`)} -exec rm -rf -- {} +`,
            ]
          : options.pruneSupersededGenerations
            ? [
                `for candidate in ${shellQuote(`${root}/versions`)}/${prefix}*; do`,
                `  [ -e "$candidate" ] || continue`,
                `  name=\${candidate##*/}`,
                `  [ "$name" = ${shellQuote(versionName)} ] || [ "$name" = "$previous" ] || rm -rf -- "$candidate"`,
                "done",
              ]
            : []),
      ...pointerLockReleaseCommands(),
    ].join("\n"),
    options.commandRunner,
  );
}

export async function clearRunCredentials(
  session: RunCredentialCommandSession,
  sessionId: string,
  commandRunner?: RunCredentialCommandRunner,
): Promise<void> {
  const root = runCredentialRoot(sessionId);
  await runCredentialCommand(
    session,
    [
      `if [ -d ${shellQuote(root)} ]; then`,
      ...pointerLockAcquireCommands(root).map((line) => `  ${line}`),
      `  rm -f -- ${shellQuote(`${root}/current`)} ${shellQuote(`${root}/.next`)}`,
      `  rm -rf -- ${shellQuote(`${root}/versions`)}`,
      ...pointerLockReleaseCommands().map((line) => `  ${line}`),
      "fi",
    ].join("\n"),
    commandRunner,
  );
}

/**
 * Remove only generations owned by one attempt. A successor may already have
 * atomically activated its own pointer after queue admission; this cleanup must
 * never clear or overwrite that newer generation.
 */
export async function clearRunCredentialsForAttempt(
  session: RunCredentialCommandSession,
  options: Pick<
    MaterializeRunCredentialsOptions,
    "sessionId" | "attemptId" | "executionGeneration"
  >,
  commandRunner?: RunCredentialCommandRunner,
): Promise<void> {
  const root = runCredentialRoot(options.sessionId);
  const attemptId = assertPathIdentity(options.attemptId, "attemptId");
  if (!Number.isSafeInteger(options.executionGeneration) || options.executionGeneration < 0) {
    throw new RunCredentialValidationError("executionGeneration must be a non-negative integer");
  }
  const prefix = `${attemptId}-${options.executionGeneration}-`;
  await runCredentialCommand(
    session,
    [
      `if [ -d ${shellQuote(root)} ]; then`,
      ...pointerLockAcquireCommands(root).map((line) => `  ${line}`),
      `  if [ -r ${shellQuote(`${root}/current`)} ]; then`,
      `    current=$(cat -- ${shellQuote(`${root}/current`)} 2>/dev/null || :)`,
      `    case "$current" in ${shellQuote(prefix)}*) rm -f -- ${shellQuote(`${root}/current`)} ;; esac`,
      "  fi",
      `  if [ -d ${shellQuote(`${root}/versions`)} ]; then`,
      `    find ${shellQuote(`${root}/versions`)} -mindepth 1 -maxdepth 1 -name ${shellQuote(`${prefix}*`)} -exec rm -rf -- {} +`,
      `    find ${shellQuote(`${root}/versions`)} -mindepth 1 -maxdepth 1 -name ${shellQuote(`.stage-${prefix}*`)} -exec rm -rf -- {} +`,
      "  fi",
      ...pointerLockReleaseCommands().map((line) => `  ${line}`),
      "fi",
    ].join("\n"),
    commandRunner,
  );
}

/** Prefix one sandbox command so every new process observes the active generation. */
export function withRunCredentialEnvironment(cmd: string, sessionId: string): string {
  const root = runCredentialRoot(sessionId);
  const pointerFile = runCredentialPointerFile(sessionId);
  return [
    `if [ -r ${shellQuote(pointerFile)} ]; then`,
    `  _opengeni_credential_version=$(cat -- ${shellQuote(pointerFile)} 2>/dev/null || :)`,
    '  case "$_opengeni_credential_version" in',
    "    ''|*[!A-Za-z0-9_-]*) ;;",
    "    *)",
    `      _opengeni_credential_env=${shellQuote(`${root}/versions`)}/"$_opengeni_credential_version/env"`,
    '      if [ -r "$_opengeni_credential_env" ]; then',
    "        set -a",
    '        . "$_opengeni_credential_env"',
    "        set +a",
    "      fi",
    "      unset _opengeni_credential_env",
    "      ;;",
    "  esac",
    "  unset _opengeni_credential_version",
    "fi",
    cmd,
  ].join("\n");
}

/**
 * Preserve the provider session identity/capabilities while decorating only
 * command creation. Non-command methods stay bound to the original instance.
 */
export function withRunCredentialsSession<T extends object>(session: T, sessionId: string): T {
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "exec" || property === "execCommand") {
        const command = Reflect.get(target, property, target) as
          | ((args: ExecCommandArgs) => Promise<unknown>)
          | undefined;
        if (!command) return undefined;
        return async (args: ExecCommandArgs) =>
          await command.call(target, {
            ...args,
            cmd: withRunCredentialEnvironment(args.cmd, sessionId),
          });
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Decorate every client-created/resumed session after the host seeds it. */
export function withRunCredentialsClient(
  client: SandboxClient,
  sessionId: string,
  onSessionReady?: RunCredentialSessionReady,
): SandboxClient {
  const decorated = new WeakMap<object, SandboxSessionLike>();
  const wrap = async <T extends SandboxSessionLike>(session: T): Promise<T> => {
    const existing = decorated.get(session);
    if (existing) return existing as T;
    await onSessionReady?.(session);
    const wrapped = withRunCredentialsSession(session, sessionId);
    decorated.set(session, wrapped);
    return wrapped;
  };
  return {
    backendId: client.backendId,
    ...(client.supportsDefaultOptions !== undefined
      ? { supportsDefaultOptions: client.supportsDefaultOptions }
      : {}),
    ...(client.create
      ? {
          create: async (...args: any[]) => await wrap(await (client.create as any)(...args)),
        }
      : {}),
    ...(client.resume
      ? {
          resume: async (...args: any[]) => await wrap(await (client.resume as any)(...args)),
        }
      : {}),
    ...(client.delete
      ? {
          delete: async (state: SandboxSessionState) => await client.delete!(state),
        }
      : {}),
    ...(client.serializeSessionState
      ? {
          serializeSessionState: async (state: SandboxSessionState, options) =>
            await client.serializeSessionState!(state, options),
        }
      : {}),
    ...(client.canPersistOwnedSessionState
      ? {
          canPersistOwnedSessionState: async (state: SandboxSessionState) =>
            await client.canPersistOwnedSessionState!(state),
        }
      : {}),
    ...(client.canReusePreservedOwnedSession
      ? {
          canReusePreservedOwnedSession: async (state: SandboxSessionState) =>
            await client.canReusePreservedOwnedSession!(state),
        }
      : {}),
    ...(client.deserializeSessionState
      ? {
          deserializeSessionState: async (state: Record<string, unknown>) =>
            await client.deserializeSessionState!(state),
        }
      : {}),
  };
}
