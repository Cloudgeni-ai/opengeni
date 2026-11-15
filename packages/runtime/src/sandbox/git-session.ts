import { createHash } from "node:crypto";

import type { ExecCommandArgs, SandboxClient, SandboxSessionLike } from "@openai/agents/sandbox";

/**
 * Per-chat Git credential state on a shared sandbox.
 *
 * Several chats can share one box (a parent and the workers it starts, or
 * chats created together). Each chat's Git credentials are bound to that
 * chat's own turn: a personal GitHub broker pass, the broker routes Git is
 * redirected to, the credential helper that answers with the pass, and the
 * provider CLI (`gh`) logic that reads it. They live in one directory per
 * chat, `$OPENGENI_GIT_CREDENTIALS_DIR/sessions/<key>`, so the chat that ran
 * last never overwrites another chat's pass.
 *
 * Every command Opengeni runs for a chat exports the chat's directory as
 * OPENGENI_GIT_SESSION_DIR, and adds the chat's broker routes to Git through
 * GIT_CONFIG_PARAMETERS (Git's own `-c` channel, which Git passes on to the
 * Git processes it starts). The box-wide pieces in the global Git config and
 * on PATH (credential helper, `git`, `gh`, `glab`, `az`) only dispatch to the
 * directory named there. A process without it (such as a person's terminal)
 * uses the chat whose setup ran last, as before.
 *
 * The key is a hash so paths do not disclose chat ids. Paths are not an
 * authorization boundary: the broker pass carries its own chat and attempt
 * claims, which the server checks on every request.
 */
export function gitSessionKey(sessionId: string): string {
  if (!sessionId || sessionId.includes("\0")) {
    throw new Error("Git credential session id is invalid");
  }
  return createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32);
}

function assertGitSessionKey(key: string): string {
  if (!/^[0-9a-f]{32}$/u.test(key)) throw new Error("Git credential session key is invalid");
  return key;
}

/** Names one chat's Git credential directory (setup and renewal need only this). */
export function gitSessionDirectoryExport(key: string): string {
  return `export OPENGENI_GIT_SESSION_DIR="\${OPENGENI_GIT_CREDENTIALS_DIR:-\${HOME:-/workspace}/.opengeni/git-credentials}/sessions/${assertGitSessionKey(key)}"`;
}

/** Shell lines that select one chat's Git credentials for the rest of a command. */
export function gitSessionEnvironmentLines(key: string): string[] {
  return [gitSessionDirectoryExport(key), ...GIT_SESSION_CONFIG_LINES];
}

/**
 * Adds the selected chat's broker routes (`http-broker.gitconfig`, a missing
 * file is ignored by Git) to every Git process of the command.
 */
export const GIT_SESSION_CONFIG_LINES: readonly string[] = [
  `export GIT_CONFIG_PARAMETERS="\${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }'include.path=$OPENGENI_GIT_SESSION_DIR/http-broker.gitconfig'"`,
];

export function withGitSessionEnvironment(cmd: string, key: string): string {
  return [...gitSessionEnvironmentLines(key), cmd].join("\n");
}

/** Decorate command creation without changing identity, capabilities or trailing options. */
export function withGitSessionSession<T extends object>(session: T, key: string): T {
  assertGitSessionKey(key);
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "exec" || property === "execCommand") {
        const command = Reflect.get(target, property, target) as
          | ((args: ExecCommandArgs, ...callArgs: unknown[]) => Promise<unknown>)
          | undefined;
        if (!command) return undefined;
        return async (args: ExecCommandArgs, ...callArgs: unknown[]) =>
          await command.call(
            target,
            { ...args, cmd: withGitSessionEnvironment(args.cmd, key) },
            ...callArgs,
          );
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Decorate every client-created/resumed session with one chat's Git directory. */
export function withGitSessionClient(client: SandboxClient, key: string): SandboxClient {
  assertGitSessionKey(key);
  const decorated = new WeakMap<object, SandboxSessionLike>();
  const wrap = <T extends SandboxSessionLike>(session: T): T => {
    const existing = decorated.get(session);
    if (existing) return existing as T;
    const wrapped = withGitSessionSession(session, key);
    decorated.set(session, wrapped);
    return wrapped;
  };
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "create" || property === "resume") {
        const method = Reflect.get(target, property, target) as
          | ((...args: any[]) => Promise<SandboxSessionLike>)
          | undefined;
        if (!method) return undefined;
        return async (...args: any[]) => wrap(await method.apply(target, args));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
