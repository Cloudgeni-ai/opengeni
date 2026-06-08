const HOST_GIT_ENV_KEYS = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_TERMINAL_PROMPT",
] as const;

type HostGitEnvKey = (typeof HOST_GIT_ENV_KEYS)[number];

let hostGitEnvironmentQueue: Promise<void> = Promise.resolve();

export async function enterHostGitHubAppRepositoryAuth(sandboxEnvironment: Record<string, string>): Promise<() => void> {
  const hostEnvironment = hostGitEnvironmentFromSandboxEnvironment(sandboxEnvironment);
  if (!hostEnvironment) {
    return () => undefined;
  }

  const previous = hostGitEnvironmentQueue;
  let releaseQueue!: () => void;
  hostGitEnvironmentQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  const original = snapshotHostGitEnvironment();
  applyHostGitEnvironment(hostEnvironment);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    restoreHostGitEnvironment(original);
    releaseQueue();
  };
}

export async function withHostGitHubAppRepositoryAuth<T>(
  sandboxEnvironment: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await enterHostGitHubAppRepositoryAuth(sandboxEnvironment);
  try {
    return await fn();
  } finally {
    release();
  }
}

function hostGitEnvironmentFromSandboxEnvironment(environment: Record<string, string>): Record<HostGitEnvKey, string> | null {
  if (
    environment.GIT_CONFIG_COUNT !== "1" ||
    environment.GIT_CONFIG_KEY_0 !== "http.https://github.com/.extraheader" ||
    !environment.GIT_CONFIG_VALUE_0
  ) {
    return null;
  }
  return {
    GIT_CONFIG_COUNT: environment.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: environment.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: environment.GIT_CONFIG_VALUE_0,
    GIT_TERMINAL_PROMPT: environment.GIT_TERMINAL_PROMPT || "0",
  };
}

function snapshotHostGitEnvironment(): Record<HostGitEnvKey, string | undefined> {
  return Object.fromEntries(HOST_GIT_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<HostGitEnvKey, string | undefined>;
}

function applyHostGitEnvironment(environment: Record<HostGitEnvKey, string>): void {
  for (const key of HOST_GIT_ENV_KEYS) {
    process.env[key] = environment[key];
  }
}

function restoreHostGitEnvironment(original: Record<HostGitEnvKey, string | undefined>): void {
  for (const key of HOST_GIT_ENV_KEYS) {
    const value = original[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
