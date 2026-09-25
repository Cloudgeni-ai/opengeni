// Test fixture for anything that executes sandbox lifecycle scripts or Git on the
// host. Those scripts deliberately rewrite `$HOME/.opengeni` and the global Git
// configuration of whoever runs them, so a test that inherits the developer's
// HOME, GIT_CONFIG_GLOBAL, or XDG_CONFIG_HOME replaces the developer's real
// credential helpers. Every environment built here pins all three inside an
// isolated temporary HOME and throws before spawning anything otherwise.

import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, sep } from "node:path";

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

/**
 * Fails loudly unless `home` is a dedicated temporary directory: absolute, under
 * the OS temporary directory, and neither the account's real home nor the HOME
 * this test process inherited. Creates the directory when missing.
 */
export function assertIsolatedHome(home: string | undefined): string {
  if (!home || !isAbsolute(home)) {
    throw new Error(`Test HOME must be an absolute temporary directory, got ${String(home)}`);
  }
  mkdirSync(home, { recursive: true });
  const resolved = realpathSync(home);
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
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isAmbientRedirect(name)) environment[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  const home = assertIsolatedHome(overrides.HOME);
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
