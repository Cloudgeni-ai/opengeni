import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "@opengeni/events";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("development NATS auth-callout config", () => {
  test("renders one seed-matched, credentialed local tenancy boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-dev-nats-"));
    roots.push(root);
    const output = join(root, "nats.conf");
    const account = nkeys.createAccount();
    const seed = new TextDecoder().decode(account.getSeed());
    const process = Bun.spawn(
      ["bun", new URL("./prepare-development-nats-config.ts", import.meta.url).pathname, "--output", output],
      {
        env: {
          ...Bun.env,
          OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED: seed,
          OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY: account.getPublicKey(),
          OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_NAME: "APP",
          OPENGENI_SELFHOSTED_NATS_CALLOUT_USER: "auth",
          OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD: "callout-secret",
          OPENGENI_SELFHOSTED_NATS_CONTROL_USER: "control",
          OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD: "control-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const config = await readFile(output, "utf8");
    expect(config).toContain(`issuer: ${account.getPublicKey()}`);
    expect(config).toContain('auth_users: [ "auth", "control" ]');
    expect(config).toContain('account: "APP"');
    expect(config).toContain('password: "callout-secret"');
    expect(config).toContain('password: "control-secret"');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  test("rejects a public key that is not derived from the configured seed", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-dev-nats-"));
    roots.push(root);
    const account = nkeys.createAccount();
    const other = nkeys.createAccount();
    const process = Bun.spawn(
      [
        "bun",
        new URL("./prepare-development-nats-config.ts", import.meta.url).pathname,
        "--output",
        join(root, "nats.conf"),
      ],
      {
        env: {
          ...Bun.env,
          OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED: new TextDecoder().decode(
            account.getSeed(),
          ),
          OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY: other.getPublicKey(),
          OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_NAME: "APP",
          OPENGENI_SELFHOSTED_NATS_CALLOUT_USER: "auth",
          OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD: "callout-secret",
          OPENGENI_SELFHOSTED_NATS_CONTROL_USER: "control",
          OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD: "control-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("public key does not match its account seed");
  });
});
