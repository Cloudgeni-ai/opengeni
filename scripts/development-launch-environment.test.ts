import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDevelopmentLaunchEnvironment } from "./development-launch-environment";

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

test("preflight carries effective Docker and remote relay settings", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".env"),
    "DOCKER_HOST=tcp://docker.example:2376\nDOCKER_CONTEXT=remote\nDOCKER_TLS_VERIFY=1\nDOCKER_CERT_PATH=/certs\nOPENGENI_SELFHOSTED_RELAY_URL=wss://relay.example\nOPENGENI_RELAY_BIND=0.0.0.0:8280\n",
  );
  const { environment } = readDevelopmentLaunchEnvironment(root);
  expect(environment.DOCKER_HOST).toBe("tcp://docker.example:2376");
  expect(environment.DOCKER_CONTEXT).toBe("remote");
  expect(environment.DOCKER_TLS_VERIFY).toBe("1");
  expect(environment.DOCKER_CERT_PATH).toBe("/certs");
  expect(environment.OPENGENI_SELFHOSTED_RELAY_URL).toBe("wss://relay.example");
  expect(environment.OPENGENI_RELAY_BIND).toBe("0.0.0.0:8280");
});

test("dotenv output never appears in a configuration parse error", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), "printf 'private-test-value'\n");
  try {
    readDevelopmentLaunchEnvironment(root);
    throw new Error("Expected configuration failure");
  } catch (error) {
    expect(String(error)).toContain("Cannot read local startup configuration");
    expect(String(error)).not.toContain("private-test-value");
  }
});
