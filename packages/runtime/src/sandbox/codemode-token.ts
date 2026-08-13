import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";

import type {
  ExecCommandArgs,
  SandboxClient,
  SandboxSessionLike,
  SandboxSessionState,
} from "@openai/agents/sandbox";

const MAX_CODEMODE_SESSION_ID_BYTES = 512;

export class CodemodeTokenPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodeTokenPathError";
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assertCodemodeSessionId(sessionId: string): string {
  if (
    !sessionId ||
    sessionId.trim() !== sessionId ||
    new TextEncoder().encode(sessionId).byteLength > MAX_CODEMODE_SESSION_ID_BYTES ||
    sessionId.includes("\0")
  ) {
    throw new CodemodeTokenPathError("Codemode session id is invalid");
  }
  return sessionId;
}

function assertCodemodeFilePath(value: string, label: string): string {
  if (!value || value.includes("\0") || !posixPath.isAbsolute(value)) {
    throw new CodemodeTokenPathError(`${label} must be absolute`);
  }
  return posixPath.normalize(value);
}

export function shellCodemodePath(value: string): string {
  return shellQuote(assertCodemodeFilePath(value, "Codemode token file"));
}

/**
 * Derive the per-session token file beside the legacy manifest pointer.
 *
 * The manifest pointer stays box-global so an already-warm shared sandbox does
 * not receive an illegal environment delta. Every OpenGeni command overrides
 * that pointer with this deterministic path. The hash is path hygiene and
 * avoids disclosing host/session ids in filenames; filesystem paths are not an
 * authorization boundary. The delegated bearer's session claim remains the
 * authority boundary for Codemode calls.
 */
export function codemodeTokenFileForSession(manifestTokenFile: string, sessionId: string): string {
  const normalizedManifestFile = assertCodemodeFilePath(
    manifestTokenFile,
    "Codemode manifest token file",
  );
  const digest = createHash("sha256").update(assertCodemodeSessionId(sessionId)).digest("hex");
  return posixPath.join(posixPath.dirname(normalizedManifestFile), "codemode-tokens", digest);
}

export function codemodeTokenFileFromEnvironment(
  environment: Readonly<Record<string, string>>,
  sessionId: string,
): string {
  const manifestTokenFile =
    environment.OPENGENI_CODEMODE_TOKEN_FILE ??
    `${environment.HOME ?? "/workspace"}/.opengeni/codemode-token`;
  return codemodeTokenFileForSession(manifestTokenFile, sessionId);
}

/**
 * Prefix one sandbox command with its attempt-current Codemode routing.
 *
 * The token pointer is session-specific. The URL is deliberately projected on
 * every exec too: a warm managed box keeps its baked manifest environment, but
 * the externally reachable deployment/tunnel origin may change between turns.
 * Per-command export makes a resumed box use the current route without an
 * illegal live-manifest environment mutation.
 */
export function withCodemodeTokenEnvironment(
  cmd: string,
  tokenFile: string,
  codemodeUrl?: string,
): string {
  return [
    `export OPENGENI_CODEMODE_TOKEN_FILE=${shellCodemodePath(tokenFile)}`,
    ...(codemodeUrl ? [`export OPENGENI_CODEMODE_URL=${shellQuote(codemodeUrl)}`] : []),
    cmd,
  ].join("\n");
}

/** Preserve provider identity/capabilities while decorating command creation. */
export function withCodemodeTokenSession<T extends object>(
  session: T,
  tokenFile: string,
  codemodeUrl?: string,
): T {
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
            cmd: withCodemodeTokenEnvironment(args.cmd, tokenFile, codemodeUrl),
          });
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Decorate every client-created/resumed session with one session pointer. */
export function withCodemodeTokenClient(
  client: SandboxClient,
  tokenFile: string,
  codemodeUrl?: string,
): SandboxClient {
  const decorated = new WeakMap<object, SandboxSessionLike>();
  const wrap = <T extends SandboxSessionLike>(session: T): T => {
    const existing = decorated.get(session);
    if (existing) return existing as T;
    const wrapped = withCodemodeTokenSession(session, tokenFile, codemodeUrl);
    decorated.set(session, wrapped);
    return wrapped;
  };
  return {
    backendId: client.backendId,
    ...(client.supportsDefaultOptions !== undefined
      ? { supportsDefaultOptions: client.supportsDefaultOptions }
      : {}),
    ...(client.create
      ? { create: async (...args: any[]) => wrap(await (client.create as any)(...args)) }
      : {}),
    ...(client.resume
      ? { resume: async (...args: any[]) => wrap(await (client.resume as any)(...args)) }
      : {}),
    ...(client.delete
      ? { delete: async (state: SandboxSessionState) => await client.delete!(state) }
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
  } as SandboxClient;
}
