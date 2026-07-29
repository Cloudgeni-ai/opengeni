import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";

import type {
  ExecCommandArgs,
  SandboxClient,
  SandboxSessionLike,
  SandboxSessionState,
} from "@openai/agents/sandbox";

const MAX_TOOLSPACE_SESSION_ID_BYTES = 512;
const HOME_RELATIVE_TOOLSPACE_PREFIX = "$HOME/";

export class ToolspaceTokenPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolspaceTokenPathError";
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assertToolspaceSessionId(sessionId: string): string {
  if (
    !sessionId ||
    sessionId.trim() !== sessionId ||
    new TextEncoder().encode(sessionId).byteLength > MAX_TOOLSPACE_SESSION_ID_BYTES ||
    sessionId.includes("\0")
  ) {
    throw new ToolspaceTokenPathError("Toolspace session id is invalid");
  }
  return sessionId;
}

function isHomeRelativeToolspacePath(value: string): boolean {
  if (!value.startsWith(HOME_RELATIVE_TOOLSPACE_PREFIX)) return false;
  const relative = value.slice(HOME_RELATIVE_TOOLSPACE_PREFIX.length);
  const segments = relative.split("/");
  return (
    relative.length > 0 &&
    !relative.includes("\0") &&
    segments.every(
      (segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment),
    ) &&
    posixPath.normalize(relative) === relative
  );
}

function assertToolspaceFilePath(value: string, label: string): string {
  if (
    !value ||
    value.includes("\0") ||
    (!posixPath.isAbsolute(value) && !isHomeRelativeToolspacePath(value))
  ) {
    throw new ToolspaceTokenPathError(`${label} must be absolute or use the trusted $HOME/ prefix`);
  }
  return posixPath.isAbsolute(value) ? posixPath.normalize(value) : value;
}

export function shellToolspacePath(value: string): string {
  const validated = assertToolspaceFilePath(value, "Toolspace token file");
  return isHomeRelativeToolspacePath(validated) ? `"${validated}"` : shellQuote(validated);
}

/**
 * Derive the per-session token file beside the legacy manifest pointer.
 *
 * The manifest pointer stays box-global so an already-warm shared sandbox does
 * not receive an illegal environment delta. Every OpenGeni command overrides
 * that pointer with this deterministic path. The hash is path hygiene and
 * avoids disclosing host/session ids in filenames; filesystem paths are not an
 * authorization boundary. The delegated bearer's session claim remains the
 * authority boundary for Toolspace calls.
 */
export function toolspaceTokenFileForSession(manifestTokenFile: string, sessionId: string): string {
  const normalizedManifestFile = assertToolspaceFilePath(
    manifestTokenFile,
    "Toolspace manifest token file",
  );
  const digest = createHash("sha256").update(assertToolspaceSessionId(sessionId)).digest("hex");
  return posixPath.join(posixPath.dirname(normalizedManifestFile), "toolspace-tokens", digest);
}

export function toolspaceTokenFileFromEnvironment(
  environment: Readonly<Record<string, string>>,
  sessionId: string,
): string {
  const manifestTokenFile =
    environment.OPENGENI_TOOLSPACE_TOKEN_FILE ??
    `${environment.HOME ?? "/workspace"}/.opengeni/toolspace-token`;
  return toolspaceTokenFileForSession(manifestTokenFile, sessionId);
}

/** Prefix one sandbox command with its session-specific Toolspace pointer. */
export function withToolspaceTokenEnvironment(cmd: string, tokenFile: string): string {
  return [`export OPENGENI_TOOLSPACE_TOKEN_FILE=${shellToolspacePath(tokenFile)}`, cmd].join("\n");
}

/** Preserve provider identity/capabilities while decorating command creation. */
export function withToolspaceTokenSession<T extends object>(session: T, tokenFile: string): T {
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
            cmd: withToolspaceTokenEnvironment(args.cmd, tokenFile),
          });
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Decorate every client-created/resumed session with one session pointer. */
export function withToolspaceTokenClient(client: SandboxClient, tokenFile: string): SandboxClient {
  const decorated = new WeakMap<object, SandboxSessionLike>();
  const wrap = <T extends SandboxSessionLike>(session: T): T => {
    const existing = decorated.get(session);
    if (existing) return existing as T;
    const wrapped = withToolspaceTokenSession(session, tokenFile);
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
