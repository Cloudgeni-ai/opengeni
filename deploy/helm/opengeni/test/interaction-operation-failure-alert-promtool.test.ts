import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

type Input = { series: string; values: string };
const scope = { namespace: "fixture", release: "fixture", environment: "production" };

test("interaction failure alert ignores websites that fail but keeps Opengeni's own failures", async () => {
  const [helm, promtool] = await Promise.all([testTool("helm"), testTool("promtool")]);
  const manifest = Bun.YAML.parse(
    execFileSync(
      helm,
      [
        "template",
        "fixture",
        resolve(import.meta.dir, ".."),
        "--namespace",
        "fixture",
        "--api-versions",
        "monitoring.coreos.com/v1",
        "--set",
        "observability.prometheusRule.enabled=true",
        "--show-only",
        "templates/prometheusrule.yaml",
      ],
      { encoding: "utf8" },
    ),
  ) as any;
  const rule = manifest.spec.groups
    .flatMap((group: any) => group.rules)
    .find((item: any) => item.alert === "OpenGeniInteractionOperationFailureRatio");
  expect(rule).toBeDefined();
  // Counters that grow by `perMinute` every minute from zero.
  const operations = (
    outcome: string,
    reason: string,
    perMinute: number,
    operation = "act",
    mode = "semantic",
  ): Input => ({
    series: `opengeni_interaction_operations_total{namespace="fixture",release="fixture",environment="production",component="api",resource="browser",operation="${operation}",mode="${mode}",outcome="${outcome}",reason="${reason}"}`,
    values: `0+${perMinute}x60`,
  });
  const cases: any[] = [];
  function scenario(name: string, inputs: Input[], fires: number | false, operation = "act"): void {
    const labels = { resource: "browser", operation };
    cases.push({
      name,
      interval: "1m",
      input_series: inputs,
      alert_rule_test: [
        {
          eval_time: "40m",
          alertname: rule.alert,
          exp_alerts:
            fires === false
              ? []
              : [
                  {
                    exp_labels: { ...scope, ...rule.labels, ...labels },
                    exp_annotations: expandAlertAnnotations(rule.annotations, {
                      value: fires,
                      labels,
                    }),
                  },
                ],
        },
      ],
    });
  }

  // An agent retrying a website whose server never answers: every navigate
  // ends outcome_unknown, which paged before the reason was carried through.
  scenario(
    "a website that does not answer does not page",
    [
      operations("outcome_unknown", "destination_not_answered", 2),
      operations("completed", "none", 1),
    ],
    false,
  );
  for (const reason of [
    "destination_name_not_resolved",
    "destination_connection_failed",
    "destination_tls_failed",
    "destination_response_invalid",
  ]) {
    scenario(
      `a website failing with ${reason} does not page`,
      [operations("outcome_unknown", reason, 2), operations("completed", "none", 1)],
      false,
    );
  }
  scenario(
    "opening a tab on a website that does not answer does not page",
    [
      operations("failed", "destination_not_answered", 1, "open_target", "lifecycle"),
      operations("completed", "none", 1, "open_target", "lifecycle"),
    ],
    false,
    "open_target",
  );
  // The agent pointing at an element that matches nothing or several, or
  // asking for an action the page cannot take: the browser worked.
  for (const reason of ["locator_not_found", "locator_ambiguous", "invalid_action"]) {
    scenario(
      `the agent's own ${reason} mistakes do not page`,
      [operations("failed", reason, 2), operations("completed", "none", 1)],
      false,
    );
  }
  scenario(
    "agent addressing mistakes cannot dilute the browser's own failures",
    [
      operations("failed", "locator_ambiguous", 10),
      operations("outcome_unknown", "timeout", 3),
      operations("completed", "none", 5),
    ],
    0.375,
  );

  // The browser or its controller failing still pages.
  for (const [outcome, reason] of [
    ["outcome_unknown", "controller_lost"],
    ["outcome_unknown", "timeout"],
    ["outcome_unknown", "tab_not_responding"],
    ["outcome_unknown", "outcome_unknown"],
    ["failed", "driver_failed"],
    ["failed", "resource_unavailable"],
    ["denied", "permission_denied"],
    // Recorded by an API that predates failure reasons.
    ["outcome_unknown", "none"],
  ] as const) {
    scenario(
      `the browser's own ${outcome} ${reason} failures page`,
      [operations(outcome, reason, 2), operations("completed", "none", 2)],
      0.5,
    );
  }
  scenario(
    "a route refusal from the controller pages",
    [
      operations("failed", "unavailable", 1, "open_target", "lifecycle"),
      operations("completed", "none", 1, "open_target", "lifecycle"),
    ],
    0.5,
    "open_target",
  );
  // Websites failing at the same time neither hide nor dilute our failures:
  // they leave the ratio, so 3 of the 8 judgeable operations failed.
  scenario(
    "websites failing alongside cannot dilute the browser's own failures",
    [
      operations("outcome_unknown", "destination_not_answered", 10),
      operations("outcome_unknown", "timeout", 3),
      operations("completed", "none", 5),
    ],
    0.375,
  );
  scenario(
    "fewer than five own failures in the window stay quiet",
    [
      operations("outcome_unknown", "destination_not_answered", 5),
      operations("failed", "driver_failed", 0.25),
    ],
    false,
  );
  scenario("no observations do not fabricate an alert", [], false);

  const directory = mkdtempSync(join(tmpdir(), "interaction-failure-alert-"));
  try {
    writeFileSync(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({ groups: [{ name: "fixture", labels: scope, rules: [rule] }] }),
    );
    writeFileSync(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({ rule_files: ["rules.yaml"], evaluation_interval: "1m", tests: cases }),
    );
    const result = Bun.spawnSync([promtool, "test", "rules", "tests.yaml"], { cwd: directory });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
