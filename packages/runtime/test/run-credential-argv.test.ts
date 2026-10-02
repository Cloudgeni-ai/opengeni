import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { Sandbox } from "modal";
import {
  materializeRunCredentials,
  normalizeRunCredentialsResolution,
  runCredentialRoot,
  withRunCredentialEnvironment,
} from "../src/sandbox/run-credentials";
import { cancellableShellCommand } from "../src/sandbox/turn-tool-cancellation";

const require = createRequire(import.meta.url);
const distributions = [
  { name: "ESM", Sandbox, Session: ModalSandboxSession },
  {
    name: "CJS",
    Sandbox: require("modal").Sandbox as typeof Sandbox,
    Session: require("@openai/agents-extensions/sandbox/modal")
      .ModalSandboxSession as typeof ModalSandboxSession,
  },
];

for (const distribution of distributions) {
  for (const metadata of [
    {
      name: "ordinary paths",
      sessionId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      generation: 3,
      filePath: "fixture/config",
    },
    {
      name: "maximum quote-heavy paths and IDs",
      sessionId: "s".repeat(128),
      attemptId: "a".repeat(128),
      generation: Number.MAX_SAFE_INTEGER,
      filePath: `${"'".repeat(120)}/${"'".repeat(117)}\n\n`,
    },
  ]) {
    test.skipIf(process.platform !== "linux" || !process.getuid)(
      `${distribution.name} large credential transfers preserve bytes below wrapped Modal argv limits (${metadata.name})`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), "opengeni-credential-argv-"));
        const sessionId = metadata.sessionId;
        const credentialRoot = runCredentialRoot(sessionId);
        const localCredentialRoot = join(root, "credentials");
        const blocked = new Error("Synthetic fixture forbids provider access");
        let lookups = 0;
        const modal = {
          logger: { debug() {}, warn() {} },
          cpClient: {
            taskGetCommandRouterAccess: async () => {
              lookups++;
              throw blocked;
            },
          },
        };
        const sandbox = new distribution.Sandbox(modal as never, "synthetic-sandbox", {
          taskId: "synthetic-task",
        });
        const session = new distribution.Session({
          modal,
          sandbox,
          app: {},
          ownsSandbox: false,
          state: {
            sandboxId: "synthetic-sandbox",
            appName: "synthetic",
            manifest: new Manifest({ root: "/workspace" }),
            environment: {},
            workspacePersistence: "tar",
            ownsSandbox: false,
            imageTag: "synthetic",
          },
        } as never);
        const value = "synthetic ' \" $HOME `literal` € 😀\n".repeat(1_100);
        const content = "synthetic file: ' $TOKEN ☁️\n".repeat(2_800);
        expect(Buffer.byteLength(value)).toBeLessThanOrEqual(65_536);
        expect(Buffer.byteLength(value + value)).toBeGreaterThan(70_609);
        expect(Buffer.byteLength(content)).toBeGreaterThan(70_609);
        let commands = 0;
        let maxArgvBytes = 0;
        const local = async (cmd: string) => {
          const child = Bun.spawn(["/bin/sh", "-c", cmd], {
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { stdout, stderr, exitCode };
        };
        const exec = sandbox.exec.bind(sandbox);
        sandbox.exec = async (argv, options) => {
          const bytes = argv.reduce((total, arg) => total + Buffer.byteLength(arg) + 1, 0);
          maxArgvBytes = Math.max(maxArgvBytes, bytes);
          expect(bytes).toBeLessThan(65_536);
          // Exercise the installed SDK validator. A valid request reaches only
          // the local sentinel lookup; no router URL, credentials or RPC exist.
          await expect(exec(argv, options)).rejects.toBe(blocked);
          const child = Bun.spawn(
            argv.map((arg) => arg.replaceAll(credentialRoot, localCredentialRoot)),
            {
              cwd: root,
              env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          return {
            stdout: child.stdout.pipeThrough(new TextDecoderStream()),
            stderr: child.stderr.pipeThrough(new TextDecoderStream()),
            wait: () => child.exited,
          } as never;
        };
        try {
          // The actual validator rejects one oversized request before lookup.
          await expect(exec(["/bin/sh", "-c", "x".repeat(70_610)])).rejects.toThrow("ARG_MAX");
          expect(lookups).toBe(0);
          await materializeRunCredentials(
            session,
            normalizeRunCredentialsResolution(
              {
                status: "ok",
                accountId: "synthetic-account",
                workspaceId: "synthetic-workspace",
                sessionId,
                environment: { SYNTHETIC_CREDENTIAL: value, SYNTHETIC_OTHER: value },
                files: [{ path: metadata.filePath, content, mode: "0400" }],
                fileEnvironment: { SYNTHETIC_FILE: metadata.filePath },
              },
              { accountId: "synthetic-account", workspaceId: "synthetic-workspace", sessionId },
            ),
            {
              sessionId,
              attemptId: metadata.attemptId,
              executionGeneration: metadata.generation,
              commandRunner: async (_session, args) => {
                commands++;
                return await session.execCommand({
                  ...args,
                  cmd: cancellableShellCommand(args.cmd, join(root, crypto.randomUUID())),
                  runAs: String(process.getuid!()),
                });
              },
            },
          );
          expect(lookups).toBe(commands);
          expect(maxArgvBytes).toBeLessThan(65_536);
          const active = (await readFile(join(localCredentialRoot, "current"), "utf8")).trim();
          expect((await stat(localCredentialRoot)).mode & 0o777).toBe(0o700);
          expect(
            (await stat(join(localCredentialRoot, "versions", active, "env"))).mode & 0o777,
          ).toBe(0o600);
          const config = join(localCredentialRoot, "versions", active, "files", metadata.filePath);
          expect(await readFile(config, "utf8")).toBe(content);
          expect((await stat(config)).mode & 0o777).toBe(0o400);
          const read = await local(
            withRunCredentialEnvironment(
              'printf "%s" "$SYNTHETIC_CREDENTIAL" "$SYNTHETIC_OTHER"',
              sessionId,
            ).replaceAll(credentialRoot, localCredentialRoot),
          );
          expect(read.exitCode).toBe(0);
          expect(read.stdout).toBe(value + value);
          expect(read.stderr).toBe("");
          const fileReference = await local(
            withRunCredentialEnvironment('printf "%s" "$SYNTHETIC_FILE"', sessionId).replaceAll(
              credentialRoot,
              localCredentialRoot,
            ),
          );
          expect(fileReference.exitCode).toBe(0);
          expect(fileReference.stdout).toBe(
            `${credentialRoot}/versions/${active}/files/${metadata.filePath}`,
          );
          expect(fileReference.stderr).toBe("");
          expect(session.state.environment).toEqual({});
        } finally {
          sandbox.detach();
          await rm(root, { recursive: true, force: true });
        }
      },
      60_000,
    );
  }
}
