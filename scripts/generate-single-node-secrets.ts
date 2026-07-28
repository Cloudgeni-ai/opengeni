import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { nkeys } from "@opengeni/events";

const decoder = new TextDecoder();

export interface SingleNodeSecretFiles {
  directory: string;
  postgres: string;
  minio: string;
  runtime: string;
  migrations: string;
}

export interface GenerateSingleNodeSecretsOptions {
  outDir: string;
  releaseName?: string;
  databaseName?: string;
  databaseOwner?: string;
  runtimeDatabaseUser?: string;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function envFile(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function postgresUrl(input: {
  user: string;
  password: string;
  host: string;
  database: string;
}): string {
  return `postgres://${encodeURIComponent(input.user)}:${encodeURIComponent(input.password)}@${input.host}:5432/${encodeURIComponent(input.database)}`;
}

export async function generateSingleNodeSecretFiles(
  options: GenerateSingleNodeSecretsOptions,
): Promise<SingleNodeSecretFiles> {
  const directory = resolve(options.outDir);
  const parent = dirname(directory);
  const releaseName = options.releaseName ?? "opengeni";
  const databaseName = options.databaseName ?? "opengeni";
  const databaseOwner = options.databaseOwner ?? "opengeni";
  const runtimeDatabaseUser = options.runtimeDatabaseUser ?? "opengeni_app";
  const databaseHost = `${releaseName}-postgres`;

  const ownerPassword = secret();
  const runtimePassword = secret();
  const minioPassword = secret();
  const enrollmentSigningSecret = secret();
  const streamTokenSecret = secret();
  const natsControlPassword = secret();
  const natsCalloutPassword = secret();
  const natsAccount = nkeys.createAccount();
  const natsAccountSeed = decoder.decode(natsAccount.getSeed());
  const natsAccountPublicKey = natsAccount.getPublicKey();

  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(parent, `.${basename(directory)}-`));
  await chmod(temporaryDirectory, 0o700);

  const files: SingleNodeSecretFiles = {
    directory,
    postgres: join(directory, "postgres.env"),
    minio: join(directory, "minio.env"),
    runtime: join(directory, "runtime.env"),
    migrations: join(directory, "migrations.env"),
  };

  try {
    const temporaryFiles = {
      postgres: join(temporaryDirectory, "postgres.env"),
      minio: join(temporaryDirectory, "minio.env"),
      runtime: join(temporaryDirectory, "runtime.env"),
      migrations: join(temporaryDirectory, "migrations.env"),
    };
    await Promise.all([
      writeFile(
        temporaryFiles.postgres,
        envFile({
          POSTGRES_PASSWORD: ownerPassword,
        }),
        { mode: 0o600, flag: "wx" },
      ),
      writeFile(
        temporaryFiles.minio,
        envFile({
          MINIO_ROOT_USER: "opengeni",
          MINIO_ROOT_PASSWORD: minioPassword,
        }),
        { mode: 0o600, flag: "wx" },
      ),
      writeFile(
        temporaryFiles.runtime,
        envFile({
          OPENGENI_DATABASE_URL: postgresUrl({
            user: runtimeDatabaseUser,
            password: runtimePassword,
            host: databaseHost,
            database: databaseName,
          }),
          OPENGENI_ENROLLMENT_SIGNING_SECRET: enrollmentSigningSecret,
          OPENGENI_STREAM_TOKEN_SECRET: streamTokenSecret,
          OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET: streamTokenSecret,
          OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED: natsAccountSeed,
          OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY: natsAccountPublicKey,
          OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD: natsControlPassword,
          OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD: natsCalloutPassword,
        }),
        { mode: 0o600, flag: "wx" },
      ),
      writeFile(
        temporaryFiles.migrations,
        envFile({
          OPENGENI_MIGRATIONS_DATABASE_URL: postgresUrl({
            user: databaseOwner,
            password: ownerPassword,
            host: databaseHost,
            database: databaseName,
          }),
          OPENGENI_APP_DATABASE_USER: runtimeDatabaseUser,
          OPENGENI_APP_DATABASE_PASSWORD: runtimePassword,
        }),
        { mode: 0o600, flag: "wx" },
      ),
    ]);
    await rename(temporaryDirectory, directory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  return files;
}

function parseArgs(argv: string[]): GenerateSingleNodeSecretsOptions {
  let outDir = "";
  let releaseName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      outDir = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--release-name") {
      releaseName = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!outDir) {
    throw new Error("--out-dir is required");
  }
  return {
    outDir,
    ...(releaseName ? { releaseName } : {}),
  };
}

if (import.meta.main) {
  const files = await generateSingleNodeSecretFiles(parseArgs(process.argv.slice(2)));
  console.log(`Generated single-node secret env files in ${files.directory}`);
  console.log("No secret values were printed. Keep this directory private and do not commit it.");
}
