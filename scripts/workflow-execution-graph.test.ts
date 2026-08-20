import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stringify } from "yaml";
import {
  GRAPH_MANIFEST_PATH,
  canonicalJson,
  compareWorkflowExecutionManifest,
  inspectWorkflowExecutionRepository,
  inspectWorkflowExecutionSources,
  loadWorkflowExecutionSources,
  parseRestrictedYaml,
  type WorkflowExecutionGraphManifest,
} from "./workflow-execution-graph";

const root = resolve(import.meta.dir, "..");
const workflowPath = ".github/workflows/fixture.yml";
const actionPath = ".github/actions/probe/action.yml";

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
    expect(inspection.manifest.workflows).toHaveLength(20);
    expect(inspection.manifest.actions).toHaveLength(2);
    expect(inspection.manifest.uncappedRuns).toHaveLength(197);
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
      expect(inspectWorkflowExecutionSources(sources).violations.join("\n"), String(cap)).toContain(
        "job timeout-minutes must be a static integer",
      );
    }
    for (const cap of [0, -1, 1.5, 361, "12", "${{ inputs.timeout }}"]) {
      const sources = fixtureSources();
      sources[workflowPath] = replaceOnce(
        sources[workflowPath] ?? "",
        'run: "echo producer"',
        `timeout-minutes: ${JSON.stringify(cap)}\n        run: "echo producer"`,
      );
      expect(inspectWorkflowExecutionSources(sources).violations.join("\n"), String(cap)).toContain(
        "timeout-minutes must be a static integer",
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
