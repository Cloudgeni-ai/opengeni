const HOST_GIT_ENV_KEYS = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_TERMINAL_PROMPT",
] as const;

type HostGitEnvKey = (typeof HOST_GIT_ENV_KEYS)[number];

let hostGitEnvironmentQueue: Promise<void> = Promise.resolve();

export async function withHostGitHubAppRepositoryAuth<T>(
  sandboxEnvironment: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const hostEnvironment = hostGitEnvironmentFromSandboxEnvironment(sandboxEnvironment);
  if (!hostEnvironment) {
    return await fn();
  }

  const previous = hostGitEnvironmentQueue;
  let release!: () => void;
  hostGitEnvironmentQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const original = snapshotHostGitEnvironment();
  try {
    applyHostGitEnvironment(hostEnvironment);
    return await fn();
  } finally {
    restoreHostGitEnvironment(original);
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
