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
