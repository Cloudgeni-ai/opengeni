/**
 * The attempt's secret-value memory (docs/secrets.md, Masking).
 *
 * One `SecretValueMemory` per agent attempt holds every secret value the
 * attempt is known to handle, labelled with what should appear instead:
 *
 * - values its secret resolvers return on any surface, labelled with the
 *   reference that resolved them;
 * - credentials Opengeni itself puts into the attempt (the Codemode bearer
 *   and its renewals, git binding tokens, run credentials, MCP header values),
 *   labelled `[opengeni credential: <kind>]`;
 * - best effort, the hosted values of secrets this session tree used before.
 *
 * The memory masks tool results before the model sees them, every model
 * request, and (through the database backstop) every durable write the
 * attempt makes. Nothing here may fail an attempt: errors are contained and
 * reported as metadata-only diagnostics.
 */
import {
  rememberingSecretResolver,
  SecretValueMemory,
  secretCredentialMaskLabel,
  type SecretPrincipal,
  type SecretResolver,
} from "@opengeni/contracts";
import { loadSessionTreeSecretValues } from "@opengeni/core";
import { withSecretValueMasking, type Database } from "@opengeni/db";
import { activeAttemptSecretValues, withAttemptSecretValues } from "@opengeni/runtime";

type DiagnosticSink = {
  warn(message: string, attributes?: Record<string, unknown>): void;
};

export function createAttemptSecretValueMemory(
  observability?: DiagnosticSink | null,
): SecretValueMemory {
  return new SecretValueMemory({
    onDiagnostic: (diagnostic) => {
      try {
        observability?.warn("secret value masking failed; text kept as written", {
          stage: diagnostic.stage,
          errorClass: diagnostic.error,
        });
      } catch {
        // Diagnostics never affect the attempt.
      }
    },
  });
}

/**
 * Run one attempt with its memory active for the runtime seams that read it
 * implicitly and for every durable write (the database backstop).
 */
export function runWithAttemptSecretValues<T>(memory: SecretValueMemory, run: () => T): T {
  return withAttemptSecretValues(memory, () => withSecretValueMasking(memory, run));
}

export function currentAttemptSecretValues(): SecretValueMemory | undefined {
  return activeAttemptSecretValues();
}

/** Remember a credential Opengeni injected; values shorter than the minimum are ignored. */
export function rememberAttemptCredential(
  memory: SecretValueMemory | null | undefined,
  value: string | null | undefined,
  kind: string,
): void {
  if (!memory || typeof value !== "string" || value.length === 0) return;
  try {
    const label = secretCredentialMaskLabel(kind);
    memory.remember(value, label);
    // An Authorization header value is usually "Bearer <token>"; the token
    // alone appears in text more often than the header.
    const bearer = /^(?:Bearer|Basic|token)\s+(\S+)$/iu.exec(value.trim());
    if (bearer?.[1]) memory.remember(bearer[1], label);
  } catch {
    // Remembering never fails the attempt.
  }
}

/**
 * The same resolver, remembering every value it returns. The memory is the
 * explicit one, or the attempt's active memory at resolution time.
 */
export function rememberingAttemptSecretResolver(
  resolver: SecretResolver,
  memory?: SecretValueMemory | null,
): SecretResolver {
  return rememberingSecretResolver(resolver, () => memory ?? currentAttemptSecretValues());
}

const SECRET_ENVIRONMENT_NAME =
  /TOKEN|SECRET|PASSW|PWD|KEY|CREDENTIAL|AUTH|SESSION|COOKIE|BEARER|PRIVATE|SIGNATURE/iu;
/** Names of variables that hold where a credential is, not the credential. */
const CREDENTIAL_LOCATION_NAME =
  /(?:_FILE|_PATH|_DIR|_URL|_ENDPOINT)$|^GOOGLE_APPLICATION_CREDENTIALS$/iu;
/** Values that are file paths are not credentials either. */
const PATH_VALUE = /^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\)[^\s]*$/u;
/** MCP headers that carry credentials; others (`Accept`, `X-Org`) are not secret. */
const SECRET_HEADER_NAME =
  /^(?:authorization|proxy-authorization|cookie)$|token|key|secret|auth|passw|session|signature/iu;
/** Run-credential environment values are remembered only when long enough
 * to be key material: a region or account name must not be masked. */
const RUN_CREDENTIAL_MIN_CHARS = 12;

/**
 * Remember the secret parts of host run-credential material: environment
 * values whose names say they are secret, single-line credential files, and
 * MCP header values whose names say they carry credentials.
 */
export function rememberRunCredentialMaterial(
  memory: SecretValueMemory | null | undefined,
  material:
    | {
        environment?: Record<string, string>;
        files?: ReadonlyArray<{ content: string }>;
        mcp?: ReadonlyArray<{ headers?: Record<string, string> }> | undefined;
      }
    | null
    | undefined,
): void {
  if (!memory || !material) return;
  try {
    for (const [name, value] of Object.entries(material.environment ?? {})) {
      if (
        typeof value === "string" &&
        value.length >= RUN_CREDENTIAL_MIN_CHARS &&
        SECRET_ENVIRONMENT_NAME.test(name) &&
        !CREDENTIAL_LOCATION_NAME.test(name) &&
        !PATH_VALUE.test(value)
      ) {
        rememberAttemptCredential(memory, value, `run credential ${name}`);
      }
    }
    for (const file of material.files ?? []) {
      const content = typeof file?.content === "string" ? file.content.trim() : "";
      if (content.length >= RUN_CREDENTIAL_MIN_CHARS && !/[\r\n]/u.test(content)) {
        rememberAttemptCredential(memory, content, "run credential file");
      }
    }
    for (const entry of material.mcp ?? []) {
      for (const [name, value] of Object.entries(entry?.headers ?? {})) {
        if (
          typeof value === "string" &&
          value.length >= RUN_CREDENTIAL_MIN_CHARS &&
          SECRET_HEADER_NAME.test(name)
        ) {
          rememberAttemptCredential(memory, value, "mcp header");
        }
      }
    }
  } catch {
    // Remembering never fails the attempt.
  }
}

/** A refresh runs at most this often; the first load starts at once. */
const SESSION_TREE_REFRESH_INTERVAL_MS = 10_000;

/**
 * Best effort: remember the hosted values of secrets this session tree used
 * before (and keep learning new uses, for example by run_on, which resolves
 * in the API). Failures only produce a metadata-only warning.
 */
export function attachSessionTreeSecretValues(input: {
  memory: SecretValueMemory | null | undefined;
  db: Database;
  encryptionKey: Uint8Array | null;
  principal: Extract<SecretPrincipal, { kind: "attempt" }>;
  observability?: DiagnosticSink | null;
}): void {
  const memory = input.memory;
  if (!memory || input.encryptionKey === null) return;
  let latestAt: Date | null = null;
  let lastStartedAt = 0;
  let inFlight: Promise<void> | null = null;
  // Tool results wait (bounded) only for the first load; later refreshes run
  // in the background and take effect from the next result.
  let firstLoad: Promise<void> | null = null;
  let firstLoadDone = false;
  const load = async () => {
    const result = await loadSessionTreeSecretValues(
      { db: input.db, encryptionKey: input.encryptionKey },
      input.principal,
      { after: latestAt },
    );
    for (const entry of result.entries) memory.remember(entry.value, entry.label);
    if (result.latestAt && (!latestAt || result.latestAt > latestAt)) latestAt = result.latestAt;
  };
  const start = (): Promise<void> => {
    lastStartedAt = Date.now();
    inFlight = load()
      .catch((error: unknown) => {
        try {
          input.observability?.warn("earlier secret values could not be loaded for masking", {
            errorClass: error instanceof Error ? error.name : typeof error,
          });
        } catch {
          // Diagnostics never affect the attempt.
        }
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  memory.setRefresher(async () => {
    if (!firstLoadDone) {
      await firstLoad;
      return;
    }
    if (inFlight) return;
    if (Date.now() - lastStartedAt < SESSION_TREE_REFRESH_INTERVAL_MS) return;
    void start();
  });
  firstLoad = start().finally(() => {
    firstLoadDone = true;
  });
}
