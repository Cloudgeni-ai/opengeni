// Executes the production post-provision block, not a second implementation of
// its ordering. No model, cloud sandbox, real credentials, or deployed service.
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSettings } from "@opengeni/testing/settings";
import { mintSandboxCodemodeToken } from "@opengeni/runtime/sandbox";
import { materializeRunCredentials } from "../packages/runtime/src/sandbox/run-credentials";
import {
  loadManagedCodemodeClient,
  installManagedCodemodeClient,
} from "../packages/runtime/src/sandbox/codemode-client";
import { hostShellSession } from "../packages/runtime/test/isolated-git-home-fixture";
import {
  managedCodemodeClientDownload,
  resetManagedCodemodeClientPublicationForTest,
} from "../apps/worker/src/activities/agent-turn/codemode-client-download";

const sourceRef = process.argv[2];
const sourcePath = "apps/worker/src/activities/agent-turn/sandbox-establish.ts";
const source = sourceRef
  ? (() => {
      const result = Bun.spawnSync(["git", "show", `${sourceRef}:${sourcePath}`]);
      if (result.exitCode !== 0) throw new Error("Cannot read benchmark source revision");
      return result.stdout.toString();
    })()
  : readFileSync(new URL(`../${sourcePath}`, import.meta.url), "utf8");
const marker = source.includes("// Post-provision prerequisites:")
  ? "// Post-provision prerequisites:"
  : "const lazyGitCredentials =";
const start = source.indexOf(marker, source.indexOf("beforeCompleted:"));
const end = source.indexOf("const provisionedSetupSession =", start);
if (start < 0 || end < 0) throw new Error("Post-provision block not found");
const stage = new Function(
  "ports",
  new Bun.Transpiler({ loader: "ts" }).transformSync(`
  const { activeSandboxBackend, startRunGitCredentialsMint, sandboxCodemodeToken,
    mintSandboxCodemodeToken, runSettings, connectionScope, codemodeAuthority,
    managedCodemodeClientDownload, objectStorage, groupBoxBackend,
    attachRunCredentialRenewal, provisioned, initialRunCredentialMaterial, measure } = ports;
  return (async () => { ${source.slice(start, end)} return { lazyCodemodeClientDownload }; })();
`),
) as (ports: Record<string, unknown>) => Promise<{ lazyCodemodeClientDownload?: { url: string } }>;

const settings = testSettings({ objectStorageBackend: "azure-blob" });
const clientStarted = performance.now();
const client = await loadManagedCodemodeClient();
console.log(
  JSON.stringify({
    checkoutClientBuildMs: performance.now() - clientStarted,
    clientBytes: Buffer.byteLength(JSON.stringify(client)),
  }),
);
const root = await mkdtemp(join(tmpdir(), "opengeni-startup-bench-"));
const samples = Number(process.env.OPENGENI_BENCH_SAMPLES ?? 10);
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  for (const delayMs of [0, 100])
    for (const publicationCache of ["cold", "warm"] as const) {
      const rows: Record<string, number>[] = [];
      for (let i = 0; i < samples; i++) {
        const home = join(root, `${delayMs}-${publicationCache}-${i}`);
        await mkdir(home);
        const shell = hostShellSession(home, {
          rewriteCommand: (cmd) =>
            cmd.replaceAll("/tmp/opengeni-run-credentials", `${home}/credentials`),
        });
        const pause = async () => {
          if (delayMs) await Bun.sleep(delayMs);
        };
        const row: Record<string, number> = {};
        const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
          const at = performance.now();
          try {
            return await run();
          } finally {
            row[name] = (row[name] ?? 0) + performance.now() - at;
          }
        };
        let body: Uint8Array | undefined;
        const server = Bun.serve({ port: 0, fetch: () => new Response(body ?? null) });
        const objectStorage = {
          bucket: "benchmark",
          headObject: async () => {
            await pause();
            return null;
          },
          putObject: async (input: { body: Uint8Array }) => {
            await pause();
            body = input.body;
          },
          createGetUrl: async () => {
            await pause();
            return { url: `http://127.0.0.1:${server.port}/client` };
          },
        };
        resetManagedCodemodeClientPublicationForTest();
        try {
          if (publicationCache === "warm")
            await managedCodemodeClientDownload({
              settings,
              objectStorage: objectStorage as never,
              activeSandboxBackend: "modal",
            });
          const result = await timed("postProvision", () =>
            stage({
              activeSandboxBackend: "modal",
              groupBoxBackend: "modal",
              // Controlled unfinished Git-mint wait; no real Git provider involved.
              startRunGitCredentialsMint: () =>
                timed("gitWait", async () => {
                  await pause();
                  return undefined;
                }),
              sandboxCodemodeToken: "fixture",
              mintSandboxCodemodeToken: (...args: Parameters<typeof mintSandboxCodemodeToken>) =>
                timed("tokenMint", () => mintSandboxCodemodeToken(...args)),
              runSettings: settings,
              connectionScope: {
                accountId: "00000000-0000-4000-8000-000000000001",
                workspaceId: "00000000-0000-4000-8000-000000000002",
              },
              codemodeAuthority: {
                sessionId: "00000000-0000-4000-8000-000000000003",
                turnId: "00000000-0000-4000-8000-000000000004",
                attemptId: "00000000-0000-4000-8000-000000000005",
                executionGeneration: 1,
              },
              managedCodemodeClientDownload: (
                input: Parameters<typeof managedCodemodeClientDownload>[0],
              ) => timed("clientPublication", () => managedCodemodeClientDownload(input)),
              objectStorage,
              attachRunCredentialRenewal: () =>
                timed("materialization", async () =>
                  materializeRunCredentials(
                    {
                      exec: async (args) => {
                        await pause();
                        return shell.exec(args);
                      },
                    },
                    {
                      environment: { FIXTURE_ACCESS: "not-a-secret", FIXTURE_REGION: "test" },
                      files: [
                        {
                          path: "service/config",
                          content: "fixture configuration\n",
                          mode: "0400",
                        },
                      ],
                      fileEnvironment: { FIXTURE_CONFIG: "service/config" },
                      expiresAt: null,
                      authNeeded: [],
                    },
                    { sessionId: "session", attemptId: "attempt", executionGeneration: 1 },
                  ),
                ),
              provisioned: { established: { session: {} } },
              initialRunCredentialMaterial: {},
              measure: (_phase: string, work: () => Promise<unknown>) => work(),
            }),
          );
          await timed("clientInstallation", () =>
            installManagedCodemodeClient(
              {} as never,
              client,
              async (cmd) => {
                await pause();
                return shell.exec({ cmd });
              },
              undefined,
              home,
              result.lazyCodemodeClientDownload,
            ),
          );
          rows.push(row);
        } finally {
          server.stop(true);
        }
      }
      console.log(
        JSON.stringify({
          source: sourceRef ?? "working-tree",
          publicationCache,
          delayMs,
          samples,
          mediansMs: Object.fromEntries(
            Object.keys(rows[0]!).map((key) => [
              key,
              Number(median(rows.map((r) => r[key]!)).toFixed(2)),
            ]),
          ),
        }),
      );
    }
} finally {
  await rm(root, { recursive: true, force: true });
}
