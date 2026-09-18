import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  createAttemptToolEnvironment,
  parseVerifiedAttemptToolCatalog,
  AttemptToolCatalogIntegrityError,
} from "@opengeni/codemode";
import {
  installManagedCodemodeClient,
  managedCodemodeClientDirectory,
  managedCodemodeClientEnvironment,
  type ManagedCodemodeClient,
} from "../src/sandbox/codemode-client";
import { withCodemodeTokenEnvironment } from "../src/sandbox/codemode-token";

async function shell(cmd: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn(["sh", "-c", cmd], {
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function fileSession(corrupt = false, failDelete = false, staged: string[] = []) {
  return {
    createEditor: () => ({
      createFile: async ({ path, diff }: { path: string; diff: string }) => {
        staged.push(path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, diff.slice(1) + (corrupt ? "corrupt" : "\n"));
      },
      deleteFile: async ({ path }: { path: string }) => {
        if (failDelete) throw new Error("provider delete unavailable");
        await rm(path, { force: true });
      },
    }),
  };
}

describe("managed release-owned Codemode delivery", () => {
  test("installs, verifies warm reuse, repairs damaged bytes, and keeps releases separate", async () => {
    const first: ManagedCodemodeClient = {
      version: 1,
      files: {
        ogtool: "#!/usr/bin/env node\nconsole.log('release-one');\n",
        "client.mjs": "export const release = 1;\n",
        "package.json": '{"type":"commonjs"}\n',
      },
    };
    const second: ManagedCodemodeClient = {
      ...first,
      files: { ...first.files, "client.mjs": "export const release = 2;\n" },
    };
    const one = managedCodemodeClientDirectory(first);
    const two = managedCodemodeClientDirectory(second);
    try {
      await installManagedCodemodeClient(fileSession() as never, first, shell);
      // A valid warm copy needs no file ingress.
      await installManagedCodemodeClient({} as never, first, shell);
      await chmod(`${one}/ogtool`, 0o644);
      await installManagedCodemodeClient(fileSession() as never, first, shell);
      await writeFile(`${one}/client.mjs`, "tampered");
      await installManagedCodemodeClient(fileSession() as never, first, shell);
      expect(await readFile(`${one}/client.mjs`, "utf8")).toBe(first.files["client.mjs"]);
      await installManagedCodemodeClient(fileSession() as never, second, shell);
      expect(two).not.toBe(one);
      const result = await shell([...managedCodemodeClientEnvironment(one), "ogtool"].join("\n"));
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("release-one");
      expect(await readFile(`${two}/client.mjs`, "utf8")).toBe(second.files["client.mjs"]);
      const native = await shell(
        [
          ...managedCodemodeClientEnvironment(one),
          'printf "%s" "${OPENGENI_CODEMODE_CLIENT_MODULE:-native}"',
        ].join("\n"),
        {
          OPENGENI_CODEMODE_NATIVE_CLIENT: "/connection/client",
          OPENGENI_CODEMODE_CLIENT_MODULE: "/stale/managed/module",
        },
      );
      expect(native.stdout).toBe("native");
    } finally {
      await rm(one, { recursive: true, force: true });
      await rm(two, { recursive: true, force: true });
    }
  });

  test("refuses corrupted transfer and missing ingress without falling back to a baked client", async () => {
    const client: ManagedCodemodeClient = {
      version: 1,
      files: {
        ogtool: "unique-invalid-transfer",
        "client.mjs": "",
        "package.json": '{"type":"commonjs"}\n',
      },
    };
    await expect(installManagedCodemodeClient({} as never, client, shell)).rejects.toThrow(
      "requires sandbox file ingress",
    );
    await expect(
      installManagedCodemodeClient(fileSession(true) as never, client, shell),
    ).rejects.toThrow("delivery failed");
  });

  test("cleans the exact ingress file through the command fence when editor deletion fails", async () => {
    const client: ManagedCodemodeClient = {
      version: 1,
      files: {
        ogtool: "#!/usr/bin/env node\nconsole.log('cleanup-test');\n",
        "client.mjs": "export const release = 'cleanup';\n",
        "package.json": '{"type":"commonjs"}\n',
      },
    };
    const directory = managedCodemodeClientDirectory(client);
    const staged: string[] = [];
    try {
      await installManagedCodemodeClient(fileSession(false, true, staged) as never, client, shell);
      expect(staged).toHaveLength(1);
      expect(await Bun.file(staged[0]!).exists()).toBe(false);
      await rm(directory, { recursive: true, force: true });
      await expect(
        installManagedCodemodeClient(
          fileSession(false, true, staged) as never,
          client,
          async (cmd) => (cmd.includes("rmSync") ? { exitCode: 1 } : await shell(cmd)),
        ),
      ).rejects.toThrow("staging cleanup failed");
      expect(staged).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
      for (const path of staged) await rm(path, { force: true });
    }
  });

  test("release bundle accepts canonical catalog, rejects legacy/tampered digests, and uses the same authorized journal", async () => {
    const buildRoot = await mkdtemp(resolve(tmpdir(), "opengeni-client-build-"));
    const asset = resolve(buildRoot, "client.json");
    const build = Bun.spawn([process.execPath, "scripts/build-managed-codemode-client.ts", asset], {
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildError = await new Response(build.stderr).text();
    expect(buildError).toBe("");
    expect(await build.exited).toBe(0);
    const client = JSON.parse(await readFile(asset, "utf8")) as ManagedCodemodeClient;
    // Exercise the compiled loader without any source-checkout siblings. Both
    // delivered layouts carry the exact asset alongside their runtime bundle.
    const workerLayout = resolve(buildRoot, "worker");
    const loaderBuild = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../src/sandbox/codemode-client.ts")],
      outdir: workerLayout,
      naming: "loader.mjs",
      target: "bun",
      format: "esm",
    });
    expect(loaderBuild.success).toBe(true);
    const runScript = async (script: string) => {
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    };
    for (const layout of [workerLayout, resolve(buildRoot, "runtime/dist")]) {
      await mkdir(resolve(layout, "assets"), { recursive: true });
      if (layout !== workerLayout)
        await copyFile(resolve(workerLayout, "loader.mjs"), resolve(layout, "loader.mjs"));
      await copyFile(asset, resolve(layout, "assets/codemode-client.json"));
      const loaded = await runScript(
        `const {loadManagedCodemodeClient,managedCodemodeClientDigest}=await import(${JSON.stringify(resolve(layout, "loader.mjs"))}); console.log(managedCodemodeClientDigest(await loadManagedCodemodeClient()));`,
      );
      expect(loaded.stderr).toBe("");
      expect(loaded.exitCode).toBe(0);
      expect(loaded.stdout.trim()).toBe(managedCodemodeClientDirectory(client).split("/").at(-1)!);
    }
    await rm(resolve(workerLayout, "assets/codemode-client.json"));
    const missing = await runScript(
      `const {loadManagedCodemodeClient}=await import(${JSON.stringify(resolve(workerLayout, "loader.mjs"))}); await loadManagedCodemodeClient();`,
    );
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("Managed Codemode client asset missing");

    // Do not mutate /workspace/package.json: reproduce an ESM ancestor inside
    // a private test directory, using the actual emitted verified asset set.
    await writeFile(resolve(buildRoot, "package.json"), '{"type":"module"}');
    const esmCliDirectory = resolve(buildRoot, "warm/client");
    await mkdir(esmCliDirectory, { recursive: true });
    for (const [name, source] of Object.entries(client.files)) {
      await writeFile(resolve(esmCliDirectory, name), source, { mode: 0o755 });
    }
    const esmCli = await shell(`${JSON.stringify(resolve(esmCliDirectory, "ogtool"))} --version`);
    expect(esmCli.stderr).toBe("");
    expect(esmCli.exitCode).toBe(0);
    const directory = managedCodemodeClientDirectory(client);
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      },
      generation: 1,
      definitions: [
        {
          identity: { serverId: "docs", toolName: "search" },
          modelName: "docs__search",
          inputSchema: {
            type: "object",
            properties: { Z: { type: "string" }, a: { type: "string" }, _x: { type: "string" } },
          },
          description: "canonical",
          source: "mcp",
          approval: "none",
          execute: async () => ({ content: [] }),
        },
      ],
    });
    const catalog = environment.catalog;
    const localeCanonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(localeCanonical)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, entry]) => [key, localeCanonical(entry)]),
            )
          : value;
    const { digest, createdAt: _createdAt, ...unsigned } = catalog;
    const oldDigest = createHash("sha256")
      .update(JSON.stringify(localeCanonical(unsigned)))
      .digest("hex");
    expect(oldDigest).not.toBe(digest); // Frozen reproduction of the 0.3.13 client algorithm.
    expect(() => parseVerifiedAttemptToolCatalog({ ...catalog, digest: oldDigest })).toThrow(
      AttemptToolCatalogIntegrityError,
    );
    const requests: Array<{ path: string; auth: string | null; payload?: unknown }> = [];
    let tamper = false;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push({ path, auth: request.headers.get("authorization") });
        if (request.headers.get("authorization") !== "Bearer delivery-test")
          return new Response("unauthorized", { status: 401 });
        if (path.endsWith("/catalog"))
          return Response.json(
            tamper
              ? { ...catalog, entries: [{ ...catalog.entries[0], description: "tampered" }] }
              : catalog,
          );
        if (path.endsWith("/calls") && request.method === "POST") {
          const payload = (await request.json()) as {
            operationId: string;
            catalogDigest: string;
            identity: unknown;
            arguments: unknown;
          };
          requests.at(-1)!.payload = payload;
          expect(payload.catalogDigest).toBe(digest);
          return Response.json({
            dispatch: "terminal",
            operation: {
              accountId: catalog.accountId,
              workspaceId: catalog.workspaceId,
              sessionId: catalog.sessionId,
              turnId: catalog.turnId,
              attemptId: catalog.attemptId,
              executionGeneration: catalog.executionGeneration,
              version: 1,
              operationId: payload.operationId,
              catalogDigest: digest,
              requestDigest: "b".repeat(64),
              identity: payload.identity,
              arguments: payload.arguments,
              caller: { kind: "codemode", subjectId: "agent:test" },
              state: "completed",
              result: { content: [{ type: "text", text: "same-journal" }] },
              errorCode: null,
              errorMessage: null,
              createdAt: catalog.createdAt,
              updatedAt: catalog.createdAt,
              claimedAt: catalog.createdAt,
              executionStartedAt: catalog.createdAt,
              completedAt: catalog.createdAt,
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await installManagedCodemodeClient(fileSession() as never, client, shell);
      const env = {
        OPENGENI_CODEMODE_URL: `http://127.0.0.1:${server.port}/codemode`,
        OPENGENI_CODEMODE_TOKEN: "delivery-test",
      };
      const exec = (cmd: string) =>
        shell(
          withCodemodeTokenEnvironment(cmd, "/unused", env.OPENGENI_CODEMODE_URL, directory),
          env,
        );
      const list = await exec("ogtool list --json");
      expect(list.exitCode).toBe(0);
      expect(JSON.parse(list.stdout).catalogDigest).toBe(digest);
      const call = await exec("ogtool call docs.search '{}'");
      expect(call.stderr).toBe("");
      expect(call.exitCode).toBe(0);
      expect(call.stdout).toContain("same-journal");
      const js = await exec(
        `bun -e 'const { CodemodeClient } = await import(process.env.OPENGENI_CODEMODE_CLIENT_MODULE); const c = new CodemodeClient({baseUrl:process.env.OPENGENI_CODEMODE_URL,token:()=>process.env.OPENGENI_CODEMODE_TOKEN}); console.log((await c.catalog()).digest)'`,
      );
      expect(js.exitCode).toBe(0);
      expect(js.stdout.trim()).toBe(digest);
      expect(requests.every((request) => request.auth === "Bearer delivery-test")).toBe(true);
      expect(requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1);
      const unauthorized = await shell(
        withCodemodeTokenEnvironment(
          "ogtool call docs.search '{}'",
          "/unused",
          env.OPENGENI_CODEMODE_URL,
          directory,
        ),
        {
          ...env,
          OPENGENI_CODEMODE_TOKEN: "wrong-attempt",
        },
      );
      expect(unauthorized.exitCode).not.toBe(0);
      expect(requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1);
      tamper = true;
      const rejected = await exec("ogtool list --json");
      expect(rejected.exitCode).not.toBe(0);
      expect(requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
      await rm(buildRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
