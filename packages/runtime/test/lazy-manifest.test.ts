import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { dir, file, Manifest, SandboxAgent, type SandboxSessionLike } from "@openai/agents/sandbox";
import { recordLazyMaterializedDirectories } from "../src/lazy-manifest";
import { workspaceSkills } from "../src/workspace-skills";
import { RoutingSandboxSession, type RoutableBackendSession } from "../src/sandbox";
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Exercise the pinned SDK's real cache key and capability cloning. Do not
// replace this with a local imitation of its manifest signature algorithm.
const { SandboxRuntimeManager } = await import(
  new URL("./sandbox/runtime/manager.mjs", import.meta.resolve("@openai/agents-core")).href
);

function backend(manifest = new Manifest()): SandboxSessionLike {
  return {
    state: { manifest },
    listDir: async () => [],
    readFile: async () => "# Guidance",
  };
}

describe("lazy logical manifest handoff", () => {
  test.skipIf(process.platform === "win32")(
    "verifies placeholders through the real local adapter",
    async () => {
      const session = await new UnixLocalSandboxClient().create(new Manifest());
      try {
        await mkdir(join(session.state.workspaceRootPath, "repos/repo"), { recursive: true });
        const target = new Manifest({
          ...session.state.manifest,
          entries: { "repos/repo": dir() },
        });
        await recordLazyMaterializedDirectories(session, target);
        expect(session.state.manifest).toEqual(target);
      } finally {
        await session.delete();
      }
    },
  );

  test("records only verified directory placeholders without provider materialization", async () => {
    const target = new Manifest({ entries: { "repos/repo": dir() } });
    const session = backend();
    const paths: string[] = [];
    session.listDir = async ({ path }) => {
      paths.push(path);
      return [];
    };
    session.applyManifest = async () => {
      throw new Error("must not materialize");
    };
    await recordLazyMaterializedDirectories(session, target);
    expect(session.state.manifest).toEqual(target);
    expect(paths).toEqual(["/workspace/repos/repo"]);
    await recordLazyMaterializedDirectories(session, target);
    expect(paths).toHaveLength(1);
  });

  for (const [name, target] of [
    ["root", new Manifest({ root: "/other", entries: { repo: dir() } })],
    ["environment", new Manifest({ environment: { A: "new" }, entries: { repo: dir() } })],
    ["users", new Manifest({ users: [{ name: "agent" }], entries: { repo: dir() } })],
    [
      "grants",
      new Manifest({
        extraPathGrants: [{ path: "/outside", access: "read" }],
        entries: { repo: dir() },
      }),
    ],
    ["file", new Manifest({ entries: { repo: file({ content: "not materialized" }) } })],
    [
      "rich directory",
      new Manifest({ entries: { repo: dir({ children: { data: file({ content: "x" }) } }) } }),
    ],
  ] as const) {
    test(`does not conceal ${name} changes from SDK validation/cache invalidation`, async () => {
      const session = backend();
      const original = session.state.manifest;
      session.listDir = async () => {
        throw new Error("must not probe incompatible manifests");
      };
      await recordLazyMaterializedDirectories(session, target);
      expect(session.state.manifest).toBe(original);
    });
  }

  test("preserves existing entries and refuses replacements", async () => {
    const session = backend(new Manifest({ entries: { original: file({ content: "original" }) } }));
    await recordLazyMaterializedDirectories(session, new Manifest({ entries: { repo: dir() } }));
    expect(Object.keys(session.state.manifest.entries)).toEqual(["original", "repo"]);
    const original = session.state.manifest;
    await recordLazyMaterializedDirectories(
      session,
      new Manifest({ entries: { original: dir() } }),
    );
    expect(session.state.manifest).toBe(original);
  });

  test("failed verification and concurrent state replacement cannot publish a false manifest", async () => {
    const target = new Manifest({ entries: { repo: dir() } });
    const session = backend();
    const original = session.state.manifest;
    const failure = Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
    session.listDir = async () => {
      throw failure;
    };
    await expect(recordLazyMaterializedDirectories(session, target)).rejects.toBe(failure);
    expect(session.state.manifest).toBe(original);
    const replacement = new Manifest({ root: "/new-root" });
    session.listDir = async () => {
      session.state.manifest = replacement;
      return [];
    };
    await recordLazyMaterializedDirectories(session, target);
    expect(session.state.manifest).toBe(replacement);
  });

  for (const synchronize of [false, true]) {
    test(`SDK 0.14.3 five-request lazy transition: ${synchronize ? "one scan with handoff" : "two scans without handoff"}`, async () => {
      const manifest = new Manifest({ entries: { "repos/repo": dir() } });
      const searchRoot = "repos/repo/.agents/skills";
      const real = backend();
      let scans = 0;
      real.listDir = async ({ path }) => {
        path = path.replace(/^\/workspace\//, "");
        if (path === searchRoot) {
          scans++;
          return [{ name: "example", type: "dir", path: `${searchRoot}/example` }];
        }
        if (path === `${searchRoot}/example`) {
          return [{ name: "SKILL.md", type: "file", path: `${searchRoot}/example/SKILL.md` }];
        }
        return [];
      };
      let epoch = 1;
      const proxy = new RoutingSandboxSession({
        defaultResolved: {
          session: { state: { manifest } },
          sandboxId: null,
          kind: "unprovisioned",
        },
        readPointer: async () => ({ activeSandboxId: null, activeEpoch: epoch }),
        resolveActiveBackend: async () => {
          if (synchronize) await recordLazyMaterializedDirectories(real, manifest);
          return {
            session: real as unknown as RoutableBackendSession,
            sandboxId: null,
            kind: "modal",
          };
        },
      });
      const agent = new SandboxAgent({
        name: "cache regression",
        model: "gpt-test",
        defaultManifest: manifest,
        capabilities: [workspaceSkills([{ path: searchRoot, source: "test" }])],
      });
      const manager = new SandboxRuntimeManager({ startingAgent: agent });
      for (let request = 0; request < 5; request++) {
        const prepared = manager.getPreparedAgent(agent, proxy);
        expect(await prepared.getSystemPrompt(new RunContext({}))).toContain('"name":"example"');
      }
      expect(scans).toBe(synchronize ? 1 : 2);
      // A real manifest/route change must still invalidate preparation.
      epoch++;
      real.state.manifest = new Manifest({ environment: { CHANGED: "1" } });
      await proxy.listDir({ path: searchRoot });
      const before = scans;
      await manager.getPreparedAgent(agent, proxy).getSystemPrompt(new RunContext({}));
      expect(scans).toBe(before + 1);
    });
  }
});
