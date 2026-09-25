// Test fixture for anything that executes sandbox lifecycle scripts or Git on the
// host. Those scripts deliberately rewrite `$HOME/.opengeni` and the global Git
// configuration of whoever runs them, so a test that inherits the developer's
// HOME, GIT_CONFIG_GLOBAL, or XDG_CONFIG_HOME replaces the developer's real
// credential helpers. Every environment built here pins all three inside an
// isolated temporary HOME and throws before spawning anything otherwise. A fake
// sandbox session that runs commands on the host must come from
// `hostShellSession` below rather than a hand-rolled `Bun.spawn`.

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The HOME the test process itself was started with (the developer's, locally). */
const AMBIENT_HOME = process.env.HOME;

function realpathOrUndefined(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function accountHomeDirectory(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/** The physical path `path` will have once created: the real path of its nearest
 *  existing ancestor plus the not-yet-existing remainder. Reads only. */
function prospectiveRealPath(path: string): string {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const remainder = relative(ancestor, absolute);
  const physicalAncestor = realpathSync(ancestor);
  return remainder ? join(physicalAncestor, remainder) : physicalAncestor;
}

/**
 * Fails loudly unless `home` is a dedicated temporary directory: absolute, under
 * the OS temporary directory, and neither the account's real home nor the HOME
 * this test process inherited. Every check runs before anything is created; only
 * an accepted path is then created when missing.
 */
export function assertIsolatedHome(home: string | undefined): string {
  if (!home || !isAbsolute(home)) {
    throw new Error(`Test HOME must be an absolute temporary directory, got ${String(home)}`);
  }
  const resolved = prospectiveRealPath(home);
  const temporaryRoot = realpathSync(tmpdir());
  if (!resolved.startsWith(`${temporaryRoot}${sep}`)) {
    throw new Error(
      `Refusing to run Git or lifecycle scripts against HOME=${home}: tests must use an isolated HOME under ${temporaryRoot}`,
    );
  }
  for (const [label, forbidden] of [
    ["the account home directory", realpathOrUndefined(accountHomeDirectory())],
    ["the HOME this test process inherited", realpathOrUndefined(AMBIENT_HOME)],
  ] as const) {
    if (forbidden && resolved === forbidden) {
      throw new Error(`Refusing to run Git or lifecycle scripts against ${label} (${home})`);
    }
  }
  mkdirSync(home, { recursive: true });
  return home;
}

/** Ambient variables that can point Git, askpass, or OpenGeni provisioning at
 *  state outside the fixture HOME (a git hook's GIT_DIR, GIT_CONFIG_* overrides,
 *  OPENGENI_GIT_* credential paths, and similar). Callers re-add what they need. */
function isAmbientRedirect(name: string): boolean {
  return (
    name.startsWith("GIT_") ||
    name.startsWith("OPENGENI_") ||
    name === "SSH_ASKPASS" ||
    name === "XDG_CONFIG_HOME"
  );
}

export type IsolatedGitEnvironmentOptions = {
  /**
   * Admit the Git credential provisioning guard by marking the shell as a
   * sandbox lifecycle command, the way the runtime's sandbox hooks do. Only
   * ever combined with the isolated HOME this function enforces.
   */
  sandboxGitProvisioning?: boolean;
};

/**
 * A child-process environment whose HOME, GIT_CONFIG_GLOBAL, and XDG_CONFIG_HOME
 * all resolve inside `overrides.HOME`, which must be an isolated temporary
 * directory. Ambient Git/OpenGeni redirects are dropped; explicit `overrides`
 * (other than those three pinned paths) are kept, and `undefined` removes a name.
 */
export function isolatedGitEnvironment(
  overrides: Readonly<Record<string, string | undefined>> & { HOME: string },
  options: IsolatedGitEnvironmentOptions = {},
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const home = assertIsolatedHome(overrides.HOME);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isAmbientRedirect(name)) environment[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  environment.HOME = home;
  environment.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  environment.XDG_CONFIG_HOME = join(home, ".config");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  delete environment.GIT_CONFIG_SYSTEM;
  if (options.sandboxGitProvisioning) {
    environment.OPENGENI_GIT_PROVISIONING_TARGET = "sandbox";
  } else {
    delete environment.OPENGENI_GIT_PROVISIONING_TARGET;
  }
  return environment;
}

export type HostShellCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
};

export type HostShellSessionOptions = {
  /** Working directory for every command. Defaults to `home`. */
  cwd?: string;
  /** Extra child environment; `undefined` removes a name. HOME and the Git
   *  config paths stay pinned inside `home`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Rewrites each command before it runs, for example to map the virtual
   *  sandbox `/workspace` onto a temporary directory. */
  rewriteCommand?: (cmd: string) => string;
};

/**
 * A fake sandbox session whose `exec` runs each command on the host with `sh -c`
 * against an isolated HOME. It deliberately does NOT carry the sandbox Git
 * provisioning target: commands produced by the runtime's lifecycle hooks add
 * that marker themselves, exactly as they do inside a real sandbox, so this
 * session exercises the production command text without ever touching the
 * developer's HOME or global Git configuration.
 */
export function hostShellSession(home: string, options: HostShellSessionOptions = {}) {
  const environment = isolatedGitEnvironment({ ...options.env, HOME: home });
  return {
    exec: async (args: { cmd: string }): Promise<HostShellCommandResult> => {
      const cmd = options.rewriteCommand ? options.rewriteCommand(args.cmd) : args.cmd;
      const child = Bun.spawn(["sh", "-c", cmd], {
        cwd: options.cwd ?? home,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr, output: `${stdout}${stderr}` };
    },
  };
}
