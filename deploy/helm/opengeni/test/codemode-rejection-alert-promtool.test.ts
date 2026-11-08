import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

type Input = { series: string; values: string };
const scope = { namespace: "fixture", release: "fixture", environment: "production" };
const catalog = "/v1/workspaces/:workspaceId/codemode/catalog";

test("route refusal alert ignores ended attempts but preserves genuine auth failures", async () => {
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
    .find((item: any) => item.alert === "OpenGeniApiRouteRejectionsAbnormal");
  const series = (
    metric: string,
    status: number,
    values: string,
    route = catalog,
    reason?: string,
  ): Input => ({
    series: `${metric}{namespace="fixture",release="fixture",environment="production",component="api",method="GET",route="${route}",status="${status}"${reason === undefined ? "" : `,reason="${reason}",code="forbidden"`}}`,
    values,
  });
  const requests = (status: number, values: string, route = catalog) =>
    series("opengeni_http_requests_total", status, values, route);
  const rejections = (reason: string | undefined, values: string, status = 403, route = catalog) =>
    series("opengeni_http_request_rejections_total", status, values, route, reason);
  const cases: any[] = [];
  function scenario(name: string, inputs: Input[], fires: boolean, status = 403, route = catalog) {
    const labels = { method: "GET", route, status: String(status) };
    cases.push({
      name,
      interval: "1m",
      input_series: inputs,
      alert_rule_test: [
        {
          eval_time: "26h",
          alertname: rule.alert,
          exp_alerts: fires
            ? [
                {
                  exp_labels: { ...scope, ...rule.labels, ...labels },
                  exp_annotations: expandAlertAnnotations(rule.annotations, { value: 1, labels }),
                },
              ]
            : [],
        },
      ],
    });
  }
  // Thirty new refusals in thirty minutes, no preceding-day baseline, but
  // successful traffic keeps the ratio arm below 50%: exercise the spike arm.
  const spike = "0+0x1530 1+1x29";
  for (const route of [catalog, "/v1/workspaces/:workspaceId/codemode/calls/:operationId"]) {
    scenario(
      "stale-attempt spike remains a visible denial, not an alert: " + route,
      [
        requests(200, "0+100x1560", route),
        requests(403, spike, route),
        rejections("agent_attempt_caller_stale", spike, 403, route),
      ],
      false,
      403,
      route,
    );
    scenario(
      "stale attempts dominating traffic do not trigger the ratio arm: " + route,
      [
        requests(403, "0+2x1560", route),
        rejections("agent_attempt_caller_stale", "0+2x1560", 403, route),
      ],
      false,
      403,
      route,
    );
  }
  for (const reason of [
    "agent_attempt_malformed",
    "agent_attempt_revoked",
    "agent_attempt_forbidden",
    "permission:stream:view",
    "personal_machine_owner_required",
    "unclassified",
    undefined,
  ]) {
    scenario(
      `real ${reason ?? "unlabelled"} refusal still spikes on the same catalog route`,
      [requests(200, "0+100x1560"), requests(403, spike), rejections(reason, spike)],
      true,
    );
  }
  for (const status of [401, 409, 422]) {
    scenario(
      `HTTP ${status} spikes remain actionable`,
      [
        requests(200, "0+100x1560"),
        requests(status, spike),
        rejections("unclassified", spike, status),
      ],
      true,
      status,
    );
  }
  scenario(
    "a large stale baseline cannot hide a new genuine permission failure",
    [
      requests(403, "0+100x1560"),
      rejections("agent_attempt_caller_stale", "0+99x1560"),
      rejections("permission:stream:view", spike),
    ],
    true,
  );
  scenario(
    "genuine refusals above their own nonzero baseline still alert",
    [
      requests(200, "0+100x1560"),
      requests(403, "0+0.1x1530 154+1x29"),
      rejections("unclassified", "0+0.1x1530 154+1x29"),
    ],
    true,
  );
  scenario(
    "steady genuine refusals dominating a quiet route trigger only the ratio arm",
    [
      requests(200, "0+0.05x1560"),
      requests(403, "0+0.25x1560"),
      rejections("unclassified", "0+0.25x1560"),
    ],
    true,
  );
  scenario(
    "stable low-ratio genuine refusals do not fabricate a spike",
    [
      requests(200, "0+100x1560"),
      requests(403, "0+1x1560"),
      rejections("unclassified", "0+1x1560"),
    ],
    false,
  );
  // This is the intentional organization discovery exception, not a client
  // endpoint default (which the workspace-route source guard forbids).
  const organizationDiscovery = ["/v1", "mcp"].join("/");
  scenario(
    "organization MCP discovery remains excluded",
    [
      requests(401, spike, organizationDiscovery),
      rejections("unclassified", spike, 401, organizationDiscovery),
    ],
    false,
    401,
    organizationDiscovery,
  );
  scenario("no observations do not fabricate an alert", [], false);
  const directory = mkdtempSync(join(tmpdir(), "codemode-rejection-alert-"));
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
