import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const dashboardsDir = "deploy/observability/dashboards";
const rulePath = "deploy/helm/opengeni/templates/prometheusrule.yaml";

type Dashboard = {
  uid: string;
  panels: Array<{ id: number; targets?: Array<{ expr?: string }> }>;
};

async function dashboard(name: string): Promise<Dashboard> {
  return JSON.parse(await Bun.file(`${dashboardsDir}/${name}`).text()) as Dashboard;
}

describe("sandbox observability contract", () => {
  test("all dashboards parse with unique UIDs and panel IDs", async () => {
    const files = (await readdir(dashboardsDir)).filter((name) => name.endsWith(".json"));
    const parsed = await Promise.all(files.map(dashboard));
    expect(new Set(parsed.map(({ uid }) => uid)).size).toBe(parsed.length);
    for (const value of parsed) {
      const ids = value.panels.map(({ id }) => id);
      expect(new Set(ids).size, `${value.uid} has duplicate panel IDs`).toBe(ids.length);
    }
  });

  test("the canonical sandbox board covers every operational lifecycle plane", async () => {
    const value = await dashboard("sandbox-health.json");
    expect(value.uid).toBe("opengeni-sandbox-health");
    const expressions = value.panels
      .flatMap(({ targets = [] }) => targets.map(({ expr = "" }) => expr))
      .join("\n");
    for (const required of [
      "opengeni:sandbox_leases:fresh_max",
      "opengeni_sandbox_inventory_refresh_timestamp_seconds",
      "opengeni_sandbox_inventory_refresh_failures_total",
      "opengeni_sandbox_creates_total",
      "opengeni_sandbox_create_duration_seconds_bucket",
      "opengeni_sandbox_operations_total",
      "opengeni_sandbox_operation_duration_seconds_bucket",
      "opengeni_sandbox_warming_timeouts_total",
      "opengeni_sandbox_orphans_terminated_total",
      "opengeni:sandbox_checkpoint_artifacts:fresh_max",
      "opengeni_sandbox_checkpoint_artifact_operations_total",
      "opengeni:sandbox_rotation_backlog:fresh_max",
      "opengeni:sandbox_leases_expired_draining:fresh_max",
      "opengeni:retained_processes_active:fresh_max",
      "opengeni:retained_processes_terminal_owner_backlog:fresh_max",
      "opengeni_retained_process_reconciliation_total",
    ]) {
      expect(expressions, `missing sandbox dashboard signal ${required}`).toContain(required);
    }
    expect(expressions).not.toMatch(/\bsum\s*(?:by\s*\([^)]*\))?\s*\(\s*opengeni_sandbox_leases\b/);
    expect(expressions).not.toMatch(/session_id|workspace_id|sandbox_id|provider_instance_id/);
  });

  test("worker fleet consumes the fresh lease recording rule", async () => {
    const value = await dashboard("worker-fleet.json");
    const expressions = value.panels
      .flatMap(({ targets = [] }) => targets.map(({ expr = "" }) => expr))
      .join("\n");
    expect(expressions).toContain("opengeni:sandbox_leases:fresh_max");
    expect(expressions).not.toMatch(/\bsum\s*(?:by\s*\([^)]*\))?\s*\(\s*opengeni_sandbox_leases\b/);
  });

  test("recording rules bind every inventory family to its exact refresh domain", async () => {
    const source = await Bun.file(rulePath).text();
    const mappings = [
      ["opengeni:sandbox_leases:fresh_max", "opengeni_sandbox_leases", "leases"],
      [
        "opengeni:sandbox_checkpoint_artifacts:fresh_max",
        "opengeni_sandbox_checkpoint_artifacts",
        "checkpoint_artifacts",
      ],
      [
        "opengeni:sandbox_rotation_backlog:fresh_max",
        "opengeni_sandbox_rotation_backlog",
        "rotation_backlog",
      ],
      [
        "opengeni:retained_processes_active:fresh_max",
        "opengeni_retained_processes_active",
        "retained_processes",
      ],
      [
        "opengeni:retained_processes_terminal_owner_backlog:fresh_max",
        "opengeni_retained_processes_terminal_owner_backlog",
        "retained_processes",
      ],
      [
        "opengeni:sandbox_leases_expired_draining:fresh_max",
        "opengeni_sandbox_leases_expired_draining",
        "expired_drains",
      ],
    ] as const;
    for (const [record, family, domain] of mappings) {
      const start = source.indexOf(`- record: ${record}`);
      expect(start, `missing recording rule ${record}`).toBeGreaterThanOrEqual(0);
      const remainder = source.slice(start + 1);
      const next = remainder.search(/\n\s+- (?:record|alert): /);
      const block = source.slice(start, next < 0 ? undefined : start + 1 + next);
      expect(block).toContain(family);
      expect(block).toContain(`domain="${domain}"`);
      expect(block).toContain("and on (job, instance)");
    }
  });

  test("alerts match emitted drain buckets and fail closed on every absent domain", async () => {
    const source = await Bun.file(rulePath).text();
    expect(source).toContain('age_bucket=~"5m_1h|1h_1d|gte_1d"');
    expect(source).toContain("OpenGeniSandboxOperationFailureRatio");
    expect(source).toContain("must cover at least three sandbox reaper periods");
    expect(source).toContain("$inventoryFreshnessSeconds");
    expect(source).not.toMatch(/5m_to_15m|gt_15m/);
    for (const domain of [
      "leases",
      "checkpoint_artifacts",
      "rotation_backlog",
      "retained_processes",
      "expired_drains",
    ]) {
      expect(source).toContain(
        `absent(opengeni_sandbox_inventory_refresh_timestamp_seconds{domain="${domain}"})`,
      );
    }
  });

  test("custom chart rules append after the canonical safety catalog", async () => {
    const source = await Bun.file(rulePath).text();
    const canonical = source.indexOf("- alert: OpenGeniSandboxCreateFailureRatio");
    const custom = source.indexOf("with ((.Values.observability).prometheusRule).rules");
    expect(canonical).toBeGreaterThanOrEqual(0);
    expect(custom).toBeGreaterThan(canonical);
    expect(source).not.toContain("{{- else }}");
  });
});
