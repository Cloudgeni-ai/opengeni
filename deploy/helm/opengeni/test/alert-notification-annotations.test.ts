import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expandAlertTemplate } from "./prometheus-alert-template";

// Alertmanager's Slack/email templates (owned by the ops repository) title a
// notification from `headline` + `value` and render `user_impact` and
// `next_step` as the body. This pins that contract for every canonical alert,
// including the backend-gated OpenSandbox and Modal catalogs.

type Rule = {
  alert?: string;
  expr: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

const REQUIRED = ["summary", "headline", "user_impact", "next_step"] as const;
const ALLOWED = new Set([...REQUIRED, "value", "description", "action", "runbook_url"]);

function renderAlerts(backend: string): Rule[] {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for chart render tests");
  const rendered = execFileSync(
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
      "--set-string",
      `config.OPENGENI_SANDBOX_BACKEND=${backend}`,
      "--show-only",
      "templates/prometheusrule.yaml",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const manifest = Bun.YAML.parse(rendered) as { spec: { groups: { rules: Rule[] }[] } };
  return manifest.spec.groups.flatMap((group) => group.rules).filter((rule) => rule.alert);
}

async function canonicalAlerts(): Promise<Map<string, Rule>> {
  const alerts = new Map<string, Rule>();
  for (const backend of ["opensandbox", "modal"]) {
    for (const rule of renderAlerts(backend)) alerts.set(rule.alert!, rule);
  }
  const source = await readFile(
    new URL("../templates/prometheusrule.yaml", import.meta.url),
    "utf8",
  );
  expect(alerts.size).toBe([...source.matchAll(/^ {8}- alert: /gm)].length);
  return alerts;
}

describe("alert notification annotations", () => {
  test("every canonical alert carries plain-language notification copy", async () => {
    for (const [name, rule] of await canonicalAlerts()) {
      const annotations = rule.annotations ?? {};
      for (const key of REQUIRED) {
        expect(annotations[key]?.trim(), `${name} missing ${key}`).toBeTruthy();
      }
      for (const key of Object.keys(annotations)) {
        expect(ALLOWED.has(key), `${name} has unexpected annotation ${key}`).toBe(true);
      }
      const sample = { value: 0.5, labels: { provider: "provider-x" } };
      const headline = expandAlertTemplate(annotations.headline!, sample);
      expect(headline.length, `${name} headline too long`).toBeLessThanOrEqual(70);
      expect(headline, `${name} headline repeats the rule name`).not.toContain(name);
      expect(headline).not.toMatch(/^Open[Gg]eni\b/);
      if (annotations.value !== undefined) {
        expect(annotations.value, `${name} value must render $value`).toContain("$value");
        expect(expandAlertTemplate(annotations.value, sample).length).toBeLessThanOrEqual(50);
      }
      for (const [key, text] of Object.entries(annotations)) {
        // The brand is "Opengeni" in prose; rule and metric identifiers keep
        // their historical spelling.
        expect(text, `${name}.${key} misspells the brand`).not.toMatch(/\bOpenGeni\b/);
        // Only the closed, test-covered set of Prometheus template actions.
        expect(() => expandAlertTemplate(text, sample), `${name}.${key}`).not.toThrow();
      }
    }
  });

  test("$value is only rendered where the alert's output sample is a measurement", async () => {
    for (const [name, rule] of await canonicalAlerts()) {
      const expression = rule.expr.replace(/\s+/g, " ");
      const booleanOutput =
        /^absent\(/.test(expression.trim()) || /\bup\{[^}]*\} == 0$/.test(expression.trim());
      if (booleanOutput) {
        expect(rule.annotations?.value, `${name} renders a meaningless $value`).toBeUndefined();
      }
    }
  });

  test("the tool-latency alert names the slow tool", async () => {
    const rule = (await canonicalAlerts()).get("OpenGeniMcpToolLatencyHigh")!;
    const annotations = rule.annotations!;
    const firstParty = { value: 21, labels: { tool: "session_create" } };
    expect(expandAlertTemplate(annotations.headline!, firstParty)).toBe(
      "Slow tool calls: session_create",
    );
    expect(expandAlertTemplate(annotations.summary!, firstParty)).toStartWith(
      "Calls to the session_create tool exceed their p95 latency budget:",
    );
    const external = { value: 21, labels: { tool: "external" } };
    expect(expandAlertTemplate(annotations.headline!, external)).toBe("Slow tool calls: external");
    expect(expandAlertTemplate(annotations.value!, external)).toBe("p95 21s");
  });

  test("critical alerts link a runbook", async () => {
    for (const [name, rule] of await canonicalAlerts()) {
      if (rule.labels?.severity !== "critical") continue;
      expect(rule.annotations?.runbook_url, `${name} missing runbook_url`).toMatch(
        /^https:\/\/github\.com\/Cloudgeni-ai\/opengeni\/blob\/main\/docs\/[a-z0-9-]+\.md(#[a-z0-9-]+)?$/,
      );
    }
  });

  test("runbook links resolve to existing docs and headings", async () => {
    for (const [name, rule] of await canonicalAlerts()) {
      const url = rule.annotations?.runbook_url;
      if (!url) continue;
      const match = /\/blob\/main\/(docs\/[^#]+)(?:#(.+))?$/.exec(url);
      expect(match, `${name} runbook_url is not a repository doc`).not.toBeNull();
      const doc = await readFile(resolve(import.meta.dir, "../../../..", match![1]!), "utf8");
      if (match![2]) {
        const anchors = [...doc.matchAll(/^#+ (.+)$/gm)].map((heading) =>
          heading[1]!
            .toLowerCase()
            .replace(/[^a-z0-9 _-]/g, "")
            .replaceAll(" ", "-"),
        );
        expect(anchors, `${name} runbook anchor #${match![2]} not found`).toContain(match![2]);
      }
    }
  });
});
