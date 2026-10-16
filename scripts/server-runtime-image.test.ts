import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("API and worker final images ship assembled runtime closures, never the source install", async () => {
  const source = await readFile(join(root, "docker/opengeni.Dockerfile"), "utf8");
  for (const role of ["api", "worker"]) {
    const marker = `FROM oven/bun:\${BUN_VERSION}-slim AS ${role}\n`;
    const runtime = source.split(marker)[1]?.split(/^FROM /m)[0];
    expect(runtime).toBeDefined();
    expect(runtime).toContain(`/app/.release/server-runtime/${role}/ /app/`);
    expect(runtime).not.toContain("bun install");
    expect(runtime).not.toContain("build-runtime-processes");
    expect(runtime).not.toContain("COPY .");
    expect(runtime).toContain("USER bun");
    expect(runtime).toContain("install -d -o bun -g bun -m 0755 /workspace");
  }
  expect(source).toContain("RUN bun artifact-runtime-doctor.js doctor --json");
  expect(source).toContain("COPY --from=api-build --chown=root:root /app/artifact-runtime/");
});

// An explicit built-artifact gate exercises the actual frozen native closure in
// a directory with no monorepo ancestors. Ordinary unit runs keep this cheap;
// image changes run `build:runtime-processes`, assembly, then this gate.
if (process.env.OPENGENI_VERIFY_SERVER_RUNTIME === "1") {
  for (const role of ["api", "worker"] as const) {
    test(`${role} assembled runtime loads its native dependencies and assets without source`, async () => {
      const fixture = await mkdtemp(join(tmpdir(), `opengeni-${role}-runtime-smoke-`));
      try {
        await cp(join(root, `.release/server-runtime/${role}`), fixture, {
          recursive: true,
          verbatimSymlinks: true,
        });
        const program = `
          const {existsSync,readFileSync,readdirSync} = await import('node:fs');
          const {dirname,join} = await import('node:path');
          const {fileURLToPath} = await import('node:url');
          const {createRequire} = await import('node:module');
          const runtimeRequire = createRequire(new URL('./apps/${role}/dist/process/index.js',import.meta.url));
          const module = await import('./apps/${role}/dist/process/index.js');
          const sharp = runtimeRequire('sharp');
          const png = await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer();
          if (!png.length) throw new Error('missing Sharp native output');
          if (!existsSync('./apps/${role}/dist/process/assets/runtime/bundled_default_skills/document-parsing/SKILL.md')) throw new Error('missing Skills');
          // Connected 1Password vaults: the SDK core reads core_bg.wasm beside
          // its own module when it loads. A bundled copy would point at the
          // build machine's path instead.
          const onePassword = runtimeRequire('@1password/sdk');
          if (typeof onePassword.createClient !== 'function') throw new Error('missing 1Password SDK');
          for (const name of readdirSync('./apps/${role}/dist/process', { recursive: true })) {
            if (String(name).endsWith('.js') && readFileSync(join('./apps/${role}/dist/process', String(name)), 'utf8').includes('core_bg.wasm')) {
              throw new Error('the 1Password SDK core was bundled into ' + name);
            }
          }
          if (${JSON.stringify(role)} === 'worker') {
            const {LiteParse} = runtimeRequire('@llamaindex/liteparse');
            new LiteParse({ocrEnabled:false,numWorkers:1});
            await module.createDefaultWorkerActivities('control',{});
            await module.createDefaultWorkerActivities('turn',{});
            const definition = module.resolveOpenGeniWorkflowDefinition(new URL('./apps/worker/dist/process/index.js',import.meta.url).href);
            if (!existsSync(definition.workflowBundle.codePath)) throw new Error('missing workflows');
            const client = JSON.parse(readFileSync('./apps/worker/dist/process/assets/codemode-client.json','utf8'));
            if (client.version !== 1 || !client.files.ogtool) throw new Error('missing managed client');
          } else {
            let parserResolved = false;
            try { runtimeRequire.resolve('@llamaindex/liteparse'); parserResolved = true; } catch {}
            if (parserResolved) throw new Error('API must not ship the worker-only native parser');
            const migrations = await import('./packages/db/src/migrate.ts');
            if (typeof migrations.migrate !== 'function') throw new Error('missing migrator');
            const sharedMigrations = await Promise.all(readdirSync('./packages/db/src').filter(name=>name.startsWith('runtime-')&&name.endsWith('.js')).map(async name=>{
              const path='./packages/db/src/'+name;
              const source=readFileSync(path,'utf8');
              if (!source.includes('async function migrate(')) return;
              if (!existsSync(join(dirname(fileURLToPath(new URL(path,import.meta.url))),'../drizzle/0000_initial.sql'))) {
                const sqlDirectory=join(dirname(fileURLToPath(new URL(path,import.meta.url))),'../drizzle');
                if (!readdirSync(sqlDirectory).some(name=>name.endsWith('.sql'))) throw new Error('missing relative migration ledger');
              }
              return path;
            }));
            if (!sharedMigrations.some(Boolean)) throw new Error('migration shared chunk not verified');
            await import('./packages/db/src/provision-roles.ts');
            await import('./packages/db/src/lifecycle-fact-backfill.ts');
            await import('./packages/db/src/session-content-compaction.ts');
            const catalog = await import('./scripts/import-integrations-catalog.ts');
            if (typeof catalog.normalizeCatalogSnapshot !== 'function') throw new Error('missing catalog importer');
            if (!existsSync('./data/catalog/integrations-snapshot.json')) throw new Error('missing reviewed catalog');
            for (const command of ['inventory-tenancy','check-tenancy-parity','backfill-session-ownership','backfill-organization-memberships','backfill-connection-authority','verify-resource-classification','sweep-organization-retention']) {
              await import('./scripts/'+command+'.ts');
              const manifest=JSON.parse(readFileSync('./package.json','utf8'));
              if (!manifest.scripts['db:'+command]) throw new Error('missing operator command '+command);
            }
            const admission = Bun.spawnSync([process.execPath, '--no-env-file', 'scripts/admission-settings.ts'], {
              env: { PATH: process.env.PATH, OPENGENI_DEPLOYMENT_REVISION: 'runtime-smoke', OPENGENI_ALLOWED_USER_EMAILS: 'a@example.com' },
            });
            const report = JSON.parse(admission.stdout.toString());
            if (admission.exitCode !== 0 || report.sourceSha !== 'runtime-smoke' || report.emails?.[0] !== 'a@example.com') throw new Error('admission settings probe failed');
            if (!existsSync('./apps/api/dist/process/assets/agent-install/install.sh')) throw new Error('missing installer');
            if (!existsSync('./apps/api/dist/process/assets/desktop-install/install.sh')) throw new Error('missing desktop installer');
          }
          process.stdout.write('runtime-ready');
        `;
        const child = Bun.spawn([process.execPath, "--no-env-file", "-e", program], {
          cwd: fixture,
          // Clearing inherited URLs is not enough: CLI defaults point at a
          // local development database. Imports must do no database work, and
          // a regressed main guard must fail closed instead of using that default.
          env: {
            PATH: process.env.PATH,
            OPENGENI_DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/runtime_smoke",
            OPENGENI_MIGRATIONS_DATABASE_URL:
              "postgres://invalid:invalid@127.0.0.1:1/runtime_smoke",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(status, stderr).toBe(0);
        expect(stdout).toBe("runtime-ready");
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    }, 120_000);
  }
}
