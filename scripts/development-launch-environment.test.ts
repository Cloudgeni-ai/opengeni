import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDevelopmentLaunchEnvironment,
  resolveDevelopmentLaunchBackend,
} from "./development-launch-environment";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opengeni-launch-env-"));
  roots.push(root);
  await mkdir(join(root, "scripts"));
  for (const name of ["dev-stack-backend.sh", "dev-stack-project.sh"]) {
    await writeFile(join(root, "scripts", name), await readFile(new URL(name, import.meta.url)));
  }
  return root;
}

test("preflight reads fresh defaults without copying config or returning dotenv secrets", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".env.example"),
    "OPENGENI_COMPOSE_PROJECT=preflight-fresh\nOPENGENI_SANDBOX_SELFHOSTED_ENABLED=false\nOPENGENI_PREFLIGHT_TEST_SECRET=do-not-return\n",
  );
  const result = readDevelopmentLaunchEnvironment(root);
  expect(result.project).toBe("preflight-fresh");
  expect(result.environment.OPENGENI_SANDBOX_SELFHOSTED_ENABLED).toBe("false");
  expect(result.environment.OPENGENI_PREFLIGHT_TEST_SECRET).not.toBe("do-not-return");
  expect(await Bun.file(join(root, ".env")).exists()).toBe(false);
  expect(await Bun.file(join(root, ".env.runtime")).exists()).toBe(false);
});

test("existing dotenv and invocation backend use the same precedence as startup", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".env"),
    "OPENGENI_COMPOSE_PROJECT=preflight-existing\nOPENGENI_DEV_BACKEND=docker\nOPENGENI_SANDBOX_SELFHOSTED_ENABLED=true\n",
  );
  const previous = process.env.OPENGENI_DEV_BACKEND;
  try {
    process.env.OPENGENI_DEV_BACKEND = "native";
    const result = readDevelopmentLaunchEnvironment(root);
    expect(result.project).toBe("preflight-existing");
    expect(result.environment.OPENGENI_DEV_BACKEND).toBe("native");
    expect(result.environment.OPENGENI_SANDBOX_SELFHOSTED_ENABLED).toBe("true");
  } finally {
    if (previous === undefined) delete process.env.OPENGENI_DEV_BACKEND;
    else process.env.OPENGENI_DEV_BACKEND = previous;
  }
});

test("backend probes use effective Docker endpoint, context and TLS selectors, not ambient values", async () => {
  const root = await fixture();
  const selectors = {
    DOCKER_HOST: "tcp://configured.example.test:2376",
    DOCKER_CONTEXT: "configured-context",
    DOCKER_CONFIG: "/configured/docker",
    DOCKER_TLS: "1",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/configured/certs",
    DOCKER_API_VERSION: "1.47",
  };
  const previous = Object.fromEntries(Object.keys(selectors).map((key) => [key, process.env[key]]));
  const docker = join(root, "docker");
  await writeFile(
    docker,
    `#!/bin/sh\n${Object.entries(selectors)
      .map(([key, value]) => `[ "$${key}" = '${value}' ] || exit 1`)
      .join("\n")}\nexit 0\n`,
  );
  await chmod(docker, 0o755);
  await writeFile(
    join(root, ".env"),
    [
      ...Object.entries(selectors).map(([key, value]) => `${key}=${value}`),
      `PATH='${root}':"$PATH"`,
      "OPENGENI_SELFHOSTED_RELAY_URL=wss://relay.example.test",
      "OPENGENI_RELAY_BIND=0.0.0.0:8280",
      "OPENGENI_PREFLIGHT_TEST_SECRET=do-not-return",
      "DOCKER_AUTH_CONFIG=do-not-return",
    ].join("\n"),
  );
  try {
    for (const key of Object.keys(selectors)) process.env[key] = "ambient";
    const result = readDevelopmentLaunchEnvironment(root);
    for (const [key, value] of Object.entries(selectors))
      expect(result.environment[key]).toBe(value);
    expect(result.environment.OPENGENI_SELFHOSTED_RELAY_URL).toBe("wss://relay.example.test");
    expect(result.environment.OPENGENI_RELAY_BIND).toBe("0.0.0.0:8280");
    expect(result.environment.OPENGENI_PREFLIGHT_TEST_SECRET).not.toBe("do-not-return");
    expect(result.environment.DOCKER_AUTH_CONFIG).not.toBe("do-not-return");
    expect(
      resolveDevelopmentLaunchBackend(
        root,
        { ...result.environment, OPENGENI_DEV_BACKEND: "auto" },
        result.project,
      ).OPENGENI_DEV_BACKEND,
    ).toBe("docker");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("explicit dotenv unsets do not resurrect ambient probe selectors", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), "DOCKER_CONTEXT=dotenv-context\nunset DOCKER_CONTEXT\n");
  const previous = process.env.DOCKER_CONTEXT;
  try {
    process.env.DOCKER_CONTEXT = "ambient-context";
    expect(readDevelopmentLaunchEnvironment(root).environment.DOCKER_CONTEXT).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = previous;
  }
});

test("configuration stdout and stderr are separate from the snapshot and never exposed", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".env"),
    "printf 'FAKE_SECRET_MARKER\\n'\nprintf 'FAKE_SECRET_MARKER\\n' >&2\nOPENGENI_COMPOSE_PROJECT=quiet-config\n",
  );
  const snapshot = readDevelopmentLaunchEnvironment(root);
  expect(snapshot.project).toBe("quiet-config");
  expect(JSON.stringify(snapshot)).not.toContain("FAKE_SECRET_MARKER");
  await writeFile(join(root, ".env"), "printf FAKE_SECRET_MARKER >&2\nexit 1\n");
  expect(() => readDevelopmentLaunchEnvironment(root)).toThrow(
    "Cannot read local startup configuration",
  );
});

test("malformed snapshot diagnostics never quote captured output", async () => {
  const root = await fixture();
  const malformed = Bun.spawnSync([
    process.execPath,
    "--no-env-file",
    "-e",
    "process.stdout.write('FAKE_SECRET_MARKER')",
  ]);
  const spawn = spyOn(Bun, "spawnSync").mockReturnValue(malformed);
  try {
    expect(() => readDevelopmentLaunchEnvironment(root)).toThrow(
      "Cannot read local startup configuration; no services were started.",
    );
  } finally {
    spawn.mockRestore();
  }
});
