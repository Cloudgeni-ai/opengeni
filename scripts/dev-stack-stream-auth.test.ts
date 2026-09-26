import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";

type StartupFixture = {
  envFile: string;
  original: string;
  run: (expectsAuthority: boolean) => Promise<string>;
};

async function withStartupFixture(
  settings: Record<string, string>,
  verify: (fixture: StartupFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(import.meta.dir, ".stream-auth-test-"));
  try {
    const scripts = join(root, "scripts");
    await mkdir(scripts);
    const source = await Bun.file(join(import.meta.dir, "dev-stack.sh")).text();
    // Execute the actual environment initialization, stopping before any
    // dependency installation, infrastructure, or long-running service work.
    const end = source.indexOf("# The local UI exposes Codex connection management");
    expect(end).toBeGreaterThan(0);
    const script = join(scripts, "dev-stack.sh");
    await Bun.write(
      script,
      `${source.slice(0, end)}\nbun -e 'const available = !!(Bun.env.OPENGENI_STREAM_TOKEN_SECRET || Bun.env.OPENGENI_DELEGATION_SECRET); process.exit(available === (Bun.env.OPENGENI_TEST_EXPECT_AUTHORITY === "true") ? 0 : 1)'\n`,
    );
    for (const dependency of ["dev-stack-backend.sh", "dev-managed-auth.sh"]) {
      await copyFile(join(import.meta.dir, dependency), join(scripts, dependency));
    }
    const original =
      Object.entries({
        OPENGENI_ENVIRONMENT: "local",
        OPENGENI_SANDBOX_BACKEND: "modal",
        OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "false",
        OPENGENI_PRODUCT_ACCESS_MODE: "local",
        OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: "fixture-encryption-key",
        OPENGENI_INTEGRATIONS_ENABLED: "false",
        OPENGENI_MODAL_TOKEN_ID: "fixture-modal-id",
        OPENGENI_MODAL_TOKEN_SECRET: "fixture-modal-secret",
        OPENGENI_AGENT_STABLE_VERSION: "1.0.0",
        OPENGENI_ENROLLMENT_SIGNING_SECRET: "fixture-enrollment-secret",
        ...settings,
      })
        .map(([name, value]) => `${name}=${value}`)
        .join("\n") + "\n";
    const envFile = join(root, ".env");
    await Bun.write(envFile, original);
    await verify({
      envFile,
      original,
      async run(expectsAuthority) {
        const child = Bun.spawn(["bash", script, "--opengeni-dev-stack-token=fixture"], {
          env: {
            PATH: process.env.PATH ?? "",
            OPENGENI_DEV_BACKEND: "native",
            OPENGENI_TEST_EXPECT_AUTHORITY: String(expectsAuthority),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(error).toBe("");
        expect(exitCode).toBe(0);
        return output;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("default local Modal viewer authority persists securely without Connected Machines", async () => {
  await withStartupFixture({}, async ({ envFile, run }) => {
    const output = await run(true);
    const persisted = await Bun.file(envFile).text();
    const secret = persisted.match(/^OPENGENI_STREAM_TOKEN_SECRET=([^\n]+)$/m)?.[1];
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(output).not.toContain(secret!);
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect(await run(true)).toBe("");
    expect(await Bun.file(envFile).text()).toBe(persisted);
  });
});

test("local viewer initialization preserves explicit stream and delegation secrets", async () => {
  for (const name of ["OPENGENI_STREAM_TOKEN_SECRET", "OPENGENI_DELEGATION_SECRET"]) {
    const supplied = "supplied-stream-authority";
    await withStartupFixture({ [name]: supplied }, async ({ envFile, original, run }) => {
      expect(await run(true)).toBe("");
      expect(await Bun.file(envFile).text()).toBe(original);
      expect(await run(true)).not.toContain(supplied);
      expect(await Bun.file(envFile).text()).toBe(original);
    });
  }
});

test("a relay-only secret does not leave managed sandbox viewers without authority", async () => {
  const relaySecret = "supplied-relay-authority";
  await withStartupFixture(
    { OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET: relaySecret },
    async ({ envFile, run }) => {
      const output = await run(true);
      const persisted = await Bun.file(envFile).text();
      expect(persisted).toContain(`OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET=${relaySecret}\n`);
      expect(persisted).toMatch(/^OPENGENI_STREAM_TOKEN_SECRET=[A-Za-z0-9_-]{43}$/m);
      expect(output).not.toContain(relaySecret);
    },
  );
});

test("disabled local surfaces and production configuration do not invent stream authority", async () => {
  for (const settings of [
    { OPENGENI_SANDBOX_DESKTOP_ENABLED: "false", OPENGENI_SANDBOX_TERMINAL_ENABLED: "false" },
    { OPENGENI_ENVIRONMENT: "production" },
  ]) {
    await withStartupFixture(settings, async ({ envFile, original, run }) => {
      expect(await run(false)).toBe("");
      expect(await Bun.file(envFile).text()).toBe(original);
    });
  }
});

test("terminal-only and Connected Machine-only local streams initialize authority", async () => {
  for (const settings of [
    { OPENGENI_SANDBOX_DESKTOP_ENABLED: "false" },
    {
      OPENGENI_ENVIRONMENT: "test",
      OPENGENI_SANDBOX_DESKTOP_ENABLED: "false",
      OPENGENI_SANDBOX_TERMINAL_ENABLED: "false",
      OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true",
    },
  ]) {
    await withStartupFixture(settings, async ({ envFile, run }) => {
      await run(true);
      expect(await Bun.file(envFile).text()).toMatch(
        /^OPENGENI_STREAM_TOKEN_SECRET=[A-Za-z0-9_-]{43}$/m,
      );
    });
  }
});
