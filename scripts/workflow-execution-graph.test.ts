import { describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import {
  GRAPH_MANIFEST_PATH,
  WORKFLOW_GRAPH_LIMITS,
  canonicalJson,
  compareWorkflowExecutionManifest,
  inspectWorkflowExecutionGitTreeRepository,
  inspectWorkflowExecutionRepository,
  inspectWorkflowExecutionSources,
  loadWorkflowExecutionSources,
  parseRestrictedYaml,
  type WorkflowExecutionGraphManifest,
} from "./workflow-execution-graph";

const root = resolve(import.meta.dir, "..");
const workflowPath = ".github/workflows/fixture.yml";
const actionPath = ".github/actions/probe/action.yml";
const discoveryActionPath = ".github/actions/probe/action.yaml";

const minimalWorkflow = [
  "name: Fixture",
  "on: push",
  "jobs:",
  "  build:",
  "    timeout-minutes: 5",
  "    steps:",
  "      - name: Run",
  "        run: echo fixture",
  "",
].join("\n");

const minimalAction = [
  "name: Fixture action",
  "runs:",
  "  using: composite",
  "  steps:",
  "    - name: Run",
  "      shell: bash",
  "      run: echo fixture",
  "",
].join("\n");

function padAscii(source: string, bytes: number): string {
  const current = new TextEncoder().encode(source).byteLength;
  if (current > bytes) throw new Error("fixture exceeds requested byte size");
  if (current === bytes) return source;
  return `${source}#${"x".repeat(bytes - current - 1)}`;
}

function exactNodeLimitYaml(extraLeafScalars = 0): string {
  const rows = Array.from({ length: 999 }, () => `  - [${"0,".repeat(18)}0]`);
  rows.push(`  - [${"0,".repeat(14 + extraLeafScalars)}0]`);
  return `root:\n${rows.join("\n")}\n`;
}

async function createDiscoveryFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workflow-graph-discovery-"));
  await mkdir(join(directory, ".github/workflows"), { recursive: true });
  await mkdir(join(directory, ".github/actions/probe"), { recursive: true });
  await writeFile(join(directory, ".github/workflows/fixture.yml"), minimalWorkflow);
  await writeFile(join(directory, ".github/actions/probe/action.yaml"), minimalAction);
  return directory;
}

async function runFixtureGit(
  directory: string,
  args: readonly string[],
  input?: string | Uint8Array,
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdin: input === undefined ? "ignore" : new Blob([input as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`fixture Git failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function writeDiscoveryManifest(directory: string): Promise<void> {
  const inspection = await inspectWorkflowExecutionRepository(directory);
  expect(inspection.violations).toEqual([]);
  await writeFile(
    join(directory, GRAPH_MANIFEST_PATH),
    `${JSON.stringify(inspection.manifest, null, 2)}\n`,
  );
}

async function createCommittedDiscoveryFixture(): Promise<string> {
  const directory = await createDiscoveryFixture();
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeDiscoveryManifest(directory);
  await runFixtureGit(directory, ["init", "--quiet"]);
  await runFixtureGit(directory, ["config", "user.email", "workflow-graph@example.invalid"]);
  await runFixtureGit(directory, ["config", "user.name", "Workflow Graph Test"]);
  await runFixtureGit(directory, ["add", "-A"]);
  await runFixtureGit(directory, ["commit", "--quiet", "-m", "fixture"]);
  return directory;
}

async function commitFixture(directory: string, message: string): Promise<void> {
  await runFixtureGit(directory, ["add", "-A"]);
  await runFixtureGit(directory, ["commit", "--quiet", "-m", message]);
}

function gitInspectionViolations(
  result: Awaited<ReturnType<typeof inspectWorkflowExecutionGitTreeRepository>>,
): readonly string[] {
  return [...result.inspection.violations, ...result.manifestViolations];
}

function fixtureSources(): Record<string, string> {
  return {
    [workflowPath]: [
      "name: Fixture",
      "on: push",
      "jobs:",
      "  build:",
      "    timeout-minutes: 30",
      "    strategy:",
      "      matrix:",
      "        lane: [one, two]",
      "    outputs:",
      "      result: result-a",
      "    env:",
      "      SHARED: env-a",
      "    steps:",
      "      - name: Produce",
      "        id: produce",
      "        env:",
      '          VALUE: "1"',
      '        run: "echo producer"',
      "      - name: Consume",
      "        env:",
      "          RESULT: output-a",
      '        run: "echo consumer"',
      "      - name: Invoke local",
      "        uses: ./.github/actions/probe",
      "        with:",
      "          input: input-a",
      "  downstream:",
      "    timeout-minutes: 10",
      "    needs: build",
      "    steps:",
      "      - name: Downstream",
      '        run: "echo downstream"',
      "",
    ].join("\n"),
    [actionPath]: [
      "name: Probe",
      "inputs:",
      "  input:",
      "    required: true",
      "runs:",
      "  using: composite",
      "  steps:",
      "    - name: Action run",
      "      shell: bash",
      "      env:",
      "        ACTION_ENV: action-env-a",
      '      run: "echo action-a"',
      "",
    ].join("\n"),
  };
}

function replaceOnce(source: string, before: string, after: string): string {
  expect(source.split(before)).toHaveLength(2);
  return source.replace(before, () => after);
}

function workflowDigest(manifest: WorkflowExecutionGraphManifest): string {
  const record = manifest.workflows.find((candidate) => candidate.path === workflowPath);
  expect(record).toBeDefined();
  return record?.sha256 ?? "";
}

function actionDigest(manifest: WorkflowExecutionGraphManifest): string {
  const record = manifest.actions.find((candidate) => candidate.path === actionPath);
  expect(record).toBeDefined();
  return record?.sha256 ?? "";
}

describe("workflow execution graph manifest", () => {
  test("the checked-in manifest exactly describes the repository graph", async () => {
    const inspection = await inspectWorkflowExecutionRepository(root);
    const committed = JSON.parse(
      await readFile(resolve(root, GRAPH_MANIFEST_PATH), "utf8"),
    ) as unknown;

    expect(inspection.violations).toEqual([]);
    expect(compareWorkflowExecutionManifest(committed, inspection.manifest)).toEqual([]);
    expect(inspection.manifest.workflows).toHaveLength(21);
    expect(inspection.manifest.actions).toHaveLength(2);
    expect(inspection.manifest.uncappedRuns).toHaveLength(198);
    expect(inspection.manifest.generatedLocalTargets).toHaveLength(3);
    for (const record of [
      ...inspection.manifest.workflows,
      ...inspection.manifest.actions,
      ...inspection.manifest.uncappedRuns,
    ]) {
      expect(record.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("restricted YAML rejects malformed or identity-ambiguous constructs", () => {
    const rejected = [
      "a: 1\na: 2\n",
      "a: &value 1\n",
      "a: &value 1\nb: *value\n",
      "a: 1\nb:\n  <<: { c: 2 }\n",
      "a: !!str 1\n",
      "a: [\n",
    ];
    for (const source of rejected) {
      expect(() => parseRestrictedYaml(source, workflowPath)).toThrow();
    }
  });

  test("canonicalization sorts mappings while preserving sequences and scalar types", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson({ steps: ["one", "two"] })).not.toBe(
      canonicalJson({ steps: ["two", "one"] }),
    );
    expect(canonicalJson({ value: "1" })).not.toBe(canonicalJson({ value: 1 }));

    const baseline = inspectWorkflowExecutionSources(fixtureSources());
    const reordered = fixtureSources();
    reordered[workflowPath] = replaceOnce(
      reordered[workflowPath] ?? "",
      [
        "      - name: Produce",
        "        id: produce",
        "        env:",
        '          VALUE: "1"',
        '        run: "echo producer"',
        "      - name: Consume",
        "        env:",
        "          RESULT: output-a",
        '        run: "echo consumer"',
      ].join("\n"),
      [
        "      - name: Consume",
        "        env:",
        "          RESULT: output-a",
        '        run: "echo consumer"',
        "      - name: Produce",
        "        id: produce",
        "        env:",
        '          VALUE: "1"',
        '        run: "echo producer"',
      ].join("\n"),
    );
    const reorderedInspection = inspectWorkflowExecutionSources(reordered);
    expect(baseline.violations).toEqual([]);
    expect(reorderedInspection.violations).toEqual([]);
    expect(workflowDigest(reorderedInspection.manifest)).not.toBe(
      workflowDigest(baseline.manifest),
    );
  });

  test("canonical mappings preserve prototype-shaped own keys without collisions", () => {
    const parsed = parseRestrictedYaml(
      [
        "__proto__: proto-value",
        "constructor: constructor-value",
        "prototype: prototype-value",
        "toString: tostring-value",
        "ordinary: ordinary-value",
        "",
      ].join("\n"),
      workflowPath,
    );
    expect(Object.keys(parsed).sort()).toEqual([
      "__proto__",
      "constructor",
      "ordinary",
      "prototype",
      "toString",
    ]);
    const canonical = JSON.parse(canonicalJson(parsed)) as Record<string, unknown>;
    expect(Object.hasOwn(canonical, "__proto__")).toBe(true);
    expect(canonical.__proto__).toBe("proto-value");
    expect(canonical.constructor).toBe("constructor-value");
    expect(canonical.prototype).toBe("prototype-value");
    expect(canonical.toString).toBe("tostring-value");
    expect(
      new Set(
        ["__proto__", "constructor", "prototype", "toString"].map((key) =>
          canonicalJson(parseRestrictedYaml(`${key}: value\n`, workflowPath)),
        ),
      ).size,
    ).toBe(4);
  });

  test("numeric YAML accepts only injective finite safe integers", () => {
    for (const source of [
      "value: 9007199254740992\n",
      "value: 9007199254740993\n",
      "value: 999999999999999999999999999999999999\n",
      "value: 1e100\n",
      "value: 0.1\n",
      "value: 0.10000000000000001\n",
      "value: -0\n",
      "value: .nan\n",
      "value: .inf\n",
    ]) {
      expect(() => parseRestrictedYaml(source, workflowPath), source.trim()).toThrow(
        "numeric scalar outside the safe-integer domain",
      );
    }
    expect(parseRestrictedYaml("value: 9007199254740991\n", workflowPath)).toEqual({
      value: 9007199254740991,
    });
    expect(parseRestrictedYaml("value: -9007199254740991\n", workflowPath)).toEqual({
      value: -9007199254740991,
    });
    expect(parseRestrictedYaml('value: "0.10000000000000001"\n', workflowPath)).toEqual({
      value: "0.10000000000000001",
    });
    expect(() => canonicalJson({ value: 0.1 })).toThrow("safe-integer domain");
    expect(() => canonicalJson({ value: -0 })).toThrow("safe-integer domain");
  });

  test("source-count and UTF-8 byte bounds are exact and pre-parse", () => {
    const exactSource = padAscii(minimalWorkflow, WORKFLOW_GRAPH_LIMITS.maxSourceBytes);
    expect(inspectWorkflowExecutionSources({ [workflowPath]: exactSource }).violations).toEqual([]);
    expect(
      inspectWorkflowExecutionSources({ [`${workflowPath}`]: `${exactSource}x` }).violations,
    ).toContain(`${workflowPath} exceeds the per-source UTF-8 byte limit`);

    const exactCount = Object.fromEntries(
      Array.from({ length: WORKFLOW_GRAPH_LIMITS.maxSources }, (_, index) => [
        `.github/workflows/count-${index}.yml`,
        minimalWorkflow,
      ]),
    );
    expect(inspectWorkflowExecutionSources(exactCount).violations).toEqual([]);
    expect(
      inspectWorkflowExecutionSources({
        ...exactCount,
        ".github/workflows/count-overflow.yml": minimalWorkflow,
      }).violations,
    ).toContain("workflow execution graph exceeds the source-count limit");

    const totalParts = 5;
    const baseSize = Math.floor(WORKFLOW_GRAPH_LIMITS.maxTotalSourceBytes / totalParts);
    const exactTotal = Object.fromEntries(
      Array.from({ length: totalParts }, (_, index) => [
        `.github/workflows/total-${index}.yml`,
        padAscii(
          minimalWorkflow,
          baseSize +
            (index === totalParts - 1 ? WORKFLOW_GRAPH_LIMITS.maxTotalSourceBytes % totalParts : 0),
        ),
      ]),
    );
    expect(inspectWorkflowExecutionSources(exactTotal).violations).toEqual([]);
    const totalOverflow = { ...exactTotal };
    totalOverflow[".github/workflows/total-0.yml"] =
      `${totalOverflow[".github/workflows/total-0.yml"]}x`;
    expect(inspectWorkflowExecutionSources(totalOverflow).violations).toContain(
      "workflow execution graph exceeds the total UTF-8 byte limit",
    );
  });

  test("AST node, collection-width, and nesting-depth bounds are exact", () => {
    expect(() => parseRestrictedYaml(exactNodeLimitYaml(), workflowPath)).not.toThrow();
    expect(() => parseRestrictedYaml(exactNodeLimitYaml(1), workflowPath)).toThrow(
      "AST node limit",
    );

    const exactMap = `root:\n${Array.from(
      { length: WORKFLOW_GRAPH_LIMITS.maxCollectionWidth },
      (_, index) => `  key-${index}: value`,
    ).join("\n")}\n`;
    expect(() => parseRestrictedYaml(exactMap, workflowPath)).not.toThrow();
    expect(() => parseRestrictedYaml(`${exactMap}  key-overflow: value\n`, workflowPath)).toThrow(
      "collection-width limit",
    );
    const exactSequence = `root: [${Array.from(
      { length: WORKFLOW_GRAPH_LIMITS.maxCollectionWidth },
      () => "value",
    ).join(",")}]\n`;
    expect(() => parseRestrictedYaml(exactSequence, workflowPath)).not.toThrow();
    expect(() =>
      parseRestrictedYaml(
        `root: [${Array.from(
          { length: WORKFLOW_GRAPH_LIMITS.maxCollectionWidth + 1 },
          () => "value",
        ).join(",")}]\n`,
        workflowPath,
      ),
    ).toThrow("collection-width limit");

    const exactFlowDepth = WORKFLOW_GRAPH_LIMITS.maxNestingDepth - 3;
    expect(() =>
      parseRestrictedYaml(
        `root: ${"[".repeat(exactFlowDepth)}value${"]".repeat(exactFlowDepth)}\n`,
        workflowPath,
      ),
    ).not.toThrow();
    expect(() =>
      parseRestrictedYaml(
        `root: ${"[".repeat(exactFlowDepth + 1)}value${"]".repeat(exactFlowDepth + 1)}\n`,
        workflowPath,
      ),
    ).toThrow("nesting-depth limit");
    const deepBlock = `${Array.from(
      { length: WORKFLOW_GRAPH_LIMITS.maxNestingDepth },
      (_, index) => `${"  ".repeat(index)}key-${index}:`,
    ).join("\n")}\n${"  ".repeat(WORKFLOW_GRAPH_LIMITS.maxNestingDepth)}value\n`;
    expect(() => parseRestrictedYaml(deepBlock, workflowPath)).toThrow("nesting-depth limit");
  });

  test("the aggregate AST node budget fails closed across individually valid sources", () => {
    const payload = Array.from({ length: 850 }, () => `  - [${"0,".repeat(18)}0]`).join("\n");
    const source = `${minimalWorkflow}padding:\n${payload}\n`;
    expect(() => parseRestrictedYaml(source, workflowPath)).not.toThrow();
    const sources = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`.github/workflows/nodes-${index}.yml`, source]),
    );
    expect(inspectWorkflowExecutionSources(sources).violations.join("\n")).toContain(
      "total AST node limit",
    );
  });

  test("large wide input is rejected by byte bounds before YAML traversal", () => {
    const sentinel = "SECRET_WIDE_VALUE";
    const wide = `${minimalWorkflow}${Array.from(
      { length: 100_000 },
      (_, index) => `wide-${index}: ${sentinel}-${index}`,
    ).join("\n")}\n`;
    expect(new TextEncoder().encode(wide).byteLength).toBeGreaterThan(2_500_000);
    const startedAt = performance.now();
    const violations = inspectWorkflowExecutionSources({ [workflowPath]: wide }).violations;
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(violations).toContain(`${workflowPath} exceeds the per-source UTF-8 byte limit`);
    expect(violations.join("\n")).not.toContain(sentinel);
  });

  test("cross-step execution dependencies and order all invalidate the graph digest", () => {
    const baselineSources = fixtureSources();
    const baseline = inspectWorkflowExecutionSources(baselineSources);
    expect(baseline.violations).toEqual([]);

    const mutations: Array<readonly [string, (sources: Record<string, string>) => void]> = [
      [
        "producer",
        (sources) => {
          sources[workflowPath] = replaceOnce(
            sources[workflowPath] ?? "",
            "echo producer",
            "echo producer-b",
          );
        },
      ],
      [
        "environment",
        (sources) => {
          sources[workflowPath] = replaceOnce(
            sources[workflowPath] ?? "",
            'VALUE: "1"',
            'VALUE: "2"',
          );
        },
      ],
      [
        "output",
        (sources) => {
          sources[workflowPath] = replaceOnce(
            sources[workflowPath] ?? "",
            "result: result-a",
            "result: result-b",
          );
        },
      ],
      [
        "matrix",
        (sources) => {
          sources[workflowPath] = replaceOnce(
            sources[workflowPath] ?? "",
            "lane: [one, two]",
            "lane: [one, three]",
          );
        },
      ],
      [
        "input",
        (sources) => {
          sources[workflowPath] = replaceOnce(
            sources[workflowPath] ?? "",
            "input: input-a",
            "input: input-b",
          );
        },
      ],
      [
        "needs",
        (sources) => {
          sources[workflowPath] = replaceOnce(
            sources[workflowPath] ?? "",
            "needs: build",
            "needs: producer",
          );
        },
      ],
      [
        "action",
        (sources) => {
          sources[actionPath] = replaceOnce(
            sources[actionPath] ?? "",
            "echo action-a",
            "echo action-b",
          );
        },
      ],
      [
        "order",
        (sources) => {
          sources[workflowPath] = replaceOnce(
            sources[workflowPath] ?? "",
            "      - name: Produce\n        id: produce",
            "      - name: Produce after mutation\n        id: produce",
          );
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const sources = fixtureSources();
      mutate(sources);
      const current = inspectWorkflowExecutionSources(sources);
      expect(current.violations, label).toEqual([]);
      expect(workflowDigest(current.manifest), label).not.toBe(workflowDigest(baseline.manifest));
      expect(
        compareWorkflowExecutionManifest(baseline.manifest, current.manifest),
        label,
      ).not.toEqual([]);
      if (label === "action") {
        expect(actionDigest(current.manifest)).not.toBe(actionDigest(baseline.manifest));
      }
    }
  });

  test("local targets must be present, unambiguous, bounded, and acyclic", () => {
    const missing = fixtureSources();
    delete missing[actionPath];
    expect(inspectWorkflowExecutionSources(missing).violations).toContain(
      `${workflowPath}:build:Invoke local has a missing local action target`,
    );

    const ambiguous = fixtureSources();
    ambiguous[".github/actions/probe/action.yaml"] = ambiguous[actionPath] ?? "";
    expect(inspectWorkflowExecutionSources(ambiguous).violations).toContain(
      `${workflowPath}:build:Invoke local has a ambiguous local action target`,
    );

    for (const target of ["../probe", "/absolute/probe"]) {
      const escaped = fixtureSources();
      escaped[workflowPath] = replaceOnce(
        escaped[workflowPath] ?? "",
        "./.github/actions/probe",
        target,
      );
      expect(inspectWorkflowExecutionSources(escaped).violations.join("\n"), target).toContain(
        "path-escaping local target",
      );
    }

    const missingWorkflow = fixtureSources();
    missingWorkflow[workflowPath] = [
      "name: Fixture",
      "on: push",
      "jobs:",
      "  call:",
      "    uses: ./.github/workflows/missing.yml",
      "",
    ].join("\n");
    expect(inspectWorkflowExecutionSources(missingWorkflow).violations).toContain(
      `${workflowPath}:call:reusable-workflow has a missing local workflow target`,
    );

    const cyclic = fixtureSources();
    cyclic[actionPath] = replaceOnce(
      cyclic[actionPath] ?? "",
      "      shell: bash\n      env:",
      "      uses: ./.github/actions/probe\n      env:",
    );
    expect(inspectWorkflowExecutionSources(cyclic).violations.join("\n")).toContain(
      "participates in a local workflow/action target cycle",
    );
  });

  test("filesystem discovery rejects action and workflow symlinks before inventory", async () => {
    const dual = await createDiscoveryFixture();
    try {
      await writeFile(join(dual, ".github/actions/probe/payload.txt"), minimalAction);
      await symlink("payload.txt", join(dual, ".github/actions/probe/action.yml"));
      await expect(loadWorkflowExecutionSources(dual)).rejects.toThrow(
        ".github/actions/probe/action.yml is a forbidden symlink in action discovery",
      );
    } finally {
      await rm(dual, { recursive: true, force: true });
    }

    const symlinkOnly = await createDiscoveryFixture();
    try {
      await rm(join(symlinkOnly, ".github/actions/probe/action.yaml"));
      await writeFile(join(symlinkOnly, ".github/actions/probe/payload.txt"), minimalAction);
      await symlink("payload.txt", join(symlinkOnly, ".github/actions/probe/action.yml"));
      await expect(loadWorkflowExecutionSources(symlinkOnly)).rejects.toThrow(
        "forbidden symlink in action discovery",
      );
    } finally {
      await rm(symlinkOnly, { recursive: true, force: true });
    }

    const directoryEscape = await createDiscoveryFixture();
    try {
      await mkdir(join(directoryEscape, "outside"));
      await writeFile(join(directoryEscape, "outside/action.yml"), minimalAction);
      await symlink("../../outside", join(directoryEscape, ".github/actions/escape"));
      await expect(loadWorkflowExecutionSources(directoryEscape)).rejects.toThrow(
        ".github/actions/escape is a forbidden symlink in action discovery",
      );
    } finally {
      await rm(directoryEscape, { recursive: true, force: true });
    }

    const workflowLink = await createDiscoveryFixture();
    try {
      await rm(join(workflowLink, ".github/workflows/fixture.yml"));
      await writeFile(join(workflowLink, "workflow-payload.yml"), minimalWorkflow);
      await symlink(
        "../../workflow-payload.yml",
        join(workflowLink, ".github/workflows/fixture.yml"),
      );
      await expect(loadWorkflowExecutionSources(workflowLink)).rejects.toThrow(
        ".github/workflows/fixture.yml is a forbidden symlink in workflow discovery",
      );
    } finally {
      await rm(workflowLink, { recursive: true, force: true });
    }
  });

  test("filesystem discovery entry bounds accept the exact boundary and reject one more", async () => {
    const directory = await createDiscoveryFixture();
    try {
      const actionFillers = WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryEntries - 2;
      await Promise.all(
        Array.from({ length: actionFillers }, (_, index) =>
          writeFile(join(directory, `.github/actions/filler-${index}.txt`), ""),
        ),
      );
      await expect(loadWorkflowExecutionSources(directory)).resolves.toBeDefined();
      await writeFile(join(directory, ".github/actions/action-overflow.txt"), "");
      await expect(loadWorkflowExecutionSources(directory)).rejects.toThrow(
        "action discovery exceeds the directory-entry limit",
      );
      await rm(join(directory, ".github/actions/action-overflow.txt"));

      const workflowFillers = WORKFLOW_GRAPH_LIMITS.maxWorkflowDiscoveryEntries - 1;
      await Promise.all(
        Array.from({ length: workflowFillers }, (_, index) =>
          writeFile(join(directory, `.github/workflows/filler-${index}.txt`), ""),
        ),
      );
      await expect(loadWorkflowExecutionSources(directory)).resolves.toBeDefined();
      await writeFile(join(directory, ".github/workflows/workflow-overflow.txt"), "");
      await expect(loadWorkflowExecutionSources(directory)).rejects.toThrow(
        "workflow discovery exceeds the directory-entry limit",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const depthDirectory = await createDiscoveryFixture();
    try {
      let nested = join(depthDirectory, ".github/actions");
      for (let index = 0; index < WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryDepth; index += 1) {
        nested = join(nested, `depth-${index}`);
        await mkdir(nested);
      }
      await writeFile(join(nested, "action.yml"), minimalAction);
      await expect(loadWorkflowExecutionSources(depthDirectory)).resolves.toBeDefined();
      await mkdir(join(nested, "overflow"));
      await expect(loadWorkflowExecutionSources(depthDirectory)).rejects.toThrow(
        "action discovery exceeds the directory-depth limit",
      );
    } finally {
      await rm(depthDirectory, { recursive: true, force: true });
    }
  });

  test("streaming discovery stops at the first over-limit action entry", async () => {
    const directory = await createDiscoveryFixture();
    try {
      await Promise.all(
        Array.from({ length: WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryEntries + 100 }, (_, index) =>
          writeFile(join(directory, `.github/actions/stream-${index}.txt`), ""),
        ),
      );
      let observedActionEntries = 0;
      const closedDirectories: string[] = [];
      await expect(
        loadWorkflowExecutionSources(directory, {
          onDiscoveryEntry(kind) {
            if (kind === "action") observedActionEntries += 1;
          },
          onDirectoryHandleClosed(kind, path) {
            closedDirectories.push(`${kind}:${path}`);
          },
        }),
      ).rejects.toThrow("action discovery exceeds the directory-entry limit");
      expect(observedActionEntries).toBe(WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryEntries + 1);
      expect(closedDirectories).toContain("workflow:.github/workflows");
      expect(closedDirectories).toContain("action:.github/actions");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("filesystem byte preflight rejects per-file and total overflow before reads", async () => {
    const oversized = await createDiscoveryFixture();
    try {
      await writeFile(
        join(oversized, ".github/workflows/fixture.yml"),
        new Uint8Array(WORKFLOW_GRAPH_LIMITS.maxSourceBytes + 1),
      );
      let reads = 0;
      const closed: string[] = [];
      await expect(
        loadWorkflowExecutionSources(oversized, {
          beforeRead() {
            reads += 1;
          },
          onFileHandleClosed(path) {
            closed.push(path);
          },
        }),
      ).rejects.toThrow("exceeds the per-source UTF-8 byte limit");
      expect(reads).toBe(0);
      expect(closed).toEqual([discoveryActionPath]);
    } finally {
      await rm(oversized, { recursive: true, force: true });
    }

    const totalOverflow = await createDiscoveryFixture();
    try {
      const sourceBytes = 220 * 1024;
      for (let index = 0; index < 5; index += 1) {
        await writeFile(
          join(totalOverflow, `.github/workflows/large-${index}.yml`),
          new Uint8Array(sourceBytes),
        );
      }
      let reads = 0;
      const closed: string[] = [];
      await expect(
        loadWorkflowExecutionSources(totalOverflow, {
          beforeRead() {
            reads += 1;
          },
          onFileHandleClosed(path) {
            closed.push(path);
          },
        }),
      ).rejects.toThrow("exceeds the total UTF-8 byte limit");
      expect(reads).toBe(0);
      expect(closed.sort()).toEqual(
        [
          discoveryActionPath,
          workflowPath,
          ...Array.from({ length: 5 }, (_, index) => `.github/workflows/large-${index}.yml`),
        ].sort(),
      );
    } finally {
      await rm(totalOverflow, { recursive: true, force: true });
    }
  });

  test("filesystem loader rejects malformed UTF-8 without disclosing bytes", async () => {
    const errors: string[] = [];
    for (const malformedByte of [0x80, 0x81]) {
      const directory = await createDiscoveryFixture();
      try {
        await writeFile(
          join(directory, ".github/workflows/fixture.yml"),
          Uint8Array.of(malformedByte),
        );
        let error: unknown;
        try {
          await loadWorkflowExecutionSources(directory);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toBe(`${workflowPath} contains invalid UTF-8`);
        expect(message).not.toContain(String(malformedByte));
        errors.push(message);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    expect(new Set(errors)).toEqual(new Set([`${workflowPath} contains invalid UTF-8`]));
  });

  test("filesystem loader bounds shrink, growth, and replacement races and closes handles", async () => {
    const mutations = [
      {
        name: "shrink",
        mutate: (path: string) => truncate(path, 1),
        expected: "changed size while reading graph source",
      },
      {
        name: "growth",
        mutate: (path: string) => appendFile(path, "x"),
        expected: "changed size while reading graph source",
      },
      {
        name: "replacement",
        mutate: async (path: string) => {
          await rename(path, `${path}.replaced`);
          await writeFile(path, minimalWorkflow);
        },
        expected: "changed while reading graph source",
      },
    ] as const;

    for (const mutation of mutations) {
      const directory = await createDiscoveryFixture();
      const closed: string[] = [];
      try {
        await expect(
          loadWorkflowExecutionSources(directory, {
            async afterPreflight() {
              await mutation.mutate(join(directory, ".github/workflows/fixture.yml"));
            },
            onFileHandleClosed(path) {
              closed.push(path);
            },
          }),
          mutation.name,
        ).rejects.toThrow(mutation.expected);
        expect(closed.sort(), mutation.name).toEqual([discoveryActionPath, workflowPath].sort());
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("Git-tree mode captures one immutable snapshot despite hostile worktree replacement", async () => {
    const directory = await createCommittedDiscoveryFixture();
    const outside = await mkdtemp(join(tmpdir(), "workflow-graph-outside-"));
    try {
      const committedWorkflow = await readFile(
        join(directory, ".github/workflows/fixture.yml"),
        "utf8",
      );
      await mkdir(join(outside, "workflows"), { recursive: true });
      await mkdir(join(outside, "action"), { recursive: true });
      await writeFile(join(outside, "workflows/fixture.yml"), `${minimalWorkflow}# outside\n`);
      await writeFile(join(outside, "action/action.yaml"), `${minimalAction}# outside\n`);

      const checked = await inspectWorkflowExecutionGitTreeRepository(directory, "HEAD^{tree}", {
        async afterTreeCapture() {
          await rm(join(directory, ".github/workflows"), { recursive: true, force: true });
          await rm(join(directory, ".github/actions/probe"), { recursive: true, force: true });
          await symlink(join(outside, "workflows"), join(directory, ".github/workflows"), "dir");
          await symlink(join(outside, "action"), join(directory, ".github/actions/probe"), "dir");
          await writeFile(join(directory, GRAPH_MANIFEST_PATH), "{}\n");
          await commitFixture(directory, "move HEAD after tree capture");
        },
      });
      expect(gitInspectionViolations(checked)).toEqual([]);
      expect(checked.inspection.manifest.workflows).toHaveLength(1);
      expect(checked.inspection.manifest.actions).toHaveLength(1);
      expect(committedWorkflow).toBe(minimalWorkflow);
      await expect(loadWorkflowExecutionSources(directory)).rejects.toThrow(
        "workflow discovery root must be a regular directory",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("Git-tree mode ignores replacement refs for inventories, blobs, and the manifest", async () => {
    const directory = await createCommittedDiscoveryFixture();
    try {
      const originalTree = await runFixtureGit(directory, ["rev-parse", "HEAD^{tree}"]);
      const originalWorkflow = await runFixtureGit(directory, [
        "rev-parse",
        `${originalTree}:${workflowPath}`,
      ]);
      const originalAction = await runFixtureGit(directory, [
        "rev-parse",
        `${originalTree}:${discoveryActionPath}`,
      ]);
      const originalManifest = await runFixtureGit(directory, [
        "rev-parse",
        `${originalTree}:${GRAPH_MANIFEST_PATH}`,
      ]);
      const expected = await inspectWorkflowExecutionGitTreeRepository(directory, originalTree);
      expect(gitInspectionViolations(expected)).toEqual([]);

      await writeFile(
        join(directory, workflowPath),
        minimalWorkflow.replace("echo fixture", "echo replacement-workflow"),
      );
      await writeFile(
        join(directory, discoveryActionPath),
        minimalAction.replace("echo fixture", "echo replacement-action"),
      );
      await writeDiscoveryManifest(directory);
      await commitFixture(directory, "replacement graph");

      const replacementTree = await runFixtureGit(directory, ["rev-parse", "HEAD^{tree}"]);
      const replacementWorkflow = await runFixtureGit(directory, [
        "rev-parse",
        `${replacementTree}:${workflowPath}`,
      ]);
      const replacementAction = await runFixtureGit(directory, [
        "rev-parse",
        `${replacementTree}:${discoveryActionPath}`,
      ]);
      const replacementManifest = await runFixtureGit(directory, [
        "rev-parse",
        `${replacementTree}:${GRAPH_MANIFEST_PATH}`,
      ]);

      for (const [original, replacement] of [
        [originalWorkflow, replacementWorkflow],
        [originalAction, replacementAction],
        [originalManifest, replacementManifest],
      ]) {
        await runFixtureGit(directory, ["replace", original, replacement]);
      }
      expect(await runFixtureGit(directory, ["show", `${originalTree}:${workflowPath}`])).toContain(
        "replacement-workflow",
      );
      const blobProtected = await inspectWorkflowExecutionGitTreeRepository(
        directory,
        originalTree,
      );
      expect(gitInspectionViolations(blobProtected)).toEqual([]);
      expect(blobProtected.inspection.manifest).toEqual(expected.inspection.manifest);

      await runFixtureGit(directory, [
        "replace",
        "-d",
        originalWorkflow,
        originalAction,
        originalManifest,
      ]);
      await runFixtureGit(directory, ["replace", originalTree, replacementTree]);
      expect(await runFixtureGit(directory, ["show", `${originalTree}:${workflowPath}`])).toContain(
        "replacement-workflow",
      );
      const treeProtected = await inspectWorkflowExecutionGitTreeRepository(
        directory,
        originalTree,
      );
      expect(gitInspectionViolations(treeProtected)).toEqual([]);
      expect(treeProtected.inspection.manifest).toEqual(expected.inspection.manifest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Git-tree mode ignores dirty state while local mode detects add, edit, delete, and rename", async () => {
    const mutations = [
      async (directory: string) => {
        await writeFile(join(directory, ".github/workflows/added.yml"), minimalWorkflow);
      },
      async (directory: string) => {
        await writeFile(
          join(directory, ".github/workflows/fixture.yml"),
          minimalWorkflow.replace("echo fixture", "echo edited"),
        );
      },
      async (directory: string) => {
        await rm(join(directory, ".github/workflows/fixture.yml"));
      },
      async (directory: string) => {
        await rename(
          join(directory, ".github/workflows/fixture.yml"),
          join(directory, ".github/workflows/renamed.yml"),
        );
      },
    ] as const;

    for (const [index, mutate] of mutations.entries()) {
      const directory = await createCommittedDiscoveryFixture();
      try {
        const committed = JSON.parse(
          await readFile(join(directory, GRAPH_MANIFEST_PATH), "utf8"),
        ) as unknown;
        await mutate(directory);
        expect(await runFixtureGit(directory, ["status", "--porcelain"]), String(index)).not.toBe(
          "",
        );
        const local = await inspectWorkflowExecutionRepository(directory);
        expect(
          [...local.violations, ...compareWorkflowExecutionManifest(committed, local.manifest)],
          String(index),
        ).not.toEqual([]);
        const gitTree = await inspectWorkflowExecutionGitTreeRepository(directory, "HEAD^{tree}");
        expect(gitInspectionViolations(gitTree), String(index)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("Git-tree inventory rejects symlink, non-blob, and dual action definitions", async () => {
    const symlinkDirectory = await createCommittedDiscoveryFixture();
    try {
      const action = join(symlinkDirectory, ".github/actions/probe/action.yaml");
      await rm(action);
      await writeFile(join(symlinkDirectory, ".github/actions/probe/payload.txt"), minimalAction);
      await symlink("payload.txt", action);
      await commitFixture(symlinkDirectory, "symlink action");
      await expect(
        inspectWorkflowExecutionGitTreeRepository(symlinkDirectory, "HEAD^{tree}"),
      ).rejects.toThrow("forbidden symlink in the Git tree");
    } finally {
      await rm(symlinkDirectory, { recursive: true, force: true });
    }

    const nonBlobDirectory = await createCommittedDiscoveryFixture();
    try {
      const head = await runFixtureGit(nonBlobDirectory, ["rev-parse", "HEAD"]);
      await rm(join(nonBlobDirectory, ".github/workflows/fixture.yml"));
      await runFixtureGit(nonBlobDirectory, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},.github/workflows/fixture.yml`,
      ]);
      await runFixtureGit(nonBlobDirectory, ["commit", "--quiet", "-m", "gitlink workflow"]);
      await expect(
        inspectWorkflowExecutionGitTreeRepository(nonBlobDirectory, "HEAD^{tree}"),
      ).rejects.toThrow("is not a regular Git blob");
    } finally {
      await rm(nonBlobDirectory, { recursive: true, force: true });
    }

    const dualDirectory = await createCommittedDiscoveryFixture();
    try {
      await writeFile(join(dualDirectory, ".github/actions/probe/action.yml"), minimalAction);
      await commitFixture(dualDirectory, "dual action manifests");
      await expect(
        inspectWorkflowExecutionGitTreeRepository(dualDirectory, "HEAD^{tree}"),
      ).rejects.toThrow("ambiguous action definitions");
    } finally {
      await rm(dualDirectory, { recursive: true, force: true });
    }
  });

  test("Git-tree manifest comparison is bound to the same committed tree", async () => {
    const directory = await createCommittedDiscoveryFixture();
    try {
      const priorManifest = await readFile(join(directory, GRAPH_MANIFEST_PATH), "utf8");
      await writeFile(
        join(directory, ".github/workflows/fixture.yml"),
        minimalWorkflow.replace("echo fixture", "echo committed-change"),
      );
      await writeDiscoveryManifest(directory);
      await writeFile(join(directory, GRAPH_MANIFEST_PATH), priorManifest);
      await commitFixture(directory, "stale same-tree manifest");
      const checked = await inspectWorkflowExecutionGitTreeRepository(directory, "HEAD^{tree}");
      expect(checked.inspection.violations).toEqual([]);
      expect(checked.manifestViolations).toContain(
        "workflow digest changed for .github/workflows/fixture.yml",
      );
      await writeFile(join(directory, GRAPH_MANIFEST_PATH), "{}\n");
      const repeated = await inspectWorkflowExecutionGitTreeRepository(directory, "HEAD^{tree}");
      expect(repeated.manifestViolations).toEqual(checked.manifestViolations);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Git-tree blob preflight rejects byte limits before every content read", async () => {
    const oversized = await createCommittedDiscoveryFixture();
    try {
      await writeFile(
        join(oversized, ".github/workflows/fixture.yml"),
        new Uint8Array(WORKFLOW_GRAPH_LIMITS.maxSourceBytes + 1),
      );
      await commitFixture(oversized, "oversized workflow");
      let reads = 0;
      await expect(
        inspectWorkflowExecutionGitTreeRepository(oversized, "HEAD^{tree}", {
          beforeBlobRead() {
            reads += 1;
          },
        }),
      ).rejects.toThrow("exceeds the per-source UTF-8 byte limit");
      expect(reads).toBe(0);
    } finally {
      await rm(oversized, { recursive: true, force: true });
    }

    const aggregate = await createCommittedDiscoveryFixture();
    try {
      for (let index = 0; index < 4; index += 1) {
        await writeFile(
          join(aggregate, `.github/workflows/large-${index}.yml`),
          padAscii(minimalWorkflow, WORKFLOW_GRAPH_LIMITS.maxSourceBytes),
        );
      }
      await commitFixture(aggregate, "aggregate overflow");
      let reads = 0;
      await expect(
        inspectWorkflowExecutionGitTreeRepository(aggregate, "HEAD^{tree}", {
          beforeBlobRead() {
            reads += 1;
          },
        }),
      ).rejects.toThrow("exceeds the total UTF-8 byte limit");
      expect(reads).toBe(0);
    } finally {
      await rm(aggregate, { recursive: true, force: true });
    }
  });

  test("Git-tree mode fatally rejects invalid content and path UTF-8 without disclosure", async () => {
    const invalidContent = await createCommittedDiscoveryFixture();
    try {
      await writeFile(
        join(invalidContent, ".github/workflows/fixture.yml"),
        Uint8Array.of(0x80, 0x81),
      );
      await commitFixture(invalidContent, "invalid content utf8");
      await expect(
        inspectWorkflowExecutionGitTreeRepository(invalidContent, "HEAD^{tree}"),
      ).rejects.toThrow(`${workflowPath} contains invalid UTF-8`);
    } finally {
      await rm(invalidContent, { recursive: true, force: true });
    }

    const invalidPath = await createCommittedDiscoveryFixture();
    try {
      const workflowBlob = await runFixtureGit(invalidPath, [
        "rev-parse",
        "HEAD:.github/workflows/fixture.yml",
      ]);
      const actionsTree = await runFixtureGit(invalidPath, ["rev-parse", "HEAD:.github/actions"]);
      const scriptsTree = await runFixtureGit(invalidPath, ["rev-parse", "HEAD:scripts"]);
      const workflowTree = await runFixtureGit(
        invalidPath,
        ["mktree", "-z"],
        Buffer.concat([
          Buffer.from(`100644 blob ${workflowBlob}\tfixture.yml\0`),
          Buffer.from(`100644 blob ${workflowBlob}\tinvalid-`),
          Buffer.from([0x80]),
          Buffer.from(".yml\0"),
        ]),
      );
      const githubTree = await runFixtureGit(
        invalidPath,
        ["mktree", "-z"],
        [`040000 tree ${actionsTree}\tactions\0`, `040000 tree ${workflowTree}\tworkflows\0`].join(
          "",
        ),
      );
      const rootTree = await runFixtureGit(
        invalidPath,
        ["mktree", "-z"],
        [`040000 tree ${githubTree}\t.github\0`, `040000 tree ${scriptsTree}\tscripts\0`].join(""),
      );
      await expect(
        inspectWorkflowExecutionGitTreeRepository(invalidPath, rootTree),
      ).rejects.toThrow("Git tree path contains invalid UTF-8");
    } finally {
      await rm(invalidPath, { recursive: true, force: true });
    }
  });

  test("Git-tree discovery enforces path, entry, source, and depth bounds", async () => {
    const invalidPath = await createCommittedDiscoveryFixture();
    try {
      await writeFile(join(invalidPath, ".github/workflows/control\nname.yml"), minimalWorkflow);
      await commitFixture(invalidPath, "control path");
      await expect(
        inspectWorkflowExecutionGitTreeRepository(invalidPath, "HEAD^{tree}"),
      ).rejects.toThrow("contains an invalid path");
    } finally {
      await rm(invalidPath, { recursive: true, force: true });
    }

    const entryOverflow = await createCommittedDiscoveryFixture();
    try {
      await Promise.all(
        Array.from({ length: WORKFLOW_GRAPH_LIMITS.maxWorkflowDiscoveryEntries }, (_, index) =>
          writeFile(join(entryOverflow, `.github/workflows/filler-${index}.txt`), ""),
        ),
      );
      await commitFixture(entryOverflow, "workflow entry overflow");
      await expect(
        inspectWorkflowExecutionGitTreeRepository(entryOverflow, "HEAD^{tree}"),
      ).rejects.toThrow("workflow Git tree discovery exceeds the directory-entry limit");
    } finally {
      await rm(entryOverflow, { recursive: true, force: true });
    }

    const sourceOverflow = await createCommittedDiscoveryFixture();
    try {
      await Promise.all(
        Array.from({ length: WORKFLOW_GRAPH_LIMITS.maxSources - 1 }, (_, index) =>
          writeFile(join(sourceOverflow, `.github/workflows/source-${index}.yml`), minimalWorkflow),
        ),
      );
      await commitFixture(sourceOverflow, "source overflow");
      await expect(
        inspectWorkflowExecutionGitTreeRepository(sourceOverflow, "HEAD^{tree}"),
      ).rejects.toThrow("exceeds the source-count limit in the Git tree");
    } finally {
      await rm(sourceOverflow, { recursive: true, force: true });
    }

    const depthOverflow = await createCommittedDiscoveryFixture();
    try {
      let nested = join(depthOverflow, ".github/actions");
      for (let index = 0; index <= WORKFLOW_GRAPH_LIMITS.maxActionDiscoveryDepth; index += 1) {
        nested = join(nested, `depth-${index}`);
      }
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "action.yml"), minimalAction);
      await commitFixture(depthOverflow, "action depth overflow");
      await expect(
        inspectWorkflowExecutionGitTreeRepository(depthOverflow, "HEAD^{tree}"),
      ).rejects.toThrow("action Git tree discovery exceeds the directory-depth limit");
    } finally {
      await rm(depthOverflow, { recursive: true, force: true });
    }
  });

  test("former shell-assembly probes are ordinary source changes, never interpreted", () => {
    const probes = [
      String.raw`cat <<EOF\n$(timeout 10h job)\nEOF`,
      String.raw`echo "$(timeout 10h job)"`,
      String.raw`VALUE="$(timeout 10h job)"`,
      String.raw`consume "$(timeout 10h job)"`,
      String.raw`eval 'timeout 10h job'`,
      String.raw`time""out 10h job`,
      String.raw`ti\meout 10h job`,
      "time\\\nout 10h job",
      String.raw`bun test --time""out 720000`,
      String.raw`cmd=timeout; "$cmd" 10h job`,
      String.raw`gtimeout 10h job`,
      "time$''out 10h job",
      "time$'\\x6f'ut 10h job",
      "$'time\\x6fut' 10h job",
      "EMPTY=; time${EMPTY}out 10h job",
      String.raw`cmd=time; cmd+=out; "$cmd" 10h job`,
      String.raw`time$(printf "")out 10h job`,
      "ti$''me$''out 10h job",
      "ti${A}me${B}out 10h job",
      "$'\\x74\\x69\\x6d\\x65\\x6f\\x75\\x74' 10h job",
      "t$'\\x69'm$'\\x65'o$'\\x75't 10h job",
      String.raw`cmd=t; cmd+=i; cmd+=m; cmd+=e; cmd+=o; cmd+=u; cmd+=t; "$cmd" 10h job`,
      "gti${A}me${B}out 10h job",
      "--ti${A}me${B}out-seconds 10",
    ];
    const baselineSources = fixtureSources();
    const baseline = inspectWorkflowExecutionSources(baselineSources);

    for (const [index, probe] of probes.entries()) {
      const sources = fixtureSources();
      sources[workflowPath] = replaceOnce(
        sources[workflowPath] ?? "",
        'run: "echo producer"',
        `run: ${JSON.stringify(probe)}`,
      );
      const current = inspectWorkflowExecutionSources(sources);
      expect(current.violations, `probe ${index}`).toEqual([]);
      expect(workflowDigest(current.manifest), `probe ${index}`).not.toBe(
        workflowDigest(baseline.manifest),
      );
      expect(current.manifest.uncappedRuns).toHaveLength(baseline.manifest.uncappedRuns.length);
    }
  });

  test("manifest identity, staleness, cap mutations, and invalid caps fail closed", () => {
    const baselineSources = fixtureSources();
    const baseline = inspectWorkflowExecutionSources(baselineSources);
    expect(baseline.violations).toEqual([]);

    const changedPath = {
      ...baseline.manifest,
      workflows: baseline.manifest.workflows.map((row, index) =>
        index === 0 ? { ...row, path: ".github/workflows/renamed.yml" } : row,
      ),
    };
    expect(compareWorkflowExecutionManifest(changedPath, baseline.manifest)).not.toEqual([]);

    const changedDigest = {
      ...baseline.manifest,
      workflows: baseline.manifest.workflows.map((row, index) =>
        index === 0 ? { ...row, sha256: "0".repeat(64) } : row,
      ),
    };
    expect(compareWorkflowExecutionManifest(changedDigest, baseline.manifest)).not.toEqual([]);

    const duplicate = {
      ...baseline.manifest,
      uncappedRuns: [...baseline.manifest.uncappedRuns, baseline.manifest.uncappedRuns[0]!],
    };
    expect(compareWorkflowExecutionManifest(duplicate, baseline.manifest).join("\n")).toContain(
      "duplicates uncapped run",
    );

    const malformed = { ...structuredClone(baseline.manifest), unexpected: true };
    expect(compareWorkflowExecutionManifest(malformed, baseline.manifest)).toEqual([
      "workflow execution manifest has an invalid shape",
    ]);

    for (const cap of [0, -1, 1.5, 121, "30", "${{ matrix.timeout }}"]) {
      const sources = fixtureSources();
      sources[workflowPath] = replaceOnce(
        sources[workflowPath] ?? "",
        "timeout-minutes: 30",
        `timeout-minutes: ${JSON.stringify(cap)}`,
      );
      expect(inspectWorkflowExecutionSources(sources).violations.join("\n"), String(cap)).toMatch(
        /job timeout-minutes must be a static integer|numeric scalar outside the safe-integer domain/u,
      );
    }
    for (const cap of [0, -1, 1.5, 361, "12", "${{ inputs.timeout }}"]) {
      const sources = fixtureSources();
      sources[workflowPath] = replaceOnce(
        sources[workflowPath] ?? "",
        'run: "echo producer"',
        `timeout-minutes: ${JSON.stringify(cap)}\n        run: "echo producer"`,
      );
      expect(inspectWorkflowExecutionSources(sources).violations.join("\n"), String(cap)).toMatch(
        /timeout-minutes must be a static integer|numeric scalar outside the safe-integer domain/u,
      );
    }

    const capped = fixtureSources();
    capped[workflowPath] = replaceOnce(
      capped[workflowPath] ?? "",
      'run: "echo producer"',
      'timeout-minutes: 12\n        run: "echo producer"',
    );
    const cappedInspection = inspectWorkflowExecutionSources(capped);
    expect(cappedInspection.violations).toEqual([]);
    expect(cappedInspection.manifest.uncappedRuns).toHaveLength(
      baseline.manifest.uncappedRuns.length - 1,
    );
    expect(
      compareWorkflowExecutionManifest(baseline.manifest, cappedInspection.manifest),
    ).not.toEqual([]);
    expect(
      compareWorkflowExecutionManifest(cappedInspection.manifest, baseline.manifest),
    ).not.toEqual([]);
  });

  test("removing any one of the 16 approved caps invalidates the committed graph", async () => {
    type MutableStep = { "timeout-minutes"?: unknown; run?: unknown; uses?: unknown };
    type MutableWorkflow = { jobs?: Record<string, { steps?: MutableStep[] }> };
    const sources = await loadWorkflowExecutionSources(root);
    const committed = JSON.parse(
      await readFile(resolve(root, GRAPH_MANIFEST_PATH), "utf8"),
    ) as unknown;
    const capped: Array<readonly [string, number, number]> = [];
    for (const [path, source] of Object.entries(sources)) {
      if (!path.startsWith(".github/workflows/")) continue;
      const workflow = Bun.YAML.parse(source) as MutableWorkflow;
      for (const [jobIndex, job] of Object.values(workflow.jobs ?? {}).entries()) {
        for (const [stepIndex, step] of (job.steps ?? []).entries()) {
          if (step["timeout-minutes"] !== undefined) capped.push([path, jobIndex, stepIndex]);
        }
      }
    }
    expect(capped).toHaveLength(16);

    for (const [path, jobIndex, stepIndex] of capped) {
      const mutatedSources = { ...sources };
      const workflow = Bun.YAML.parse(mutatedSources[path] ?? "") as MutableWorkflow;
      const job = Object.values(workflow.jobs ?? {})[jobIndex];
      const step = job?.steps?.[stepIndex];
      expect(step).toBeDefined();
      delete step?.["timeout-minutes"];
      mutatedSources[path] = stringify(workflow);
      const inspection = inspectWorkflowExecutionSources(mutatedSources);
      expect(inspection.violations, `${path}:${jobIndex}:${stepIndex}`).toEqual([]);
      expect(
        compareWorkflowExecutionManifest(committed, inspection.manifest),
        `${path}:${jobIndex}:${stepIndex}`,
      ).not.toEqual([]);
    }
  });

  test("diagnostics disclose identities but never command or environment content", () => {
    const sentinelCommand = "SECRET_COMMAND_SENTINEL";
    const sentinelEnvironment = "SECRET_ENV_SENTINEL";
    const sources = fixtureSources();
    sources[workflowPath] = replaceOnce(
      sources[workflowPath] ?? "",
      "echo producer",
      sentinelCommand,
    );
    sources[workflowPath] = replaceOnce(sources[workflowPath] ?? "", "env-a", sentinelEnvironment);
    const current = inspectWorkflowExecutionSources(sources);
    const baseline = inspectWorkflowExecutionSources(fixtureSources());
    const diagnostics = compareWorkflowExecutionManifest(baseline.manifest, current.manifest).join(
      "\n",
    );

    expect(diagnostics).toContain(workflowPath);
    expect(diagnostics).not.toContain(sentinelCommand);
    expect(diagnostics).not.toContain(sentinelEnvironment);
  });
});
