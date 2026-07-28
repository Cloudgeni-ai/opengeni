import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "@opengeni/events";
import { generateSingleNodeSecretFiles } from "./generate-single-node-secrets";

function parseEnv(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe("single-node secret bootstrap", () => {
  test("generates matched, separated credentials without overwriting an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-single-node-test-"));
    const outDir = join(root, "secrets");
    try {
      const files = await generateSingleNodeSecretFiles({ outDir });
      const [postgres, minio, runtime, migrations] = await Promise.all([
        readFile(files.postgres, "utf8").then(parseEnv),
        readFile(files.minio, "utf8").then(parseEnv),
        readFile(files.runtime, "utf8").then(parseEnv),
        readFile(files.migrations, "utf8").then(parseEnv),
      ]);

      expect(runtime.OPENGENI_DATABASE_URL).toContain("postgres://opengeni_app:");
      expect(migrations.OPENGENI_MIGRATIONS_DATABASE_URL).toContain("postgres://opengeni:");
      expect(migrations.OPENGENI_MIGRATIONS_DATABASE_URL).toContain(
        encodeURIComponent(postgres.POSTGRES_PASSWORD ?? ""),
      );
      expect(minio.MINIO_ROOT_PASSWORD?.length).toBeGreaterThanOrEqual(32);

      const accountSeed = runtime.OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED;
      expect(accountSeed).toBeDefined();
      expect(nkeys.fromSeed(Buffer.from(accountSeed ?? "")).getPublicKey()).toBe(
        runtime.OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY,
      );

      expect((await stat(files.directory)).mode & 0o777).toBe(0o700);
      for (const path of [files.postgres, files.minio, files.runtime, files.migrations]) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }

      await expect(generateSingleNodeSecretFiles({ outDir })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
