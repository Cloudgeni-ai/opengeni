import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";

import {
  Manifest,
  SandboxWorkspaceReadNotFoundError,
  type SandboxSessionLike,
} from "@openai/agents/sandbox";
import { SandboxFilesystemNotFoundError } from "modal";
import { ErrorCode } from "@opengeni/agent-proto";
import { testSettings } from "@opengeni/testing";

import { buildAgentCapabilities, repositoryWorkspaceSkillPathsOption } from "../src";
import {
  markModelPreparationFirstSandboxOperation,
  type ModelPreparationMeasurement,
  recordModelPreparationMeasurement,
  withModelPreparationObserver,
} from "../src/model-preparation-diagnostics";
import {
  agentErrorToControlError,
  offlineAgentError,
  SelfhostedControlError,
  timeoutAgentError,
} from "../src/sandbox/selfhosted/control-rpc";
import { discoverWorkspaceSkills, workspaceSkills } from "../src/workspace-skills";

describe("workspace repository skills", () => {
  test("bounded discovery preserves deterministic output and reduces remote critical path", async () => {
    const latency = Number(process.env.OPENGENI_SKILL_BENCHMARK_PROVIDER_MS ?? 10);
    const files = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [
        `root${index % 8}/skill${String(index).padStart(2, "0")}/SKILL.md`,
        `# Skill ${index}`,
      ]),
    );
    const session = fakeSession(files);
    const listDir = session.listDir!;
    const readFile = session.readFile!;
    let active = 0;
    let peak = 0;
    let operations = 0;
    let providerOperations = 0;
    const delay = async <T>(op: () => Promise<T>, count: number): Promise<T> => {
      active++;
      peak = Math.max(peak, active);
      operations++;
      providerOperations += count;
      // Reads use two provider operations in the measured Modal adapter.
      await Bun.sleep(latency * count);
      try {
        return await op();
      } finally {
        active--;
      }
    };
    session.listDir = (args) => delay(() => listDir(args), 1);
    session.readFile = (args) => delay(() => readFile(args), 2);
    const started = performance.now();
    const skills = await discoverWorkspaceSkills(
      session,
      Array.from({ length: 8 }, (_, index) => ({ path: `root${index}`, source: `root${index}` })),
    );
    const elapsed = performance.now() - started;
    expect(skills.map((skill) => skill.name)).toEqual(
      Array.from({ length: 14 }, (_, index) => `skill${String(index).padStart(2, "0")}`),
    );
    expect(operations).toBe(36);
    expect(providerOperations).toBe(50);
    expect(peak).toBe(8);
    expect(active).toBe(0);
    // Measure the same fixture with a serialized transport as well. The opt-in
    // 220ms setting reproduces the reported remote latency without cloud costs.
    let tail = Promise.resolve();
    const serial = <T>(op: () => Promise<T>, count: number): Promise<T> => {
      const result = tail.then(async () => {
        await Bun.sleep(latency * count);
        return op();
      });
      tail = result.then(() => {});
      return result;
    };
    session.listDir = (args) => serial(() => listDir(args), 1);
    session.readFile = (args) => serial(() => readFile(args), 2);
    const serialStarted = performance.now();
    expect(
      await discoverWorkspaceSkills(
        session,
        Array.from({ length: 8 }, (_, index) => ({ path: `root${index}`, source: `root${index}` })),
      ),
    ).toEqual(skills);
    const serialElapsed = performance.now() - serialStarted;
    expect(elapsed).toBeLessThan(serialElapsed * 0.7);
    console.info(
      `Skill discovery fixture: 50 simulated provider ops at ${latency}ms, serial ${serialElapsed.toFixed(1)}ms, bounded ${elapsed.toFixed(1)}ms, peak ${peak}`,
    );
  }, 20_000);

  test("abort drains started reads and schedules no later roots", async () => {
    const session = fakeSession({});
    const aborted = Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
    let calls = 0;
    let active = 0;
    session.listDir = async () => {
      const index = calls++;
      active++;
      await Bun.sleep(index === 0 ? 1 : 10);
      active--;
      if (index === 0) throw aborted;
      return [];
    };
    await expect(
      discoverWorkspaceSkills(
        session,
        Array.from({ length: 30 }, (_, index) => ({ path: `root${index}`, source: "test" })),
      ),
    ).rejects.toBe(aborted);
    expect(calls).toBe(8);
    expect(active).toBe(0);
  });

  for (const [description, expected] of [
    ["|-\n  First line.\n  Second line.", "First line.\nSecond line."],
    [">-\n  First paragraph.\n\n  Second paragraph.", "First paragraph.\nSecond paragraph."],
  ]) {
    test(`capability preparation accepts multiline YAML ${description!.slice(0, 2)}`, async () => {
      const markdown = `---\nname: example\ndescription: ${description}\n---\n# Guidance`;
      const capability = workspaceSkills([{ path: ".agents/skills", source: "repository" }]).bind(
        fakeSession({ ".agents/skills/example/SKILL.md": markdown }),
      );
      const instructions = await capability.instructions();
      const descriptor = JSON.parse(
        instructions!
          .split("\n")
          .find((line) => line.startsWith("- {"))!
          .slice(2),
      );
      expect(descriptor.description).toBe(expected);
      const reader = capability.tools()[0]!;
      if (reader.type !== "function") throw new Error("missing reader");
      const output = JSON.parse(
        (await reader.invoke(undefined!, JSON.stringify({ skill: descriptor.id }))) as string,
      );
      expect(output.files[0].content).toBe(markdown);
    });
  }

  test.skipIf(process.platform === "win32")(
    "Unix-local discovery excludes symlink Skill entrypoints consistently with reading",
    async () => {
      const session = await new UnixLocalSandboxClient().create(
        new Manifest({ root: "/workspace" }),
      );
      try {
        const root = session.state.workspaceRootPath;
        for (const name of ["ordinary", "linked"])
          await mkdir(join(root, ".agents/skills", name), { recursive: true });
        const markdown = "---\nname: linked\ndescription: Linked guidance.\n---\n# Linked";
        await writeFile(join(root, "shared-skill.md"), markdown);
        await symlink("../../../shared-skill.md", join(root, ".agents/skills/linked/SKILL.md"));
        await writeFile(join(root, ".agents/skills/ordinary/SKILL.md"), "# Ordinary");
        await symlink(
          "../../../shared-skill.md",
          join(root, ".agents/skills/ordinary/reference.md"),
        );
        // Actual adapter behavior: direct reads follow the symlink, listing marks it other.
        expect(
          new TextDecoder().decode(
            await session.readFile({ path: ".agents/skills/linked/SKILL.md" }),
          ),
        ).toBe(markdown);
        expect((await session.listDir({ path: ".agents/skills/linked" }))[0]?.type).toBe("other");
        const capability = workspaceSkills([{ path: ".agents/skills", source: "repository" }]).bind(
          session,
        );
        const instructions = await capability.instructions();
        expect(instructions).not.toContain('"name":"linked"');
        expect(instructions).toContain('"name":"ordinary"');
        const reader = capability.tools()[0]!;
        if (reader.type !== "function") throw new Error("missing reader");
        const call = (args: object) =>
          reader.invoke(
            undefined!,
            JSON.stringify({ skill: "repository:.agents/skills/ordinary/SKILL.md", ...args }),
          );
        expect(JSON.parse((await call({ listFiles: true })) as string).paths).toEqual(["SKILL.md"]);
        expect(JSON.parse((await call({})) as string).files[0].content).toBe("# Ordinary");
        expect(await call({ paths: ["reference.md"] })).toContain("unavailable");
      } finally {
        await session.delete();
      }
    },
  );

  test("repository YAML descriptions preserve folded text", async () => {
    const session = fakeSession({
      ".agents/skills/opengeni/SKILL.md":
        "---\nname: opengeni\ndescription: >-\n  Maintain Opengeni\n  source code.\n---\n# Guidance",
    });
    const entries = await discoverWorkspaceSkills(session, [
      { path: ".agents/skills", source: "repository" },
    ]);
    expect(entries[0]?.description).toBe("Maintain Opengeni source code.");
  });

  test("advertised repository skills have an explicit live reader", async () => {
    const session = fakeSession({
      ".agents/skills/opengeni/SKILL.md":
        "---\nname: opengeni\ndescription: Maintain Opengeni.\n---\n# Guidance",
    });
    const capability = workspaceSkills([{ path: ".agents/skills", source: "repository" }]).bind(
      session,
    );
    const instructions = await capability.instructions();
    expect(instructions).toContain("repository_skill_read");
    const tool = capability
      .tools()
      .find(
        (candidate) => candidate.type === "function" && candidate.name === "repository_skill_read",
      );
    expect(tool).toBeDefined();
    if (tool?.type !== "function") throw new Error("missing reader");
    const result = JSON.parse(
      (await tool.invoke(
        undefined!,
        JSON.stringify({ skill: "repository:.agents/skills/opengeni/SKILL.md" }),
      )) as string,
    );
    expect(result.files[0].content).toContain("# Guidance");
  });

  test("repository reader uses exact paths, reads live content, and inventories without file bodies", async () => {
    const session = fakeSession({
      ".agents/skills/example/SKILL.md": "# Example",
      ".agents/skills/example/references/readme.md": "original",
    });
    const capability = workspaceSkills([{ path: ".agents/skills", source: "repository" }])
      .bind(session)
      .bindRunAs("agent");
    await capability.instructions();
    const read = session.readFile!;
    const calls: string[] = [];
    session.readFile = async (args) => {
      expect(args.runAs).toBe("agent");
      calls.push(args.path);
      return args.path.endsWith("readme.md") ? "edited" : read(args);
    };
    const tool = capability.tools()[0]!;
    if (tool.type !== "function") throw new Error("missing reader");
    const skill = "repository:.agents/skills/example/SKILL.md";
    const invoke = (args: object) => tool.invoke(undefined!, JSON.stringify({ skill, ...args }));
    expect(JSON.parse((await invoke({ listFiles: true })) as string).paths).toEqual([
      "SKILL.md",
      "references/readme.md",
    ]);
    expect(calls).toEqual([]);
    expect(JSON.parse((await invoke({ paths: ["references/readme.md"] })) as string).files).toEqual(
      [{ path: "references/readme.md", content: "edited" }],
    );
    expect(calls).toEqual([".agents/skills/example/references/readme.md"]);
    for (const args of [
      { paths: ["../outside"] },
      { paths: ["/etc/passwd"] },
      { paths: ["SKILL.md", "SKILL.md"] },
      { listFiles: true, paths: ["SKILL.md"] },
      { skill: "example" },
      { skill: "repository:other/SKILL.md" },
    ]) {
      expect(await invoke(args)).toContain("Error");
    }
    expect(calls).toHaveLength(1);
    session.readFile = async () => "x".repeat(512 * 1024);
    expect(await invoke({})).toContain("exceed");
    // Inner file output fits exactly, but source metadata must also fit the final envelope.
    const overhead = JSON.stringify({ files: [{ path: "SKILL.md", content: "" }] }).length;
    session.readFile = async () => "x".repeat(512 * 1024 - overhead);
    expect(await invoke({})).toContain("response exceeds");
    session.listDir = async () => [];
    expect(await invoke({})).toContain("unavailable");
  });

  test("repository tool authorization survives SDK clone and bind", async () => {
    let authorized = true;
    const caps = buildAgentCapabilities(testSettings(), [], {
      workspaceSkillPaths: [{ path: ".agents/skills", source: "repository" }],
      authorizeAttemptExecution: () => {
        if (!authorized) throw new Error("attempt ended");
      },
      structuredToolTransport: false,
    });
    const original = caps.find((entry) => entry.type === "workspace-skills")!;
    const bound = original
      .clone()
      .bind(fakeSession({ ".agents/skills/example/SKILL.md": "# Example" }));
    const tool = bound
      .tools()
      .find((entry) => entry.type === "function" && entry.name === "repository_skill_read")!;
    if (tool.type !== "function") throw new Error("missing reader");
    await bound.instructions(new Manifest({ root: "/workspace" }));
    expect(
      await tool.invoke(
        undefined!,
        JSON.stringify({ skill: "repository:.agents/skills/example/SKILL.md" }),
      ),
    ).toContain("# Example");
    authorized = false;
    await expect(
      tool.invoke(
        undefined!,
        JSON.stringify({ skill: "repository:.agents/skills/example/SKILL.md" }),
      ),
    ).rejects.toThrow("attempt ended");
  });

  test("rebound repository capability cannot reuse another sandbox's catalog", async () => {
    const capability = workspaceSkills([{ path: ".agents/skills", source: "repository" }]).bind(
      fakeSession({ ".agents/skills/example/SKILL.md": "# Example" }),
    );
    expect(await capability.instructions()).toContain("example");
    const rebound = capability.clone().bind(fakeSession({}));
    expect(await rebound.instructions(new Manifest({ root: "/workspace" }))).toBeNull();
  });

  for (const Missing of [SandboxFilesystemNotFoundError, SandboxWorkspaceReadNotFoundError]) {
    test(`skips optional roots and SKILL.md with real ${Missing.name}`, async () => {
      const session = fakeSession({ ".agents/skills/example/SKILL.md": "# Example" });
      const listDir = session.listDir!;
      session.listDir = async (args) => {
        if (args.path === ".claude/skills") throw new Missing("path missing");
        return await listDir(args);
      };
      session.readFile = async () => {
        throw new Missing("SKILL.md missing");
      };
      await expect(
        discoverWorkspaceSkills(session, [
          { path: ".claude/skills", source: "claude" },
          { path: ".agents/skills", source: "agents" },
        ]),
      ).resolves.toEqual([]);
    });
  }
  for (const code of ["rotation_in_progress", "EACCES", "ECONNRESET", "ABORT_ERR"]) {
    test(`propagates directory ${code} after draining the bounded in-flight roots`, async () => {
      const failure = Object.assign(new Error(code), { code });
      let calls = 0;
      const session = fakeSession({});
      session.listDir = async () => {
        calls++;
        throw failure;
      };
      await expect(
        discoverWorkspaceSkills(session, [
          { path: ".agents/skills", source: "agents" },
          { path: ".claude/skills", source: "claude" },
        ]),
      ).rejects.toBe(failure);
      expect(calls).toBe(2);
    });

    test(`propagates skill file ${code}`, async () => {
      const failure = Object.assign(new Error(code), { code });
      const session = fakeSession({ ".agents/skills/example/SKILL.md": "# Example" });
      session.readFile = async () => {
        throw failure;
      };
      await expect(
        discoverWorkspaceSkills(session, [{ path: ".agents/skills", source: "agents" }]),
      ).rejects.toBe(failure);
    });
  }

  test("does not confuse a provider not-found with a missing skill path", async () => {
    const failure = new Error("sandbox not found");
    const session = fakeSession({});
    session.listDir = async () => {
      throw failure;
    };
    await expect(
      discoverWorkspaceSkills(session, [{ path: ".agents/skills", source: "agents" }]),
    ).rejects.toBe(failure);
  });
  test("does not add workspace probes when no repository is attached", () => {
    expect(repositoryWorkspaceSkillPathsOption([])).toEqual({});
    expect(
      repositoryWorkspaceSkillPathsOption([
        {
          kind: "file",
          fileId: "6c9dc458-aa03-4543-b92f-cbcf483c4f2d",
          mountPath: "files/input",
        },
      ]),
    ).toEqual({});
  });

  test("checks both a connected-machine root and managed repository mounts", () => {
    expect(
      repositoryWorkspaceSkillPathsOption([
        {
          kind: "repository",
          uri: "https://example.com/example/project.git",
          ref: "main",
          mountPath: "repos/example/project",
        },
      ]),
    ).toEqual({
      workspaceSkillPaths: [
        { path: ".agents/skills", source: "workspace .agents/skills" },
        { path: ".claude/skills", source: "workspace .claude/skills" },
        {
          path: "repos/example/project/.agents/skills",
          source: "repos/example/project/.agents/skills",
        },
        {
          path: "repos/example/project/.claude/skills",
          source: "repos/example/project/.claude/skills",
        },
      ],
    });
  });

  test("discovers real workspace paths and deduplicates identical aliases", async () => {
    const skill = `---
name: release
description: Prepare a safe release.
---

# Release
`;
    const session = fakeSession({
      ".agents/skills/release/SKILL.md": skill,
      ".agents/skills/release/references/checklist.md": "verify\n",
      ".claude/skills/release/SKILL.md": skill,
      ".claude/skills/release/references/checklist.md": "verify\n",
    });
    const skills = await discoverWorkspaceSkills(session, [
      { path: ".agents/skills", source: ".agents/skills" },
      { path: ".claude/skills", source: ".claude/skills" },
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "release",
      description: "Prepare a safe release.",
      path: ".agents/skills/release/SKILL.md",
    });
  });

  test("records repository skill discovery duration and search-root count", async () => {
    const measurements: ModelPreparationMeasurement[] = [];
    const session = fakeSession({
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: Prepare a safe release.\n---\n",
    });

    await withModelPreparationObserver(
      (measurement) => measurements.push(measurement),
      () =>
        discoverWorkspaceSkills(session, [
          { path: ".agents/skills", source: ".agents/skills" },
          { path: ".claude/skills", source: ".claude/skills" },
        ]),
    );

    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      phase: "repository_skill_discovery",
      outcome: "completed",
      count: 2,
    });
    expect(measurements[0]!.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  test("excludes a nested first routed sandbox operation from discovery attribution", async () => {
    const measurements: ModelPreparationMeasurement[] = [];
    const session = fakeSession({
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: Prepare a safe release.\n---\n",
    });
    const originalList = session.listDir!;
    session.listDir = async (args) => {
      const startedAt = performance.now();
      const entries = await originalList(args);
      const durationSeconds = (performance.now() - startedAt) / 1_000;
      markModelPreparationFirstSandboxOperation(durationSeconds);
      recordModelPreparationMeasurement({
        phase: "sandbox_first_routed_provider_operation",
        outcome: "completed",
        durationSeconds,
      });
      return entries;
    };

    const startedAt = performance.now();
    await withModelPreparationObserver(
      (measurement) => measurements.push(measurement),
      () =>
        discoverWorkspaceSkills(session, [{ path: ".agents/skills", source: ".agents/skills" }]),
    );
    const wallSeconds = (performance.now() - startedAt) / 1_000;
    const discoverySeconds = measurements.find(
      ({ phase }) => phase === "repository_skill_discovery",
    )!.durationSeconds;
    const routedSandboxSeconds = measurements.find(
      ({ phase }) => phase === "sandbox_first_routed_provider_operation",
    )!.durationSeconds;

    expect(discoverySeconds).toBeGreaterThanOrEqual(0);
    expect(discoverySeconds + routedSandboxSeconds).toBeLessThanOrEqual(wallSeconds);
  });

  test("records failed repository skill discovery", async () => {
    const measurements: ModelPreparationMeasurement[] = [];
    const session = {
      state: { manifest: new Manifest({ root: "/workspace" }) },
    } as SandboxSessionLike;

    await expect(
      withModelPreparationObserver(
        (measurement) => measurements.push(measurement),
        () =>
          discoverWorkspaceSkills(session, [{ path: ".agents/skills", source: ".agents/skills" }]),
      ),
    ).rejects.toThrow(
      "Workspace skill discovery requires sandbox listDir() and readFile() support",
    );
    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      phase: "repository_skill_discovery",
      outcome: "failed",
      count: 1,
    });
  });

  test("unique skill names do not hash helper files", async () => {
    const skill = `---
name: release
description: Prepare a safe release.
---
`;
    const session = fakeSession({
      ".agents/skills/release/SKILL.md": skill,
      ".agents/skills/release/references/checklist.md": "verify\n",
      ".agents/skills/deploy/SKILL.md":
        "---\nname: deploy\ndescription: Deploy the service.\n---\n",
      ".agents/skills/deploy/scripts/run.sh": "echo deploy\n",
    });
    const reads: string[] = [];
    const listed: string[] = [];
    const originalRead = session.readFile!;
    const originalList = session.listDir!;
    session.readFile = async (args) => {
      reads.push(normalize(args.path));
      return await originalRead(args);
    };
    session.listDir = async (args) => {
      listed.push(normalize(args.path));
      return await originalList(args);
    };
    const skills = await discoverWorkspaceSkills(session, [
      { path: ".agents/skills", source: ".agents/skills" },
    ]);
    expect(skills.map((entry) => entry.name)).toEqual(["deploy", "release"]);
    expect(listed).toEqual([".agents/skills", ".agents/skills/deploy", ".agents/skills/release"]);
    expect(reads).toEqual([".agents/skills/deploy/SKILL.md", ".agents/skills/release/SKILL.md"]);
  });

  test("fails when the same skill name has different contents", async () => {
    const session = fakeSession({
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: First definition.\n---\n",
      ".claude/skills/release/SKILL.md":
        "---\nname: release\ndescription: Different definition.\n---\n",
    });
    await expect(
      discoverWorkspaceSkills(session, [
        { path: ".agents/skills", source: ".agents/skills" },
        { path: ".claude/skills", source: ".claude/skills" },
      ]),
    ).rejects.toThrow(
      'Workspace skill "release" has conflicting definitions in .agents/skills and .claude/skills',
    );
  });

  test("same name with identical SKILL.md but different helpers still conflicts", async () => {
    const skill = `---
name: release
description: Prepare a safe release.
---
`;
    const session = fakeSession({
      ".agents/skills/release/SKILL.md": skill,
      ".agents/skills/release/helper.sh": "echo a\n",
      ".claude/skills/release/SKILL.md": skill,
      ".claude/skills/release/helper.sh": "echo b\n",
    });
    await expect(
      discoverWorkspaceSkills(session, [
        { path: ".agents/skills", source: ".agents/skills" },
        { path: ".claude/skills", source: ".claude/skills" },
      ]),
    ).rejects.toThrow(
      'Workspace skill "release" has conflicting definitions in .agents/skills and .claude/skills',
    );
  });

  test("fails instead of ambiguously shadowing configured skills", async () => {
    const session = fakeSession({
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: Repository release instructions.\n---\n",
    });
    await expect(
      discoverWorkspaceSkills(
        session,
        [{ path: ".agents/skills", source: ".agents/skills" }],
        new Set(["release"]),
      ),
    ).rejects.toThrow('Workspace skill "release" conflicts with a configured Opengeni skill');
  });

  test("lets native tool-bound Skills deterministically shadow workspace copies", async () => {
    const session = fakeSession({
      ".agents/skills/opengeni-documents/SKILL.md":
        "---\nname: opengeni-documents\ndescription: Repository copy.\n---\n",
      ".agents/skills/release/SKILL.md":
        "---\nname: release\ndescription: Repository release instructions.\n---\n",
    });
    await expect(
      discoverWorkspaceSkills(
        session,
        [{ path: ".agents/skills", source: ".agents/skills" }],
        new Set(),
        undefined,
        new Set(["opengeni-documents"]),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "release",
        description: "Repository release instructions.",
      }),
    ]);
  });

  const unreachableFailures: Array<[string, () => SelfhostedControlError]> = [
    [
      "no authoritative live runner connection",
      () =>
        new SelfhostedControlError({
          message: "The Connected Machine has no authoritative live runner connection.",
          code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
          reason: "agent_offline",
          retryable: false,
          agentOffline: true,
        }),
    ],
    ["transport offline", () => agentErrorToControlError(offlineAgentError(undefined, true))],
    ["control request timeout", () => agentErrorToControlError(timeoutAgentError())],
  ];
  for (const [label, unreachable] of unreachableFailures) {
    test(`an unreachable workspace (${label}) degrades repository skills instead of failing instructions`, async () => {
      const session = fakeSession({ ".agents/skills/example/SKILL.md": "# Example" });
      let calls = 0;
      session.listDir = async () => {
        calls++;
        throw unreachable();
      };
      const capability = workspaceSkills([
        { path: ".agents/skills", source: "agents" },
        { path: ".claude/skills", source: "claude" },
      ]).bind(session);
      const instructions = await capability.instructions();
      expect(instructions).toContain("Repository skills could not be indexed");
      expect(instructions).not.toContain("repository_skill_read");
      // The run memoizes the degraded index: later model requests in the same
      // binding neither re-pay the unreachable cost nor change the prefix.
      expect(await capability.instructions()).toBe(instructions);
      expect(calls).toBe(2);
      const reader = capability.tools()[0]!;
      if (reader.type !== "function") throw new Error("missing reader");
      // The SDK renders the reader's refusal into the tool result.
      expect(
        await reader.invoke(
          undefined!,
          JSON.stringify({ skill: "repository:.agents/skills/example/SKILL.md" }),
        ),
      ).toContain("Repository Skill is not in this index");
      expect(calls).toBe(2);
    });
  }

  for (const offlineIndex of [0, 1]) {
    for (const offlineSettlesFirst of [true, false]) {
      test(`a concurrent genuine failure outranks an unreachable one (offline at index ${offlineIndex}, ${offlineSettlesFirst ? "offline" : "genuine"} settles first)`, async () => {
        const genuine = Object.assign(new Error("permission denied"), { code: "EACCES" });
        const offline = agentErrorToControlError(offlineAgentError(undefined, true));
        const pending = new Map<string, (error: unknown) => void>();
        let bothStarted!: () => void;
        const started = new Promise<void>((resolve) => (bothStarted = resolve));
        const session = fakeSession({});
        session.listDir = ({ path }) =>
          new Promise((_, reject) => {
            pending.set(path, reject);
            if (pending.size === 2) bothStarted();
          });
        const paths = ["root0", "root1"];
        const capability = workspaceSkills(paths.map((path) => ({ path, source: path }))).bind(
          session,
        );
        // Observe the outcome now: it may settle while the reads are released.
        const outcome = capability.instructions().then(
          () => undefined,
          (error: unknown) => error,
        );
        await started;
        const offlinePath = paths[offlineIndex]!;
        const genuinePath = paths[1 - offlineIndex]!;
        const order = offlineSettlesFirst
          ? [
              [offlinePath, offline],
              [genuinePath, genuine],
            ]
          : [
              [genuinePath, genuine],
              [offlinePath, offline],
            ];
        for (const [path, error] of order) {
          pending.get(path as string)!(error);
          await Bun.sleep(0);
        }
        expect(await outcome).toBe(genuine);
      });
    }
  }

  test("only unreachable failures degrade; the lowest index still wins among genuine ones", async () => {
    const first = new Error("first");
    const second = new Error("second");
    const session = fakeSession({});
    session.listDir = async ({ path }) => {
      if (path === "root0") throw agentErrorToControlError(timeoutAgentError());
      await Bun.sleep(path === "root1" ? 5 : 1);
      throw path === "root1" ? first : second;
    };
    await expect(
      discoverWorkspaceSkills(
        session,
        ["root0", "root1", "root2"].map((path) => ({ path, source: path })),
      ),
    ).rejects.toBe(first);
  });

  test("an unreachable skill file read mid-discovery also degrades", async () => {
    const session = fakeSession({ ".agents/skills/example/SKILL.md": "# Example" });
    session.readFile = async () => {
      throw agentErrorToControlError(timeoutAgentError());
    };
    const capability = workspaceSkills([{ path: ".agents/skills", source: "agents" }]).bind(
      session,
    );
    expect(await capability.instructions()).toContain("Repository skills could not be indexed");
  });

  test("a later run discovers repository skills once the workspace is reachable again", async () => {
    const session = fakeSession({ ".agents/skills/example/SKILL.md": "# Example" });
    const listDir = session.listDir!;
    let offline = true;
    session.listDir = async (args) => {
      if (offline) throw agentErrorToControlError(offlineAgentError(undefined, true));
      return await listDir(args);
    };
    const template = workspaceSkills([{ path: ".agents/skills", source: "agents" }]);
    const first = template.clone().bind(session);
    expect(await first.instructions()).toContain("Repository skills could not be indexed");
    offline = false;
    // The SDK clones and rebinds capabilities for every run; the degraded
    // result must not carry over as an authoritative empty index.
    const second = first.clone().bind(session);
    const instructions = await second.instructions();
    expect(instructions).toContain("repository:.agents/skills/example/SKILL.md");
    expect(instructions).not.toContain("could not be indexed");
  });

  const reachableFailures: Array<[string, () => unknown]> = [
    [
      "fenced control error",
      () =>
        new SelfhostedControlError({
          message: "fenced",
          code: ErrorCode.ERROR_CODE_FENCED,
          reason: null,
          retryable: true,
          fenced: true,
        }),
    ],
    [
      "consent control error",
      () =>
        agentErrorToControlError({
          code: ErrorCode.ERROR_CODE_CONSENT_REQUIRED,
          message: "consent required",
          retryable: false,
          detail: {},
        }),
    ],
    [
      "OS control error",
      () =>
        agentErrorToControlError({
          code: ErrorCode.ERROR_CODE_OS,
          message: "permission denied",
          retryable: false,
          detail: {},
        }),
    ],
    ["untyped error mentioning offline", () => new Error("agent offline: timed out")],
    [
      "untyped error shaped like an offline control error",
      () => Object.assign(new Error("offline"), { agentOffline: true, reason: "agent_offline" }),
    ],
  ];
  for (const [label, failure] of reachableFailures) {
    test(`repository skill instructions still fail on a ${label}`, async () => {
      const error = failure();
      const session = fakeSession({});
      session.listDir = async () => {
        throw error;
      };
      const capability = workspaceSkills([{ path: ".agents/skills", source: "agents" }]).bind(
        session,
      );
      await expect(capability.instructions()).rejects.toBe(error);
    });
  }

  test("an invalid repository skill still fails instructions", async () => {
    const capability = workspaceSkills([{ path: ".agents/skills", source: "agents" }]).bind(
      fakeSession({ ".agents/skills/bad/SKILL.md": "---\nname: bad name!\n---\n" }),
    );
    await expect(capability.instructions()).rejects.toThrow("Repository skill has an invalid name");
  });

  test("deduplicates identical inline session skills and rejects conflicts", () => {
    const release = {
      name: "release",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: release\ndescription: Release instructions\n---\n# Release\n",
        },
      ],
    };
    expect(() =>
      buildAgentCapabilities(testSettings(), [
        sessionActivation(release, "one"),
        sessionActivation({ ...release, files: [...release.files] }, "two"),
      ]),
    ).not.toThrow();
    expect(() =>
      buildAgentCapabilities(testSettings(), [
        sessionActivation(release, "one"),
        sessionActivation(
          {
            name: "release",
            files: [
              {
                path: "SKILL.md",
                content:
                  "---\nname: release\ndescription: Release instructions\n---\n# Different\n",
              },
            ],
          },
          "two",
        ),
      ]),
    ).toThrow('Conflicting Skill definitions for "release"');
  });
});

function sessionActivation(
  artifact: { name: string; files: Array<{ path: string; content: string }> },
  id: string,
) {
  return {
    source: "session" as const,
    id: `session:${id}`,
    artifact,
    reason: "attached to session",
  };
}

function fakeSession(files: Record<string, string>): SandboxSessionLike {
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, content]) => [normalize(path), content]),
  );
  const directories = new Set<string>([""]);
  for (const path of normalizedFiles.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return {
    state: { manifest: new Manifest({ root: "/workspace" }) },
    listDir: async ({ path }) => {
      const directory = normalize(path);
      if (!directories.has(directory))
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      const prefix = directory ? `${directory}/` : "";
      const names = new Map<string, "file" | "dir">();
      for (const candidate of directories) {
        if (!candidate.startsWith(prefix) || candidate === directory) continue;
        const remainder = candidate.slice(prefix.length);
        if (!remainder.includes("/")) names.set(remainder, "dir");
      }
      for (const candidate of normalizedFiles.keys()) {
        if (!candidate.startsWith(prefix)) continue;
        const remainder = candidate.slice(prefix.length);
        if (!remainder.includes("/")) names.set(remainder, "file");
      }
      return [...names].map(([name, type]) => ({
        name,
        type,
        path: prefix ? `${prefix}${name}` : name,
      }));
    },
    readFile: async ({ path }) => {
      const content = normalizedFiles.get(normalize(path));
      if (content === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return content;
    },
  };
}

function normalize(path: string): string {
  return path.replace(/^\/workspace\/?/, "").replace(/^\/+|\/+$/g, "");
}
